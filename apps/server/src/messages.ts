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
 *    缓存了就会出现"昨天开了今天关了，信还在往 KefuAgents 里挪"。
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
import { ApiError } from '@agentsws/api'
import type {
  CredentialSource,
  MailboxAccount,
  MailboxActionRecord,
  MailboxStateStore,
  MailboxWriter,
  MailSource,
  MessageStore,
  RawEmailMessage,
  RawStore,
  RemoteImageLoader,
  SuggestModel,
  SuggestRequest,
  SupportMailboxSwitches,
  TriageContext,
  TriageModel,
} from '@agentsws/channels'
import {
  applySupportMailboxActions,
  createRemoteImageLoader,
  folderKindOf,
  folderPathFor,
  ImapMailboxWriter,
  ImapMailSource,
  inlineRemoteImages,
  isAgentFolderKind,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  mailboxFoldersFrom,
  ReplySuggester,
  restoreRemoteImages,
  SqliteMailboxStateStore,
  SqliteMessageStore,
  supportIntakeKey,
  supportMailboxSwitches,
  triageMessage,
  userVerdict,
} from '@agentsws/channels'
import type {
  Clock,
  EventEnvelope,
  Halt,
  Iso8601,
  MessageBackfillInput,
  MessageConfirmRouteInput,
  MessageConfirmRouteResult,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageFolderKind,
  MessageImagesReport,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageRecord,
  MessageRoute,
  MessageSendInput,
  MessageSendResult,
  MessageSyncReport,
  MessageThreadSummary,
  MessageTriage,
  MessageWriteback,
  ModelGateway,
  PersonId,
  ReplySuggestion,
  ReplySuggestionKind,
  RoleId,
  SenderRule,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { KOL_FOLDER, SUPPORT_FOLDER } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { Work } from '@agentsws/work'
import type { B2bMail } from './b2b-mail.js'
import type {
  DirectMailInput,
  DirectMailResult,
  SupportMailIntake,
  SupportMailIntakeResult,
} from './channels.js'
import { OUTBOUND_HALTED } from './channels.js'
import type { MailAccount } from './connections.js'
import { MailboxActionFailures, mailboxActionEvent, maskAddress } from './mailbox-actions.js'
import {
  type MailboxSwitchPatch,
  type MailboxSwitchSettings,
  MailboxSwitchStore,
} from './mailbox-switches.js'

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
  /**
   * 这只邮箱上有哪些文件夹。缺省问回写端（真 IMAP `LIST`）；列不到按
   * {@link DEFAULT_FOLDERS} 的真名试。WP161：岗位文件夹按这份清单认已有的真名。
   */
  listFolders?(account: MailAccount): Promise<string[]>
  /** 知识库检索（回复建议引用出处时用）。不给 = 建议里没有出处。 */
  searchKnowledge?(
    text: string,
    limit: number,
  ): Promise<{ source_id: string; title: string; text: string }[]>
  /** 语气与签名（个人层技能 / 记忆，54 的六层）。 */
  voice?(): string | undefined
  /**
   * WP125（72 §P0-1）：**分拣判成 `support` 的来信交给客服判断层**。
   *
   * 63 定的顺序是「消息 → 分拣 → 归到 KefuAgents」；WP125 在它后面接上一步：
   * 分出来的客服信下一步必须进 `support-core` 的那套判断（意图 → 边界 → 起草 →
   * 升级 → 三道自主门），而不是直接落一条事项就完事。
   *
   * 这里只**递一次信号**：真正的判定在 `support-judgment.ts`，落卡与起 Run 在
   * `channels.ts`。不接 = 老行为（信照常归档、照常挂事项，只是没有门）。
   */
  onSupportMail?(input: {
    thread_id: string
    matter_id: string
    text: string
    subject?: string
    from?: string
  }): void | Promise<void>
  /**
   * WP163：判成客服的信在邮箱里怎么动——老产品 KefuAgent 的四个开关（影子模式 /
   * 接管 / 挪信 / 标已读）。**每封现查**。不给 = 老产品的默认值（全开、影子关）。
   *
   * 挪信只由消息同步负责（docs/63 §D「挪信归谁」）：渠道那一路在服务进程里不再挪信。
   *
   * WP167：不给 = 按连接页那只邮箱卡上的三个开关（{@link MessagesAssembly.switches}）；
   * 给了就以它为准（测试与没有界面的装配用）。按邮箱地址各一份。
   */
  supportMailbox?(account: string): Partial<SupportMailboxSwitches>
  /**
   * WP167（docs/63 §D「收信一个入口」）：判成客服的信**递进客服那一路**
   * （`channels.intakeSupportMail`：Amazon 子渠道判定、线程台账、去重、落事项、判断层、起 Run）。
   *
   * 给了它，交接就不再自己开事项、也不再调 {@link MessagesOptions.onSupportMail}——那几步
   * 都在渠道的入站管线里，这里不另写一份。不给 = 老行为（只开事项 + 递一次判断层信号）。
   */
  intakeSupport?(input: SupportMailIntake): Promise<SupportMailIntakeResult>
  /**
   * WP167 终审追加：升级那一拍预写台账（`channels.seedSupportIntake`）。接了 {@link intakeSupport}
   * 才有意义：第一次同步之前，把已有事项钉着的线程里每一封信写进"进过客服管线"的台账，
   * 于是升级后第一次扫描不会给老信再开事项、再起 Run。只做一次（台账里有标记就不再算）。
   */
  seedSupportIntake?(
    marker: string,
    keys: () => Promise<readonly string[]>,
  ): Promise<{ already: boolean; seeded: number }>
  /**
   * WP172（docs/84 §5）：B2B 那一路（`b2b-mail.ts`）。给了它，分拣开始产出 `b2b`——
   * 只在 B2B 岗位开着、而且这只邮箱卡上「收 B2B 信」开着时；判成 B2B 的信落成询盘 /
   * 往来记录（岗位开着才开事项、起 Run），再挪进这只邮箱的 `BtoBAgents`。退订与退信
   * 每封都过一遍（进抑制名单）。不给 = 老行为（一封 B2B 都不产出）。
   */
  b2b?: B2bMail
  /**
   * WP204：「显示图片」的本机代取（{@link createRemoteImageLoader}：只取公网 http(s)、
   * 只收图片、限大小）。测试与 demo 注入替身；不给 = 真代取。
   */
  loadRemoteImage?: RemoteImageLoader
}

