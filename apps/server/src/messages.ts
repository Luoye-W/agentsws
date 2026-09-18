/**
 * WP113（63）：**消息**在服务进程里的真装配。
 *
 * 这一层把四样东西接到一起，自己不写业务：
 *
 * | 来自 | 什么 |
 * |---|---|
 * | `@agentsws/channels` 的 `messages/*` | 消息库、全量同步、分拣的规则层、净化、回复建议的骨架 |
 * | `./connections.ts` | 现在连着哪几只邮箱 + 口令来源（**不新增任何凭据入口**，63 §2） |
 * | `./channels.ts` | 受控原始材料区、outbox 七态 + 对账、真 SMTP |
 * | 模型网关 | 分拣第 ④ 层与回复建议那两处**唯一**的模型调用（63 §10） |
 *
 * 三条纪律在这个文件里落地：
 *
 * 1. **岗位没开就不挪信**。`support_enabled` / `kol_enabled` 每次现查
 *    （看这个品牌里有没有人持着客服 / 红人那几条职责），不缓存——岗位是会变的，
 *    缓存了就会出现"昨天开了今天关了，信还在往 kefuagents 里挪"。
 * 2. **日志不打正文与完整邮箱地址**（63 §10）。这个文件里每一条 `appendEvent`
 *    的 payload 都只有计数与遮掩过的地址（`a***@b.com`）。
 * 3. **回复建议按需生成**：只有 `GET /v1/messages/:id/assistant` 会触发，
 *    而且缓存 30 分钟。全量预生成是最贵的错法。
 */