/** WP204：影子模式下归档 / 删除 / 挪信那一句（界面也按它置灰，这里是兜底）。 */
export const SHADOW_MODE_REFUSAL =
  '这只邮箱开着影子模式（只看不动），归档 / 删除不会动邮箱。要动，先在连接页把影子模式关掉。'

/**
 * 缺省要扫的文件夹真名。
 *
 * 真机器上先问服务器要一份清单（`listFolders`），问不到才用这一份试——
 * 各家名字不一样，硬编码一份名单只会在 Gmail 上跑得好、在 Outlook 上少扫两个。
 *
 * WP161：岗位那两只用与老产品相同的规范名（`KefuAgents` / `KOLAgents`）。
 */
export const DEFAULT_FOLDERS: readonly string[] = [
  'INBOX',
  'Sent',
  'Drafts',
  'Trash',
  'Junk',
  SUPPORT_FOLDER,
  KOL_FOLDER,
]

/**
 * WP167 终审追加：升级那一拍预写台账的标记（写进台账里，有它就不再算第二遍）。
 * 以后要是改了"老信"的口径需要再补一遍，换一个版本号就行。
 */
export const LEGACY_SEED_MARKER = 'meta:wp167_legacy_seed_v1'

/** WP161：每只邮箱的文件夹清单多久重列一次（第一次挪信新建的那只会随手补进去）。 */
export const FOLDER_LIST_TTL_MS = 10 * 60_000

export interface MessagesAssembly {
  store: MessageStore
  sync: MailboxSync
  port: MessagesPort
  /**
   * WP167：连接页那只邮箱卡上的三个开关（影子模式 / 挪进 KefuAgents / 标已读）。
   * 改了立刻生效（消息同步每封现查），改一次写一条 `mailbox.switches_changed`。
   */
  switches: {
    get(address: string): MailboxSwitchSettings & { takeover: boolean; b2b_position: boolean }
    set(
      address: string,
      patch: MailboxSwitchPatch,
      by: string,
    ): MailboxSwitchSettings & { takeover: boolean; b2b_position: boolean }
  }
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

  /**
   * WP161：每只邮箱**各自**的文件夹清单（按连接 id 分）。`listed` = 服务器上列出来的
   * 全部（挪信时按它认岗位文件夹的真名）；`scan` = 要扫的那几只。列不到时只有 `scan`
   * （缺省名单），下一轮再列。
   */
  const folderCache = new Map<string, { listed?: string[]; scan: string[]; at: number }>()
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

  const foldersOf = (account: MailAccount): string[] =>
    folderCache.get(account.connection_id)?.scan ?? [...DEFAULT_FOLDERS]
  /** 挪信时认真名用的那份：列到过就用服务器的全量清单，否则用扫描清单。 */
  const knownOf = (account: MailAccount): string[] =>
    folderCache.get(account.connection_id)?.listed ?? foldersOf(account)