import { join } from 'node:path'
import type {
  MailAssistantView,
  MessageAccountView,
  MessageActor,
  MessagesPort,
  MessageThreadView,
} from '@agentsws/api'
import type {
  CredentialSource,
  MailboxAccount,
  MailboxStateStore,
  MailboxWriter,
  MailSource,
  MessageStore,
  RawStore,
  SuggestModel,
  SuggestRequest,
  TriageContext,
  TriageModel,
} from '@agentsws/channels'
import {
  folderKindOf,
  folderPathFor,
  ImapMailboxWriter,
  ImapMailSource,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  ReplySuggester,
  restoreRemoteImages,
  SqliteMailboxStateStore,
  SqliteMessageStore,
  triageMessage,
  userVerdict,
} from '@agentsws/channels'
import type {
  Clock,
  EventEnvelope,
  Halt,
  Iso8601,
  MessageBackfillInput,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageFolderKind,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageRecord,
  MessageRoute,
  MessageSendInput,
  MessageSendResult,
  MessageSyncReport,
  MessageThreadSummary,
  ModelGateway,
  PersonId,
  ReplySuggestion,
  ReplySuggestionKind,
  RoleId,
  SenderRule,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { Work } from '@agentsws/work'
import type { DirectMailInput, DirectMailResult } from './channels.js'
import type { MailAccount } from './connections.js'

/** 客服岗位的那几条职责（开了其中任何一条就算"启用了客服岗位"）。 */
const SUPPORT_ROLE_PREFIXES = ['dtc.support', 'dtc.aftersales', 'dtc.live-chat', 'support.']
/** 红人营销那几条。 */
const KOL_ROLE_PREFIXES = ['kol.']

export interface MessagesOptions {
  clock: Clock
  workspace_id: WorkspaceId
  /** 给了就落盘（消息库在 `messages.sqlite`，**自己一张库**）；不给全内存（测试）。 */
  dbDir?: string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  halt: Halt
  /** 现在连着哪几只邮箱（`connections.mailAccounts()`）。**不新增凭据入口**。 */
  accounts(): MailAccount[]
  /** 口令来源（`connections.credentialSource()`）；本文件不碰值。 */
  credentials: CredentialSource
  /** 37 工作模型：转待办与"客服 Agent 在处理"要它。 */
  work?: Work
  /** 本人在这个品牌里现在持有的岗位（转待办挂谁名下）。 */
  position?(): { person_id: PersonId; assignment_id: string; role_id: RoleId } | undefined
  /** 这个品牌里现在有人持着哪几条职责（判断客服 / 红人岗位开没开）。 */
  activeRoles?(): readonly RoleId[]
  /** 模型网关；不给 = 分拣只跑规则、回复建议一条都不出（界面照实说）。 */
  models?: ModelGateway
  /** 人自己按下发送的那一封（`channels.sendMail`）。 */
  sendMail?(input: DirectMailInput): Promise<DirectMailResult>
  /** 受控原始材料区（与渠道**共用同一个**：21 §4「删这个人」不许漏掉一半）。 */
  rawStore?: RawStore
  /** 测试注入：按「邮箱 × 文件夹」开收信端。缺省真 IMAP。 */
  makeSource?(account: MailAccount, folder: string): MailSource
  /** 测试注入：回写端。缺省真 IMAP。 */
  makeWriter?(account: MailAccount): MailboxWriter
  /** 这只邮箱上有哪些文件夹；缺省按 {@link DEFAULT_FOLDERS} 的真名试。 */
  listFolders?(account: MailAccount): Promise<string[]>
  /** 知识库检索（回复建议引用出处时用）。不给 = 建议里没有出处。 */
  searchKnowledge?(
    text: string,
    limit: number,
  ): Promise<{ source_id: string; title: string; text: string }[]>
  /** 语气与签名（个人层技能 / 记忆，54 的六层）。 */
  voice?(): string | undefined
}

/**
 * 缺省要扫的文件夹真名。
 *
 * 真机器上先问服务器要一份清单（`listFolders`），问不到才用这一份试——
 * 各家名字不一样，硬编码一份名单只会在 Gmail 上跑得好、在 Outlook 上少扫两个。
 */
export const DEFAULT_FOLDERS: readonly string[] = [
  'INBOX',
  'Sent',
  'Drafts',
  'Trash',
  'Junk',
  'kefuagents',
  'kolagents',
]

export interface MessagesAssembly {
  store: MessageStore
  sync: MailboxSync
  port: MessagesPort
  /** 调度器消费者：拉一轮所有邮箱的所有文件夹。 */
  poll(): Promise<MessageSyncReport>
  close(): void
}

export function createMessages(options: MessagesOptions): MessagesAssembly {
  const { clock, workspace_id } = options
  const store: MessageStore =
    options.dbDir === undefined
      ? new MemoryMessageStore()
      : new SqliteMessageStore({ dbPath: join(options.dbDir, 'messages.sqlite'), clock })

  /** 每只邮箱的文件夹清单（问一次记一次；断开重连时 `refresh` 会清掉）。 */
  const folderCache = new Map<string, string[]>()
  const writers = new Map<string, MailboxWriter>()

  const writerFor = (account: MailAccount): MailboxWriter | undefined => {
    const made = writers.get(account.connection_id)
    if (made !== undefined) return made
    const writer =
      options.makeWriter?.(account) ??
      new ImapMailboxWriter({
        config: {
          host: account.imap.host,
          port: account.imap.port,
          secure: account.imap.secure,
          user: account.imap.user,
          connection_id: account.connection_id,
        },
        credentials: options.credentials,
        onError: (e) => logQuiet('imap_writeback_failed', account.address, e),
      })
    writers.set(account.connection_id, writer)
    return writer
  }

  const logQuiet = (reason: string, address: string, e?: unknown): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'inbound.dead_letter',
      actor: { kind: 'system', id: 'messages' },
      correlation: { trace_id: `tr_msg_${clock.now()}` },
      // 63 §10：不打正文，也不打完整地址
      payload: {
        reason,
        account: maskAddress(address),
        ...(e === undefined ? {} : { detail: String(e).slice(0, 200) }),
      },
    })
  }

  const foldersOf = (account: MailAccount): string[] => {
    const cached = folderCache.get(account.connection_id)
    if (cached !== undefined) return cached
    folderCache.set(account.connection_id, [...DEFAULT_FOLDERS])
    return [...DEFAULT_FOLDERS]
  }

  const mailboxAccounts = (): MailboxAccount[] =>
    options.accounts().map((account) => {
      const writer = writerFor(account)
      return {
        address: account.address,
        folders: foldersOf(account),
        open: (folder) =>
          options.makeSource?.(account, folder) ??
          new ImapMailSource({
            config: {
              host: account.imap.host,
              port: account.imap.port,
              secure: account.imap.secure,
              user: account.imap.user,
              connection_id: account.connection_id,
              mailbox: folder,
            },
            credentials: options.credentials,
          }),
        ...(writer === undefined ? {} : { writer }),
      }
    })

  /* ── 岗位开没开（每次现查，不缓存） ─────────────────────────────────── */

  const roles = (): readonly RoleId[] => options.activeRoles?.() ?? []
  const supportEnabled = (): boolean =>
    roles().some((r) => SUPPORT_ROLE_PREFIXES.some((p) => r === p || r.startsWith(p)))
  const kolEnabled = (): boolean =>
    roles().some((r) => KOL_ROLE_PREFIXES.some((p) => r.startsWith(p)))

  /* ── 分拣 ───────────────────────────────────────────────────────────── */

  const triageModel: TriageModel | undefined =
    options.models === undefined
      ? undefined
      : {
          classify: async (input) => classifyWithGateway(input, options, workspace_id),
        }

  /** 客服 / 红人已有线程：看工作模型里有没有钉了这条线程的事项。 */
  const knownThread = (thread_id: string, refs: readonly string[]): boolean => {
    const work = options.work
    if (work === undefined) return false
    const ids = new Set([thread_id, ...refs])
    return work
      .listMatters({ kind: 'conversation' })
      .some((m) => m.context.pinned.some((p) => p.type === 'thread' && ids.has(p.id)))
  }

  const triageCtx = (): TriageContext => ({
    support_enabled: supportEnabled(),
    kol_enabled: kolEnabled(),
    isSupportThread: (id, refs) => supportEnabled() && knownThread(id, refs),
    isKolThread: (id, refs) => kolEnabled() && knownThread(id, refs),
    senderRules: rulesCache,
    model_halted: options.halt.isHalted('model') || options.halt.isHalted('all'),
    at: clock.now(),
  })

  /** 发件人规则在同步那一轮里要被读很多次，开轮时刷一次就够。 */
  let rulesCache: SenderRule[] = []

  const sync = new MailboxSync({
    clock,
    workspace_id,
    store,
    state: mailboxState(options),
    accounts: mailboxAccounts,
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
    triage: async (record) =>
      triageMessage(
        {
          from_email: record.from.email,
          ...(record.from.name === undefined ? {} : { from_name: record.from.name }),
          subject: record.subject,
          text: record.text,
          thread_id: record.thread_id,
          ...(record.in_reply_to === undefined ? {} : { in_reply_to: record.in_reply_to }),
          references: record.references,
          headers: record.headers,
          has_attachments: record.attachments.length > 0,
        },
        triageCtx(),
        triageModel,
      ),
    /**
     * 交给客服 / 红人现有流程。
     *
     * "现有流程"就是 37 的事项：渠道那一侧（`channels.ts`）本来就会把 INBOX 的
     * 客户来信落成 `conversation` 事项并起 Run。这里要做的只是**确认那条路走得通**
     * （有岗位、有工作模型），走不通就回 `false`——于是信不挪、留在收件箱里可见。
     */
    handoff: async (record, triage) => {
      const work = options.work
      const position = options.position?.()
      if (work === undefined || position === undefined) return false
      if (triage.route === 'support' && !supportEnabled()) return false
      if (triage.route === 'kol' && !kolEnabled()) return false
      const ref = { type: 'thread' as const, id: record.thread_id }
      const existing = work
        .listMatters({ kind: 'conversation' })
        .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
      const matter =
        existing ??
        work.createMatter({
          kind: 'conversation',
          title: `与 ${record.from.name ?? record.from.email} 的往来`,
          pinned: [ref],
          position_id: position.assignment_id,
        })
      await store.update(record.id, { linked: { type: 'matter', id: matter.id } })
      return true
    },
    on_error: (e) => logQuiet('message_sync_failed', '', e),
    on_folder_fault: (fault) => {
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'inbound.folder_fault',
        actor: { kind: 'system', id: 'messages' },
        correlation: { trace_id: `tr_msgfault_${clock.now()}` },
        payload: {
          account: maskAddress(fault.account),
          folder: fault.folder,
          failed_uid: fault.failed_uid,
          fail_count: fault.fail_count,
          quarantined: fault.quarantined,
        },
      })
    },
  })

  const suggester = new ReplySuggester({
    now: () => Date.parse(clock.now()),
    ...(options.models === undefined
      ? {}
      : { model: suggestModel(options, workspace_id) satisfies SuggestModel }),
  })

  /* ── 端口实现 ───────────────────────────────────────────────────────── */

  const accountOf = (address: string): MailAccount | undefined =>
    options.accounts().find((a) => a.address === address)

  /** 旗标回写：本机先改，IMAP 尽力（写不动只 log）。 */
  const writeFlags = async (record: MessageRecord, input: MessageFlagsInput): Promise<void> => {
    const account = accountOf(record.account)
    const uid = record.uid
    if (account === undefined || uid === undefined) return
    const writer = writerFor(account)
    if (writer === undefined) return
    const add: string[] = []
    const remove: string[] = []
    const flag = (on: boolean | undefined, name: string): void => {
      if (on === true) add.push(name)
      if (on === false) remove.push(name)
    }
    flag(input.read, '\\Seen')
    flag(input.starred, '\\Flagged')
    flag(input.answered, '\\Answered')
    if (add.length === 0 && remove.length === 0) return
    await writer.setFlags(record.folder, uid, add, remove)
  }

  const requireMessage = async (id: string): Promise<MessageRecord> => {
    const row = await store.get(id)
    if (row === undefined) throw new Error(`没有这封信：${id}`)
    return row
  }

  const port: MessagesPort = {
    async accounts(): Promise<{ accounts: MessageAccountView[] }> {
      const known = options.accounts().map((a) => a.address)
      const seen = await store.accounts()
      const all = [...new Set([...known, ...seen])]
      const out: MessageAccountView[] = []
      for (const address of all) {
        const folders = await store.folders(address)
        out.push({
          address,
          unread: folders.reduce((n, f) => n + (f.kind === 'inbox' ? f.unread : 0), 0),
          folders,
          backfill_floor: sync.backfillFloor(address),
        })
      }
      return { accounts: out }
    },

    async threads(
      _actor: MessageActor,
      query: MessageListQuery,
    ): Promise<{ threads: MessageThreadSummary[] }> {
      return { threads: await store.threads(query) }
    },

    async thread(_actor: MessageActor, thread_id: string): Promise<MessageThreadView> {
      const messages = await store.thread(thread_id)
      const last = messages[messages.length - 1]
      const agentRoute = messages.find((m) => m.route !== 'inbox')?.route
      const linked = messages.find((m) => m.linked !== undefined)?.linked
      return {
        thread_id,
        subject: last?.subject ?? '',
        messages,
        ...(agentRoute === undefined || agentRoute === 'inbox'
          ? {}
          : {
              agent_status: {
                route: agentRoute,
                state: agentState(options, linked?.id),
                ...(linked === undefined
                  ? {}
                  : { href: `/matters/${linked.id}`, takeover_matter_id: linked.id }),
              },
            }),
      }
    },

    async message(_actor: MessageActor, id: string): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      // 「总是信任这个发件人」名单里的：正文里的远程图片直接搬回 src
      const trusted = await store.trustedSenders()
      if (row.has_remote_images && row.html !== undefined && trusted.includes(row.from.email)) {
        return {
          message: { ...row, html: restoreRemoteImages(row.html), has_remote_images: false },
        }
      }
      return { message: row }
    },

    async setFlags(
      _actor: MessageActor,
      id: string,
      input: MessageFlagsInput,
    ): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      const flags = {
        ...row.flags,
        ...(input.read === undefined ? {} : { read: input.read }),
        ...(input.starred === undefined ? {} : { starred: input.starred }),
        ...(input.answered === undefined ? {} : { answered: input.answered }),
      }
      const next = await store.update(id, { flags })
      // 回写 IMAP：用户回到自己的邮箱软件看到的必须是同一个状态（63 §7）
      await writeFlags(row, input)
      return { message: next ?? row }
    },

    async move(
      actor: MessageActor,
      id: string,
      input: MessageMoveInput,
    ): Promise<{ message: MessageRecord; rule?: SenderRule }> {
      const row = await requireMessage(id)
      const account = accountOf(row.account)
      const known = account === undefined ? [] : foldersOf(account)
      const to = folderPathFor(input.to, known)
      const route: MessageRoute =
        input.to === 'support' ? 'support' : input.to === 'kol' ? 'kol' : 'inbox'
      const next =
        (await store.update(id, {
          folder: to,
          folder_kind: folderKindOf(to),
          route,
          triage: userVerdict(route, clock.now(), row.labels),
        })) ?? row
      suggester.invalidate(id)
      if (account !== undefined && row.uid !== undefined) {
        await writerFor(account)?.move(row.folder, row.uid, to)
      }
      if (input.remember_sender !== true) return { message: next }
      // 「以后这个发件人都这样？」——教一次，下一封直达，不再花模型（63 §4 ②）
      const rule: SenderRule = {
        id: `rule_${sha256(`${workspace_id}|${row.from.email}`).slice(0, 16)}`,
        sender: row.from.email,
        route,
        labels: [...row.labels],
        by: actor.person_id,
        created_at: clock.now(),
      }
      await store.putSenderRule(rule)
      rulesCache = await store.senderRules()
      return { message: next, rule }
    },

    async setLabels(
      _actor: MessageActor,
      id: string,
      labels: string[],
    ): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      const next = (await store.update(id, { labels })) ?? row
      // 服务器支持 keyword 才顺手同步；不支持就只在本地——**不为了标签去挪信**（63 §5）
      const account = accountOf(row.account)
      if (account !== undefined && row.uid !== undefined) {
        const writer = writerFor(account)
        const supported = (await writer?.keywordsSupported?.(row.folder)) ?? false
        if (supported && writer !== undefined) {
          const add = labels.filter((l) => !row.labels.includes(l)).map(keywordOf)
          const remove = row.labels.filter((l) => !labels.includes(l)).map(keywordOf)
          await writer.setFlags(row.folder, row.uid, add, remove)
        }
      }
      return { message: next }
    },

    async showImages(
      _actor: MessageActor,
      id: string,
      always: boolean,
    ): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      if (always) await store.trustSender(row.from.email)
      if (row.html === undefined) return { message: row }
      return {
        message: { ...row, html: restoreRemoteImages(row.html), has_remote_images: false },
      }
    },

    async labels(): Promise<{ labels: MessageLabel[] }> {
      return { labels: await store.labels() }
    },

    async putLabel(_actor: MessageActor, label: MessageLabel): Promise<{ label: MessageLabel }> {
      const existing = (await store.labels()).find((l) => l.id === label.id)
      // 内置的只能改名改色：`builtin` 由库说了算，不由入参说了算
      const next: MessageLabel = { ...label, builtin: existing?.builtin ?? false }
      await store.putLabel(next)
      return { label: next }
    },

    async deleteLabel(_actor: MessageActor, id: string): Promise<{ deleted: boolean }> {
      return { deleted: await store.deleteLabel(id) }
    },

    async mergeLabels(
      _actor: MessageActor,
      from: string,
      into: string,
    ): Promise<{ moved: number; labels: MessageLabel[] }> {
      let moved = 0
      for (const m of await store.list({ label: from, limit: 100_000 })) {
        const labels = [...new Set([...m.labels.filter((l) => l !== from), into])]
        await store.update(m.id, { labels })
        moved += 1
      }
      await store.deleteLabel(from)
      return { moved, labels: await store.labels() }
    },

    async senderRules(): Promise<{ rules: SenderRule[] }> {
      return { rules: await store.senderRules() }
    },

    async deleteSenderRule(_actor: MessageActor, id: string): Promise<{ deleted: boolean }> {
      const deleted = await store.deleteSenderRule(id)
      rulesCache = await store.senderRules()
      return { deleted }
    },

    async drafts(): Promise<{ drafts: MessageDraft[] }> {
      return { drafts: await store.drafts() }
    },

    async saveDraft(
      _actor: MessageActor,
      input: MessageDraftInput,
    ): Promise<{ draft: MessageDraft }> {
      const id = input.id ?? `dft_${sha256(`${workspace_id}|${clock.now()}`).slice(0, 16)}`
      const prior = await store.getDraft(id)
      const draft: MessageDraft = {
        id,
        workspace_id,
        account: input.account ?? prior?.account ?? options.accounts()[0]?.address ?? '',
        ...((input.thread_id ?? prior?.thread_id) === undefined
          ? {}
          : { thread_id: (input.thread_id ?? prior?.thread_id) as string }),
        ...((input.in_reply_to ?? prior?.in_reply_to) === undefined
          ? {}
          : { in_reply_to: (input.in_reply_to ?? prior?.in_reply_to) as string }),
        to: input.to ?? prior?.to ?? [],
        cc: input.cc ?? prior?.cc ?? [],
        bcc: input.bcc ?? prior?.bcc ?? [],
        subject: input.subject ?? prior?.subject ?? '',
        text: input.text ?? prior?.text ?? '',
        attachments: prior?.attachments ?? [],
        updated_at: clock.now(),
      }
      await store.putDraft(draft)
      return { draft }
    },

    async discardDraft(_actor: MessageActor, id: string): Promise<{ deleted: boolean }> {
      return { deleted: await store.deleteDraft(id) }
    },

    async send(_actor: MessageActor, input: MessageSendInput): Promise<MessageSendResult> {
      const draft = input.draft_id === undefined ? undefined : await store.getDraft(input.draft_id)
      const to = (input.to ?? draft?.to ?? []).map((a) => a.email)
      const cc = (input.cc ?? draft?.cc ?? []).map((a) => a.email)
      const bcc = (input.bcc ?? draft?.bcc ?? []).map((a) => a.email)
      const subject = input.subject ?? draft?.subject ?? ''
      const text = input.text ?? draft?.text ?? ''
      const thread_id = input.thread_id ?? draft?.thread_id
      const in_reply_to = input.in_reply_to ?? draft?.in_reply_to
      const account = input.account ?? draft?.account ?? options.accounts()[0]?.address
      // 幂等键按"草稿 + 内容"算：网络抖了一下人又按了一次，只会发出一封
      const idempotency_key = `msg_send_${sha256(
        JSON.stringify({ to, cc, bcc, subject, text, thread_id }),
      ).slice(0, 24)}`
      const references =
        thread_id === undefined
          ? []
          : (await store.thread(thread_id)).flatMap((m) =>
              m.message_id === undefined ? [] : [m.message_id],
            )
      const send = options.sendMail
      if (send === undefined) throw new Error('这个服务进程没接出站（channels.sendMail）')
      const result = await send({
        ...(account === undefined ? {} : { account }),
        to,
        cc,
        bcc,
        subject,
        text,
        ...(in_reply_to === undefined ? {} : { in_reply_to }),
        references,
        ...(thread_id === undefined ? {} : { thread_ref: thread_id }),
        idempotency_key,
      })
      if (!result.ok) throw new Error(result.error ?? '发送失败')
      if (input.draft_id !== undefined) await store.deleteDraft(input.draft_id)
      // 回信之后把被回的那封标成"已回"（也回写 IMAP）
      if (thread_id !== undefined) {
        for (const m of await store.thread(thread_id)) {
          if (m.message_id !== in_reply_to) continue
          await store.update(m.id, { flags: { ...m.flags, answered: true, read: true } })
          await writeFlags(m, { answered: true, read: true })
        }
      }
      return { outbox_id: result.outbox_id, message_id: result.message_id }
    },

    async assistant(_actor: MessageActor, id: string): Promise<MailAssistantView> {
      const row = await requireMessage(id)
      const history = await store.list({ q: row.from.email, limit: 200 })
      const needsReply = row.triage?.needs_reply === true
      const knowledge =
        needsReply && options.searchKnowledge !== undefined
          ? await options.searchKnowledge(`${row.subject}\n${row.text.slice(0, 500)}`, 3)
          : []
      const context = (await store.thread(row.thread_id))
        .filter((m) => m.id !== row.id)
        .slice(-3)
        .map((m) => `${m.from.email}: ${m.snippet}`)
      const voice = options.voice?.()
      const suggestions: ReplySuggestion[] = needsReply
        ? await suggester.suggest(row.id, {
            subject: row.subject,
            from: row.from.email,
            body: row.text.slice(0, 2000),
            context,
            ...(voice === undefined ? {} : { voice }),
            knowledge,
            kinds: ['short', 'detailed', 'decline'],
            lang: 'zh',
          })
        : []
      const todos =
        options.work === undefined
          ? []
          : options.work
              .listTodos({})
              .filter((t) => t.note?.includes(row.from.email) === true)
              .slice(0, 5)
              .map((t) => ({ id: t.id, title: t.title, status: t.status }))
      return {
        message_id: row.id,
        summary: row.triage?.summary ?? '',
        needs_reply: needsReply,
        suggestions,
        sender: {
          address: row.from.email,
          ...(row.from.name === undefined ? {} : { name: row.from.name }),
          history_count: history.length,
          linked:
            row.linked === undefined
              ? []
              : [{ type: row.linked.type, id: row.linked.id, label: row.linked.id }],
        },
        todos,
        model_available: options.models !== undefined,
      }
    },

    async toTodo(actor: MessageActor, id: string): Promise<{ todo: Todo }> {
      const work = options.work
      if (work === undefined) throw new Error('这个服务进程没装工作模型，转不了待办')
      const row = await requireMessage(id)
      const position = options.position?.()
      const todo = work.createTodo({
        title: row.subject.trim() === '' ? `回 ${row.from.email}` : row.subject,
        owner: actor.person_id,
        note: `来自消息：${row.from.email}\n${row.snippet}`,
        horizon: 'today',
        ...(position === undefined ? {} : { position_id: position.assignment_id }),
      })
      return { todo }
    },

    async sync(): Promise<MessageSyncReport> {
      rulesCache = await store.senderRules()
      return sync.sync()
    },

    async backfill(_actor: MessageActor, input: MessageBackfillInput): Promise<{ floor: string }> {
      const address = input.account ?? options.accounts()[0]?.address ?? ''
      return { floor: sync.backfill(address, input.days ?? 30) }
    },
  }

  return {
    store,
    sync,
    port,
    async poll(): Promise<MessageSyncReport> {
      rulesCache = await store.senderRules()
      folderCache.clear()
      return sync.sync()
    },
    close(): void {
      store.close?.()
    },
  }
}