  /** 每只邮箱先列服务器上的文件夹（有缓存且没过期就不列）。一只列不动不拖垮别的。 */
  const refreshFolders = async (): Promise<void> => {
    const now = Date.parse(clock.now())
    for (const account of options.accounts()) {
      const cached = folderCache.get(account.connection_id)
      if (cached?.listed !== undefined && now - cached.at < FOLDER_LIST_TTL_MS) continue
      let listed: string[] = []
      try {
        listed =
          (await (options.listFolders?.(account) ?? writerFor(account)?.listFolders?.())) ?? []
      } catch (e) {
        logQuiet('imap_list_failed', account.address, e)
      }
      const scan = mailboxFoldersFrom(listed)
      folderCache.set(
        account.connection_id,
        scan === undefined ? { scan: [...DEFAULT_FOLDERS], at: now } : { listed, scan, at: now },
      )
    }
  }

  /** 挪进一只新建的岗位文件夹之后顺手记上：下一轮就扫它，不用等清单过期。 */
  const noteFolder = (account: MailAccount, path: string): void => {
    const cached = folderCache.get(account.connection_id)
    if (cached?.listed === undefined || cached.listed.includes(path)) return
    const listed = [...cached.listed, path]
    folderCache.set(account.connection_id, {
      ...cached,
      listed,
      scan: mailboxFoldersFrom(listed) ?? cached.scan,
    })
  }