/* ── 小零件 ───────────────────────────────────────────────────────────── */

/** 63 §10：日志里的地址一律遮掩（`ann@customer.example` → `a***@customer.example`）。 */
export function maskAddress(address: string): string {
  const at = address.indexOf('@')
  if (at <= 0) return address === '' ? '' : '***'
  return `${address[0] ?? ''}***${address.slice(at)}`
}

/** 标签同步成 IMAP keyword 时的名字（前缀避开别的软件自己的 keyword）。 */
export function keywordOf(label: string): string {
  return `agentsws_${label.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

/**
 * 「客服 Agent 在处理 / 等你拍板 / 已回复」（63 §9）。
 *
 * 判据取自工作模型：那条事项上还有没有等人定的卡。**不猜**——猜错的代价是
 * 人以为 Agent 在忙，其实那条线程停在等他点头。
 */
function agentState(
  options: MessagesOptions,
  matter_id: string | undefined,
): 'working' | 'waiting_for_you' | 'replied' {
  const work = options.work
  if (work === undefined || matter_id === undefined) return 'working'
  const matter = work.listMatters({}).find((m) => m.id === matter_id)
  if (matter === undefined) return 'working'
  if (matter.status === 'closed') return 'replied'
  if (matter.status === 'waiting') return 'waiting_for_you'
  return 'working'
}

/**
 * 每文件夹游标 / 毒消息隔离 / 租约。
 *
 * **自己一张库**（`messages-state.sqlite`），不与渠道那张 `channels.sqlite` 共用：
 * 两边扫的是同一只邮箱但推的是两条水位（那边只扫 INBOX 且只为落事项，这边扫六个
 * 文件夹且要落库）。共用一张表等于两条水位互相踩。租约 key 也已经错开成
 * `msg:<地址>`（见 `sync.ts` 的注释）。
 */
function mailboxState(options: MessagesOptions): MailboxStateStore {
  return options.dbDir === undefined
    ? new MemoryMailboxStateStore()
    : new SqliteMailboxStateStore({
        dbPath: join(options.dbDir, 'messages-state.sqlite'),
        clock: options.clock,
      })
}

/* ── 模型那两处（63 §10：全仓只有这两处把信件内容送出去） ─────────────── */

const TRIAGE_SYSTEM = [
  '你是一个邮件分拣助手。读一封邮件的头与正文前 2000 字，判断它归哪一类。',
  '只输出一个 JSON 对象，不要任何解释文字。字段：',
  'route（只能是给定 allowed_routes 里的一个）、labels（给定 allowed_labels 的子集）、',
  'needs_reply（布尔）、priority（high/normal/low）、summary（≤40 个字的中文一句话，',
  '说的是"这封信要你干什么"）、confidence（0–1）。',
  '拿不准就把 confidence 写低——写低不会有人骂你，猜高了信会被挪错地方。',
].join('\n')

async function classifyWithGateway(
  input: Parameters<TriageModel['classify']>[0],
  options: MessagesOptions,
  workspace_id: WorkspaceId,
): Promise<Awaited<ReturnType<TriageModel['classify']>>> {
  const models = options.models
  if (models === undefined) throw new Error('没有模型网关')
  const position = options.position?.()
  const completion = await models.complete({
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          from: input.from_email,
          from_name: input.from_name ?? '',
          subject: input.subject,
          // **不送附件**（63 §4 ④）
          body: input.body,
          allowed_routes: input.allowed_routes,
          allowed_labels: input.allowed_labels,
        }),
      },
    ],
    meta: {
      workspace_id,
      assignment_id: position?.assignment_id ?? 'asg_unknown',
      role_id: position?.role_id ?? 'common.member',
      run_id: 'run_message_triage',
      // 便宜档：分拣与抽取同一档预算，不占运行时那一档
      purpose: 'extraction',
    },
  })
  const parsed = parseJsonObject(completion.text)
  return {
    route: (parsed.route as MessageRoute) ?? 'inbox',
    labels: Array.isArray(parsed.labels) ? (parsed.labels as string[]) : [],
    needs_reply: parsed.needs_reply === true,
    priority:
      parsed.priority === 'high' || parsed.priority === 'low'
        ? (parsed.priority as 'high' | 'low')
        : 'normal',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  }
}

const SUGGEST_SYSTEM = [
  '你在帮一个人回一封邮件。给出若干条**互相有差别**的回复草稿——',
  '不是同义改写：短的那条只说结论，详细的那条把理由与下一步写清楚，婉拒的那条要礼貌但明确。',
  '只输出 JSON 数组，每项 `{ "kind": "short"|"detailed"|"decline", "text": "..." }`。',
  '用发信人自己的语气；引用到知识库内容时照原意说，不要编造政策或承诺。',
].join('\n')

function suggestModel(options: MessagesOptions, workspace_id: WorkspaceId): SuggestModel {
  return {
    async suggest(req: SuggestRequest) {
      const models = options.models
      if (models === undefined) return []
      const position = options.position?.()
      const completion = await models.complete({
        messages: [
          { role: 'system', content: SUGGEST_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              subject: req.subject,
              from: req.from,
              body: req.body,
              context: req.context,
              voice: req.voice ?? '',
              knowledge: req.knowledge.map((k) => ({ title: k.title, text: k.text })),
              kinds: req.kinds,
              lang: req.lang,
            }),
          },
        ],
        meta: {
          workspace_id,
          assignment_id: position?.assignment_id ?? 'asg_unknown',
          role_id: position?.role_id ?? 'common.member',
          run_id: 'run_message_suggest',
          purpose: 'extraction',
        },
      })
      const rows = parseJsonArray(completion.text)
      return rows.flatMap((r) => {
        const kind = (r as { kind?: string }).kind
        const text = (r as { text?: string }).text
        if (typeof text !== 'string' || text.trim() === '') return []
        const k: ReplySuggestionKind = kind === 'detailed' || kind === 'decline' ? kind : 'short'
        return [{ kind: k, text }]
      })
    },
  }
}

/** 模型爱在 JSON 外面裹一层 ```；这里只认第一个 `{…}`。 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export type { Iso8601, MessageFolderKind }