  const mailboxAccounts = (): MailboxAccount[] =>
    options.accounts().map((account) => {
      const inner = writerFor(account)
      const writer: MailboxWriter | undefined =
        inner === undefined
          ? undefined
          : {
              setFlags: (folder, uid, add, remove) => inner.setFlags(folder, uid, add, remove),
              move: async (folder, uid, to) => {
                const moved = await inner.move(folder, uid, to)
                if (moved) noteFolder(account, to)
                return moved
              },
            }
      return {
        address: account.address,
        folders: foldersOf(account),
        known_folders: knownOf(account),
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
  /** WP172：B2B 岗位开着（有人持着 `b2b.*`）——看的是 B2B 那一路自己的现查。 */
  const b2bEnabled = (): boolean => options.b2b?.enabled() ?? false
  /** 这只邮箱收不收 B2B 信：岗位开着 + 邮箱卡上「收 B2B 信」开着（缺省开）。 */
  const b2bEnabledFor = (account: string): boolean => b2bEnabled() && switchStore.get(account).b2b

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

  /**
   * WP163：分拣第 ① 层（线程归并）只认**后续来信**——带 In-Reply-To / References 的那种。
   *
   * 同一拍里渠道那一路（`channels.ts`）先跑，它会给 INBOX 里**每一封**新信都开一条
   * 钉着自己线程的事项；要是一封全新的群发信也拿自己的线程 id 去对，就会"命中客服已有
   * 线程"、被挪进 `KefuAgents`——正是 WP163 要堵的那条缝。63 §D ① 的原话本来就是
   * "In-Reply-To / References 命中"。
   */
  const triageCtx = (followUp = true, account?: string): TriageContext => ({
    support_enabled: supportEnabled(),
    kol_enabled: kolEnabled(),
    // WP172：B2B 按邮箱开关算（「收 B2B 信」），线程归并同样只认后续来信
    b2b_enabled: account === undefined ? b2bEnabled() : b2bEnabledFor(account),
    isB2bThread: (id, refs) => followUp && (options.b2b?.isOurThread(id, refs) ?? false),
    isB2bSender: (email) => options.b2b?.isKnownSender(email) ?? false,
    isSupportThread: (id, refs) => followUp && supportEnabled() && knownThread(id, refs),
    isKolThread: (id, refs) => followUp && kolEnabled() && knownThread(id, refs),
    senderRules: rulesCache,
    model_halted: options.halt.isHalted('model') || options.halt.isHalted('all'),
    at: clock.now(),
  })

  /** 发件人规则在同步那一轮里要被读很多次，开轮时刷一次就够。 */
  let rulesCache: SenderRule[] = []

  /** WP163：每只邮箱最近一次没动成的邮箱动作（「消息」页左栏那一行）。 */
  const mailboxFailures = new MailboxActionFailures()

  const onMailboxAction = (record: MailboxActionRecord): void => {
    const at = clock.now()
    mailboxFailures.note(record, at)
    options.appendEvent(mailboxActionEvent({ workspace_id, actor_id: 'messages', at, record }))
  }

  /* ── WP167：连接页那只邮箱卡上的三个开关 ───────────────────────────────── */

  const switchStore = new MailboxSwitchStore(
    options.dbDir === undefined ? {} : { dir: options.dbDir },
  )
  /** 这只邮箱现在按什么开关动邮箱：装配方给了就以它为准，否则取卡上那三个。 */
  const switchesOf = (account: string): Partial<SupportMailboxSwitches> =>
    options.supportMailbox?.(account) ?? switchStore.get(account)

  /* ── 交给客服 / 红人那一路 ─────────────────────────────────────────── */

  /**
   * 这封信的原始 MIME（人在「待确认」里点「这是客服」时，同步那一拍早过去了）：
   * 从受控原始材料区取回。取不到（没接原始材料区、材料过了保留期）= 交不出去。
   */
  const rawOf = async (record: MessageRecord): Promise<RawEmailMessage | undefined> => {
    if (options.rawStore === undefined || record.raw_ref === undefined) return undefined
    const row = await options.rawStore.get(record.raw_ref)
    const payload = row?.payload
    const source =
      typeof payload === 'string'
        ? payload
        : payload instanceof Uint8Array
          ? new TextDecoder().decode(payload)
          : undefined
    if (source === undefined) return undefined
    return { uid: record.uid ?? 0, mailbox: record.folder, source }
  }

  /** 钉着这条线程的那条事项（有就给，没有不开）。 */
  const matterOfThread = (thread_id: string): string | undefined =>
    options.work
      ?.listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === 'thread' && p.id === thread_id))?.id

  /**
   * 一封信交给客服 / 红人那一路（分拣判的，或人在「待确认」里点的）。
   *
   * 客服信（WP167，docs/63 §D「收信一个入口」）：递进渠道的入站管线——Amazon 子渠道判定、
   * 线程台账、去重、落事项、判断层、起 Run 都在那一条里；同一封信只进一次（渠道那边按
   * Message-ID 记台账）。**已经在岗位文件夹里的信**（老产品或人自己的过滤规则挪过去的）
   * 不再开事项、不起 Run：有事项就挂上，算"那一侧早就接了"，信不动。
   *
   * 红人信照现在的规矩：归并到那条合作线程的事项上。
   */
  const handOff = async (
    record: MessageRecord,
    route: 'support' | 'kol' | 'b2b',
    raw: RawEmailMessage | undefined,
    by: 'triage' | 'user',
    triage?: MessageTriage,
  ): Promise<{ accepted: boolean; matter_id?: string }> => {
    const link = async (matter_id: string | undefined): Promise<void> => {
      if (matter_id === undefined) return
      await store.update(record.id, { linked: { type: 'matter', id: matter_id } })
    }
    /*
     * WP172：B2B 那一路落成询盘 / 往来记录（开事项、起 Run 在 `b2b-mail.ts` 里，只在 B2B 岗位开着时）。
     * 没开 B2B 岗位、或这只邮箱不收 B2B 信 → 不接（信不挪、不开事项，同 WP163 的规矩）。
     * 已经在岗位文件夹里的信（人自己的过滤规则挪过去的）同客服那条：不开事项、不起 Run。
     */
    if (route === 'b2b') {
      const b2b = options.b2b
      if (b2b === undefined || !b2bEnabledFor(record.account)) return { accepted: false }
      if (isAgentFolderKind(record.folder_kind)) {
        const existing = matterOfThread(record.thread_id)
        await link(existing)
        return existing === undefined ? { accepted: true } : { accepted: true, matter_id: existing }
      }
      const out = await b2b.intake(record, triage ?? userVerdict('b2b', clock.now()), by)
      if (!out.accepted) return { accepted: false }
      await link(out.matter_id)
      return out.matter_id === undefined
        ? { accepted: true }
        : { accepted: true, matter_id: out.matter_id }
    }
    const work = options.work
    const position = options.position?.()
    if (work === undefined || position === undefined) return { accepted: false }
    if (route === 'support' && !supportEnabled()) return { accepted: false }
    if (route === 'kol' && !kolEnabled()) return { accepted: false }
    const intake = options.intakeSupport
    if (route === 'support' && intake !== undefined) {
      if (isAgentFolderKind(record.folder_kind)) {
        const existing = matterOfThread(record.thread_id)
        await link(existing)
        return existing === undefined ? { accepted: true } : { accepted: true, matter_id: existing }
      }
      const source = raw ?? (await rawOf(record))
      if (source === undefined) return { accepted: false }
      const out = await intake({
        account: record.account,
        raw: source,
        ...(record.message_id === undefined ? {} : { message_id: record.message_id }),
        by,
      })
      if (!out.accepted) return { accepted: false }
      const matter_id = out.matter_id ?? matterOfThread(record.thread_id)
      await link(matter_id)
      return matter_id === undefined ? { accepted: true } : { accepted: true, matter_id }
    }
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
    await link(matter.id)
    // WP125（72 §P0-1）：没接渠道那一路的老装配——分拣判成 `support` 的那一封递一次判断层信号
    if (route === 'support') {
      await options.onSupportMail?.({
        thread_id: record.thread_id,
        matter_id: matter.id,
        text: record.text,
        subject: record.subject,
        from: record.from.email,
      })
    }
    return { accepted: true, matter_id: matter.id }
  }

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
        triageCtx(record.in_reply_to !== undefined || record.references.length > 0, record.account),
        triageModel,
      ).then((verdict) => {
        // WP172（docs/84 §5 第 5 条）：退订回信、硬退信分拣时直接进抑制名单，不等 Run
        try {
          options.b2b?.observe(record)
        } catch (e) {
          logQuiet('b2b_suppression_failed', record.account, e)
        }
        return verdict
      }),
    /**
     * 交给客服 / 红人那一路；那一侧不接就回 `false`——于是信不挪、留在收件箱里可见。
     *
     * WP167：客服信递进渠道的入站管线（开事项、判断层、起 Run 都在那里），见 {@link handOff}。
     * 交接炸了不让这封信变成毒消息：它已经落进消息库了，只是没交出去——记一笔、信不动。
     */
    handoff: async (record, triage, raw) => {
      if (triage.route !== 'support' && triage.route !== 'kol' && triage.route !== 'b2b')
        return false
      try {
        return (await handOff(record, triage.route, raw, 'triage', triage)).accepted
      } catch (e) {
        logQuiet('support_intake_failed', record.account, e)
        return false
      }
    },
    // WP163 / WP167：四个开关每封现查（按邮箱各一份）；每个动作一条事件 + 记住最近一次失败
    support_mailbox: (account) => switchesOf(account),
    on_mailbox_action: onMailboxAction,
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

  /** WP204：这只邮箱开着影子模式（只看不动）——人按的已读 / 星标只在本机标，归档 / 删除不做。 */
  const shadowOf = (address: string): boolean =>
    supportMailboxSwitches(switchesOf(address)).shadow_mode

  /**
   * 旗标回写：本机先改，IMAP 尽力（写不动只 log）。WP204：回一句"邮箱里动成了没有"，
   * 界面据此说人话（以前写不动就静默，人以为邮箱里也改了）。
   */
  const writeFlags = async (
    record: MessageRecord,
    input: MessageFlagsInput,
  ): Promise<MessageWriteback> => {
    const account = accountOf(record.account)
    const uid = record.uid
    if (account === undefined || uid === undefined) return 'no_mailbox'
    if (shadowOf(record.account)) return 'local_only'
    const writer = writerFor(account)
    if (writer === undefined) return 'no_mailbox'
    const add: string[] = []
    const remove: string[] = []
    const flag = (on: boolean | undefined, name: string): void => {
      if (on === true) add.push(name)
      if (on === false) remove.push(name)
    }
    flag(input.read, '\\Seen')
    flag(input.starred, '\\Flagged')
    flag(input.answered, '\\Answered')
    if (add.length === 0 && remove.length === 0) return 'written'
    return (await writer.setFlags(record.folder, uid, add, remove)) ? 'written' : 'failed'
  }

  /**
   * WP167：人工分拣交出去之后，按这只邮箱的开关动邮箱（与同步那一路同一套：
   * `applySupportMailboxActions` 的顺序与记账，红人那只只看影子模式）。
   * 已经在岗位文件夹里的信不挪（WP163）。
   */
  const moveAfterHandoff = async (
    record: MessageRecord,
    route: 'support' | 'kol' | 'b2b',
  ): Promise<MessageRecord> => {
    const account = accountOf(record.account)
    const uid = record.uid
    if (account === undefined || uid === undefined || isAgentFolderKind(record.folder_kind)) {
      return record
    }
    const writer = writerFor(account)
    const to = folderPathFor(route, knownOf(account))
    const switches = supportMailboxSwitches(switchesOf(record.account))
    const from_folder = record.folder
    const moveOne = async (dest: string): Promise<boolean> => {
      const moved = (await writer?.move(from_folder, uid, dest)) ?? false
      if (moved) noteFolder(account, dest)
      return moved
    }
    if (route === 'support') {
      const done = await applySupportMailboxActions({
        switches,
        account: record.account,
        uid,
        from_folder,
        to_folder: to,
        ops:
          writer === undefined
            ? {}
            : {
                markRead: async () => writer.setFlags(from_folder, uid, ['\\Seen'], []),
                move: async (dest) => moveOne(dest),
              },
        record: onMailboxAction,
      })
      const patch: Partial<MessageRecord> = {
        ...(done.marked_read ? { flags: { ...record.flags, read: true } } : {}),
        ...(done.moved ? { folder: to, folder_kind: folderKindOf(to) } : {}),
      }
      return Object.keys(patch).length === 0
        ? record
        : ((await store.update(record.id, patch)) ?? record)
    }
    if (switches.shadow_mode) {
      onMailboxAction({
        account: record.account,
        uid,
        from_folder,
        action: 'observe',
        status: 'skipped',
        reason: 'shadow_mode',
      })
      return record
    }
    const moved = await moveOne(to)
    onMailboxAction({
      account: record.account,
      uid,
      from_folder,
      to_folder: to,
      action: 'move',
      ...(moved
        ? { status: 'completed' as const }
        : { status: 'failed' as const, reason: 'server_refused' as const }),
    })
    return moved
      ? ((await store.update(record.id, { folder: to, folder_kind: folderKindOf(to) })) ?? record)
      : record
  }

  /** WP204：「显示图片」的本机代取（测试 / demo 注入替身）。 */
  const loadImage: RemoteImageLoader = options.loadRemoteImage ?? createRemoteImageLoader()

  const requireMessage = async (id: string): Promise<MessageRecord> => {
    const row = await store.get(id)
    // WP204：以前抛裸 Error → 500「internal error」，界面只能说"出错了"
    if (row === undefined)
      throw new ApiError('not_found', '这封信不在了（可能刚被别处挪走），刷新一下列表。')
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
        const failure = mailboxFailures.of(address)
        out.push({
          address,
          unread: folders.reduce((n, f) => n + (f.kind === 'inbox' ? f.unread : 0), 0),
          folders,
          backfill_floor: sync.backfillFloor(address),
          ...(failure === undefined ? {} : { last_mailbox_failure: failure }),
          ...(b2bEnabledFor(address) ? { b2b: true } : {}),
          // WP204：影子模式开着——消息页把归档 / 删除置灰并说为什么
          ...(accountOf(address) !== undefined && shadowOf(address) ? { shadow_mode: true } : {}),
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
      // 状态带只给有 Agent 在处理的那几条路（WP172 起 B2B 也算）
      const agentRoute = messages
        .map((m) => m.route)
        .find((r): r is 'support' | 'kol' | 'b2b' => r === 'support' || r === 'kol' || r === 'b2b')
      const linked = messages.find((m) => m.linked !== undefined)?.linked
      return {
        thread_id,
        subject: last?.subject ?? '',
        messages,
        ...(agentRoute === undefined
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
    ): Promise<{ message: MessageRecord; writeback: MessageWriteback }> {
      const row = await requireMessage(id)
      const flags = {
        ...row.flags,
        ...(input.read === undefined ? {} : { read: input.read }),
        ...(input.starred === undefined ? {} : { starred: input.starred }),
        ...(input.answered === undefined ? {} : { answered: input.answered }),
      }
      const next = await store.update(id, { flags })
      // 回写 IMAP：用户回到自己的邮箱软件看到的必须是同一个状态（63 §7）。
      // WP204：影子模式开着就只在本机标（`local_only`），邮箱一下都不动
      const writeback = await writeFlags(row, input)
      return { message: next ?? row, writeback }
    },

    async move(
      actor: MessageActor,
      id: string,
      input: MessageMoveInput,
    ): Promise<{ message: MessageRecord; rule?: SenderRule; writeback: MessageWriteback }> {
      const row = await requireMessage(id)
      const account = accountOf(row.account)
      // WP161：按这只邮箱上已有的真名走（`kefuagents` 在就沿用，不另建 `KefuAgents`）
      const known = account === undefined ? [] : knownOf(account)
      const to = folderPathFor(input.to, known)
      const route: MessageRoute =
        input.to === 'support' || input.to === 'kol' || input.to === 'b2b' ? input.to : 'inbox'
      /*
       * WP204：分两种挪。
       * - **纠错**（移到客服 / 红人 / B2B、从岗位文件夹移回收件箱、或勾了"以后都这样"）：
       *   改路由、分拣结论记"人"（63 §D「纠错」）；
       * - **收拾**（归档、删除 = 移到垃圾箱、以及撤销它们）：只换文件夹，**路由与分拣结论不动**——
       *   以前归档一下摘要就变成"你挪过这封信"、要不要回也被清掉，撤销回来也找不回。
       */
      const correcting =
        isAgentFolderKind(input.to) ||
        (input.to === 'inbox' && row.route !== 'inbox') ||
        input.remember_sender === true
      const shadow = account !== undefined && shadowOf(row.account)
      // 影子模式 = 这只邮箱一下都不动：收拾类的挪不做（界面已置灰，这里兜底）；纠错只改本机的路由
      if (shadow && !correcting) throw new ApiError('conflict', SHADOW_MODE_REFUSAL)
      const next =
        (await store.update(id, {
          ...(shadow ? {} : { folder: to, folder_kind: folderKindOf(to) }),
          ...(correcting ? { route, triage: userVerdict(route, clock.now(), row.labels) } : {}),
        })) ?? row
      suggester.invalidate(id)
      let writeback: MessageWriteback = shadow ? 'local_only' : 'no_mailbox'
      if (!shadow && account !== undefined && row.uid !== undefined) {
        const moved = await writerFor(account)?.move(row.folder, row.uid, to)
        if (moved === true) noteFolder(account, to)
        writeback = moved === true ? 'written' : moved === false ? 'failed' : 'no_mailbox'
      }
      if (input.remember_sender !== true) return { message: next, writeback }
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
      return { message: next, rule, writeback }
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
    ): Promise<{ message: MessageRecord; images: MessageImagesReport }> {
      const row = await requireMessage(id)
      if (always) await store.trustSender(row.from.email)
      if (row.html === undefined || !row.has_remote_images)
        return { message: row, images: { shown: 0, failed: 0 } }
      // WP204：本机代取、内联成 data:——浏览器不直连对方服务器（桌面壳的 CSP 也只认 data:）。
      // 只对这一封、这一次生效：库里那一份照旧挡着，下次打开还是先不加载。
      const out = await inlineRemoteImages(row.html, loadImage)
      return {
        message: { ...row, html: out.html, has_remote_images: out.failed > 0 },
        images: { shown: out.shown, failed: out.failed },
      }
    },

    async attachment(
      _actor: MessageActor,
      id: string,
      attachment_id: string,
    ): Promise<{ name: string; mime: string; bytes: Uint8Array } | undefined> {
      const row = await requireMessage(id)
      const meta = row.attachments.find((a) => a.id === attachment_id)
      if (meta?.ref === undefined || options.rawStore === undefined) return undefined
      const payload = (await options.rawStore.get(meta.ref))?.payload
      const bytes =
        payload instanceof Uint8Array
          ? payload
          : typeof payload === 'string'
            ? new TextEncoder().encode(payload)
            : undefined
      return bytes === undefined ? undefined : { name: meta.name, mime: meta.mime, bytes }
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
      if (send === undefined)
        throw new ApiError('not_implemented', '这台机器上没接发信，这封没发出去。')
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
      // WP204：以前抛裸 Error → 500「internal error」，人只看到"出错了"，信还以为发了
      if (!result.ok) {
        const why = result.error ?? '发送失败，这封没发出去。'
        throw new ApiError(why === OUTBOUND_HALTED ? 'halted' : 'provider_unavailable', why)
      }
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

    /**
     * WP167：「待确认」那一栏上人点的那一下——**人工分拣**，写事件。
     *
     * 「这是客服」= 交给客服那一路（开事项、判断层、起 Run），再按这只邮箱的开关动邮箱；
     * 交不出去（客服岗位没开、原信取不回）就什么都不改，信还挂在待确认里，界面照实说。
     * 「不是」= 只记人的判断，信留在收件箱，从待确认里消失。
     */
    async confirmRoute(
      actor: MessageActor,
      id: string,
      input: MessageConfirmRouteInput,
    ): Promise<MessageConfirmRouteResult> {
      await ensureSeeded()
      const row = await requireMessage(id)
      const at = clock.now()
      const route = input.route
      let handed: { accepted: boolean; matter_id?: string } = { accepted: false }
      if (route !== 'inbox') {
        try {
          handed = await handOff(row, route, undefined, 'user')
        } catch (e) {
          logQuiet('support_intake_failed', row.account, e)
        }
      }
      const event = (handed_off: boolean): void =>
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'messages.route_confirmed',
          actor: { kind: 'person', id: actor.person_id },
          subject: { type: 'message', id: row.id },
          correlation: { trace_id: `tr_msgconfirm_${row.id}_${at}` },
          // 63 §10：没有正文、地址遮过
          payload: {
            route,
            handed_off,
            account: maskAddress(row.account),
            ...(row.triage?.suggested_route === undefined
              ? {}
              : { suggested_route: row.triage.suggested_route }),
            ...(handed.matter_id === undefined ? {} : { matter_id: handed.matter_id }),
          },
        })
      if (route !== 'inbox' && !handed.accepted) {
        event(false)
        return { message: row, handed_off: false }
      }
      const triage: MessageTriage = {
        ...userVerdict(route, at, row.labels),
        summary: row.triage?.summary ?? '',
        reasons: ['人工分拣：在「待确认」里点的'],
      }
      let next =
        (await store.update(row.id, {
          route,
          triage,
          ...(handed.matter_id === undefined
            ? {}
            : { linked: { type: 'matter' as const, id: handed.matter_id } }),
        })) ?? row
      suggester.invalidate(row.id)
      if (route !== 'inbox') next = await moveAfterHandoff(next, route)
      event(route !== 'inbox')
      return {
        message: next,
        handed_off: route !== 'inbox',
        ...(handed.matter_id === undefined ? {} : { matter_id: handed.matter_id }),
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
      await ensureSeeded()
      rulesCache = await store.senderRules()
      await refreshFolders()
      return sync.sync()
    },

    async backfill(_actor: MessageActor, input: MessageBackfillInput): Promise<{ floor: string }> {
      const address = input.account ?? options.accounts()[0]?.address ?? ''
      return { floor: sync.backfill(address, input.days ?? 30) }
    },
  }

  /**
   * WP167 终审追加：升级那一拍预写台账（本进程只跑一次；台账里有标记就不再算）。
   *
   * 算的是"老版本已经交给客服那一路的信"：工作模型里每条会话事项钉着的线程——线程 id 就是
   * 那条线程第一封信的 Message-ID——外加消息库里这些线程下的每一封信。INBOX 里老版本处理过
   * 但消息库还没见过的信，由渠道那边按适配器原先的游标认（见 `channels.ts` 的 `legacyCutoffOf`）。
   */
  let seeding: Promise<void> | undefined
  const ensureSeeded = (): Promise<void> => {
    const seed = options.seedSupportIntake
    if (seed === undefined || options.intakeSupport === undefined) return Promise.resolve()
    seeding ??= seed(LEGACY_SEED_MARKER, async () => {
      const threads = new Set<string>()
      for (const m of options.work?.listMatters({ kind: 'conversation' }) ?? []) {
        for (const p of m.context.pinned) if (p.type === 'thread') threads.add(p.id)
      }
      const keys = new Set<string>()
      for (const thread of threads) {
        // 渠道那一路给没有 Message-ID 的信造的线程 id（`email-thread:…`）不是一封信的身份
        if (!thread.startsWith('email-thread:')) {
          keys.add(supportIntakeKey({ account: '', message_id: thread, folder: '' }))
        }
        for (const row of await store.thread(thread)) {
          keys.add(
            supportIntakeKey({
              account: row.account,
              message_id: row.message_id,
              folder: row.folder,
              uid: row.uid,
            }),
          )
        }
      }
      return [...keys]
    }).then(
      () => undefined,
      (e) => {
        // 这一次没写成：下一轮再来（标记没写，重来一遍是幂等的）
        seeding = undefined
        logQuiet('support_intake_seed_failed', '', e)
      },
    )
    return seeding
  }

  const takeover = (): boolean => supportEnabled()
  const switches: MessagesAssembly['switches'] = {
    get: (address) => ({
      ...switchStore.get(address),
      takeover: takeover(),
      b2b_position: b2bEnabled(),
    }),
    set: (address, patch, by) => {
      const { after, changed } = switchStore.set(address, patch)
      if (changed.length > 0) {
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'mailbox.switches_changed',
          actor: { kind: 'person', id: by },
          correlation: { trace_id: `tr_mbxsw_${clock.now()}` },
          // 只有改了哪几个、改成什么；地址遮过（63 §10）
          payload: {
            account: maskAddress(address),
            changed: Object.fromEntries(changed.map((k) => [k, after[k]])),
          },
        })
      }
      return { ...after, takeover: takeover(), b2b_position: b2bEnabled() }
    },
  }

  return {
    store,
    sync,
    port,
    switches,
    async poll(): Promise<MessageSyncReport> {
      await ensureSeeded()
      rulesCache = await store.senderRules()
      // WP161：每只邮箱先列文件夹（各列各的、各缓存各的），再扫
      await refreshFolders()
      return sync.sync()
    },
    close(): void {
      store.close?.()
    },
  }
}

/* ── 小零件 ───────────────────────────────────────────────────────────── */

/** 63 §10：日志里的地址一律遮掩（WP163 起实现挪到 `mailbox-actions.ts`，两处共用）。 */
export { maskAddress }

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
  'route 的含义：support = 零售顾客的售后 / 订单问题；kol = 红人 / 博主想谈合作；',
  'b2b = 企业买家的询盘（询价、要目录、问起订量、要样品、找代理 / 分销、OEM）；inbox = 其他。',
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
