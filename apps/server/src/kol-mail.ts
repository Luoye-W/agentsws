/**
 * WP416（自查 kol 组 R1 / R6）：**红人这一路的真执行器**——开发信经已连的邮箱真发、回信对上合作、
 * 建合作 / 验收两张卡批了才生效。
 *
 * 以前这几张卡批了之后落进内存空桩（`MemoryBackend`）：回 ok、什么都没做——开发信一封没发、
 * 验收结论还是「待审」、点了「不要」的合作还留在库里。这个文件把它们接上：
 *
 * 1. **开发信（`kol_outreach`，真红人）**：从加密库取收件地址 → 经消息层的 `sendMail`（outbox 七态、
 *    急停、幂等）从已连的邮箱发 → **读回 outbox 那一行**（服务商收下了才算）→ 记一条出站往来
 *    （带 Message-ID）→ 合作从「已找到」推到「已建联」。没连邮箱 / 地址取不到 / 不是邮箱 → 照实回
 *    `failed`，一个字都不假装。演练红人不经这里（`kol-sandbox.ts` 的硬闸先接住）。
 * 2. **回信（真邮件）**：消息同步判成红人的那一封，按 In-Reply-To / References 对我们发出去那一封、
 *    对不上再按发件地址对联系方式 → 记一条入站往来、`classifyReply` 分类、推阶段（有回音 / 谢绝）。
 * 3. **建合作卡**：出卡时那一行标「等你点头」，同意 → 清掉标记（读回）；不要 → 这一行删掉。
 * 4. **验收结论卡**：批了才把结论写进交付物（读回）。
 *
 * 纪律：地址明文只在发信那一跳从加密库取、不进事件、不进返回值；事件里只有 id。
 */
import type {
  ApprovalItem,
  Clock,
  Collaboration,
  CollaborationStage,
  Deliverable,
  EventEnvelope,
  KolChannel,
  KolExchange,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { suppressionKey } from '@agentsws/core'
import { advanceByMail, classifyReply } from '@agentsws/kol-core'
import type { BackendResult } from '@agentsws/txn'
import type { DirectMailInput, DirectMailResult } from './channels.js'
import type { KolStore } from './kol.js'
import type { SecretStore } from './secret-store.js'

/** 联系方式明文在加密库里的那一格（与 `kol-service.ts` 的 `CONTACT_SECRET_FIELD` 同值）。 */
const CONTACT_FIELD = 'value'

/** 发信那一半（消息层的邮箱；没连邮箱时 `addresses()` 是空的）。 */
export interface KolMailPort {
  /** 现在连着哪几只邮箱。 */
  addresses(): string[]
  sendMail(input: DirectMailInput): Promise<DirectMailResult>
  /** 读回：outbox 里这一行现在是什么状态（`accepted_by_provider` / `confirmed` 才算发出去了）。 */
  readBack?(outbox_id: string): Promise<{ status: string } | undefined>
}

export interface KolMailOptions {
  workspace_id: WorkspaceId
  store: KolStore
  secrets: SecretStore
  clock: Clock
  /** 晚绑定：邮箱渠道比红人服务晚建（取值时才碰它）。 */
  mail(): KolMailPort | undefined
  appendEvent?(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
}

/** 消息同步递过来的一封信（只要这几格）。 */
export interface KolInboundMail {
  from_email: string
  subject: string
  text: string
  /** 对方这一封的 Message-ID。 */
  message_id?: string
  in_reply_to?: string
  references?: readonly string[]
  /** 收到的那只邮箱。 */
  account?: string
  at?: string
}

export interface KolInboundResult {
  matched: boolean
  creator_id?: string
  collaboration_id?: string
  reply_class?: KolExchange['reply_class']
  stage?: CollaborationStage
}

export interface KolMailAssembly {
  /** 有没有能发信的邮箱。 */
  connected(): boolean
  /** 批了的卡真去做（不是红人这几种卡回 `undefined`，调用方接着走它原来那条路）。 */
  apply(change: StagedChange): Promise<BackendResult | undefined>
  /** 卡被决定了（只认建合作卡的「不要」）。 */
  onDecided(item: ApprovalItem): void
  /** 这条线程是不是回我们发出去的开发信（分拣用）。 */
  isOurThread(thread_id: string, refs: readonly string[]): boolean
  /** 一封红人来信 → 对上人和合作、记往来、推阶段。对不上回 `matched: false`。 */
  intake(mail: KolInboundMail): KolInboundResult
}

const ACCEPTED = new Set(['accepted_by_provider', 'confirmed'])

const normId = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase()

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

/** 建合作 / 议价那张卡（账本卡：`staged_change`，载荷里 `kind: 'kol_collaboration'`）。 */
export function isKolCollaborationCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'staged_change' && rec(item.payload).kind === 'kol_collaboration'
}

/** WP416：「这两个是不是同一个人」那张合并建议卡。 */
export function isKolMergeCard(item: Pick<ApprovalItem, 'kind' | 'proposer'>): boolean {
  return item.kind === 'policy_change' && item.proposer.id === 'kol-merge'
}

/** 合并建议卡上选的是哪一项（`merge` / `keep_apart`；驳回 = `keep_apart`、裸同意 = `merge`；没定回 `undefined`）。 */
export function mergeChoiceOf(item: ApprovalItem): 'merge' | 'keep_apart' | undefined {
  if (item.state === 'rejected') return 'keep_apart'
  if (item.state !== 'approved' && item.state !== 'approved_edited' && item.state !== 'applied')
    return undefined
  const edited = rec(item.decision?.edited_payload)
  const picked =
    item.decision?.selected_option_id ??
    (typeof edited.selected_option_id === 'string' ? edited.selected_option_id : undefined)
  // 没带选项的「同意」（卡上主按钮）就是「是同一个人，合」
  return picked === 'keep_apart' ? 'keep_apart' : 'merge'
}

export function createKolMail(options: KolMailOptions): KolMailAssembly {
  const { store, secrets, clock, workspace_id } = options

  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'system', id: 'kol-mail' },
        correlation: { trace_id: `tr_kol_mail_${clock.now()}` },
        payload,
      })
    } catch {
      // 事件写不进不挡发信
    }
  }

  const reveal = (value_ref: string): string | undefined => {
    try {
      return secrets.get(value_ref)?.[CONTACT_FIELD]
    } catch {
      return undefined
    }
  }

  const failed = (message: string, retryable = false): BackendResult => ({
    status: 'failed',
    error: { message, retryable },
  })

  const openCollab = (creator_id: string, channel: KolChannel): Collaboration | undefined =>
    store
      .collaborations({ channel })
      .find((c) => c.creator_id === creator_id && c.stage !== 'closed' && c.stage !== 'declined')

  /* ── 1. 开发信真发 ───────────────────────────────────────────────── */

  const applyOutreach = async (change: StagedChange): Promise<BackendResult> => {
    const after = rec(change.after)
    const creator_id = str(after.creator_id)
    const creator = creator_id === undefined ? undefined : store.creator(creator_id)
    if (creator === undefined) return failed('库里找不到这个红人了（可能刚被合并），这封没发。')
    // 演练红人的地址是造出来的：硬闸在 `kolOutreachApply`，这里再兜一次，绝不真发
    if (creator.sandbox === true) return failed('这是演练红人，信只进演练收件箱，没有真发。')
    const value_ref = Array.isArray(after.recipients)
      ? after.recipients.find((r): r is string => typeof r === 'string')
      : undefined
    const contact =
      change.target.type === 'creator_contact'
        ? store.contacts(creator.id).find((c) => c.id === change.target.id)
        : undefined
    if (contact !== undefined && contact.kind !== 'email')
      return failed('这个红人留的联系方式不是邮箱（私信 / 表单），工坊发不了——去平台上私信他。')
    const address = value_ref === undefined ? undefined : reveal(value_ref)
    if (address === undefined || !address.includes('@'))
      return failed('加密库里取不到这个红人的邮箱，这封没发。去红人详情里补一个邮箱再试。')
    const mail = options.mail()
    const accounts = mail?.addresses() ?? []
    if (mail === undefined || accounts.length === 0)
      return failed('还没连发信邮箱，这封没发。连上邮箱后在这张卡上点「再试一次」。')

    const channel = (str(after.channel) ?? 'youtube') as KolChannel
    const collab = openCollab(creator.id, channel)
    const prior = store
      .exchanges({ creator_id: creator.id })
      .filter((x) => x.direction === 'out' && x.sandbox !== true && x.mail_message_id !== undefined)
      .map((x) => x.mail_message_id as string)
    const subject = str(after.subject) ?? ''
    const body = typeof after.body === 'string' ? after.body : ''
    const result = await mail.sendMail({
      to: [address],
      subject,
      text: body,
      idempotency_key: `kol-outreach:${change.id}`,
      thread_ref: `kol:${collab?.id ?? creator.id}`,
      ...(prior.length === 0
        ? {}
        : { in_reply_to: prior[prior.length - 1] as string, references: prior }),
    })
    if (!result.ok) {
      emit('kol.outreach_not_sent', { change_id: change.id, creator_id: creator.id })
      return failed(`没发出去：${result.error ?? '邮箱那边没收下'}`, result.retryable === true)
    }
    // 读回：outbox 里这一行确实是「服务商收下了」才算发出去
    const back = mail.readBack === undefined ? undefined : await mail.readBack(result.outbox_id)
    if (mail.readBack !== undefined && (back === undefined || !ACCEPTED.has(back.status))) {
      emit('kol.outreach_unconfirmed', { change_id: change.id, creator_id: creator.id })
      return {
        status: 'unknown',
        error: {
          message: `发了，但读回时没确认邮箱收下（状态：${back?.status ?? '查不到'}）。先别重发，稍后对账。`,
          retryable: false,
        },
      }
    }
    const at = clock.now()
    const step = after.step === 'follow_up' || after.step === 'final' ? after.step : 'first'
    store.saveExchange({
      id: `xch_${change.id}`,
      creator_id: creator.id,
      ...(collab === undefined ? {} : { collaboration_id: collab.id }),
      channel,
      direction: 'out',
      subject,
      body,
      at,
      change_id: change.id,
      step,
      mail_message_id: result.message_id,
      outbox_id: result.outbox_id,
      mailbox: result.account,
    })
    if (collab !== undefined)
      store.saveCollaboration({
        ...collab,
        // 真发出去了才算「已建联」（以前提卡那一刻就改了阶段）
        ...(collab.stage === 'sourced' ? { stage: 'contacted' as const } : {}),
        last_activity_at: at,
      })
    emit('kol.outreach_sent', {
      change_id: change.id,
      creator_id: creator.id,
      step,
      ...(collab === undefined ? {} : { collaboration_id: collab.id }),
    })
    return {
      status: 'ok',
      execution_id: `kol_mail_${result.outbox_id || change.id}`,
      outcome_ref: { type: 'kol_exchange', id: `xch_${change.id}` },
    }
  }

  /* ── 3. 建合作卡 ─────────────────────────────────────────────────── */

  const applyCollaboration = (change: StagedChange): BackendResult | undefined => {
    const after = rec(change.after)
    // 议价卡（带 collaboration_id）归 `kolQuoteApply`
    if (after.collaboration_id !== undefined) return undefined
    if (change.target.type !== 'collaboration') return undefined
    const id = change.target.id
    const row = store.collaboration(id)
    if (row !== undefined) {
      const { awaiting_approval: _a, ...rest } = row
      store.saveCollaboration({ ...rest, last_activity_at: clock.now() })
    } else {
      const creator_id = str(after.creator_id)
      if (creator_id === undefined || store.creator(creator_id) === undefined)
        return failed('库里找不到这个红人了，这条合作没建。')
      store.saveCollaboration({
        id,
        creator_id,
        channel: (str(after.channel) ?? 'youtube') as KolChannel,
        stage: 'sourced',
        currency: str(after.currency) ?? 'USD',
        ...(typeof after.budget === 'number' ? { budget: after.budget } : {}),
        ...(typeof after.campaign_id === 'string' ? { campaign_id: after.campaign_id } : {}),
        last_activity_at: clock.now(),
      })
    }
    const back = store.collaboration(id)
    if (back === undefined || back.awaiting_approval === true)
      return failed('写进去之后读回不对，这条合作没建成。')
    emit('kol.collaboration_created', { collaboration_id: id, change_id: change.id })
    return {
      status: 'ok',
      execution_id: `kol_collab_${change.id}`,
      outcome_ref: { type: 'collaboration', id },
    }
  }

  /* ── 4. 验收结论卡 ───────────────────────────────────────────────── */

  const applyReview = (change: StagedChange): BackendResult | undefined => {
    if (change.target.type !== 'deliverable') return undefined
    const after = rec(change.after)
    const review = str(after.review) as Deliverable['review'] | undefined
    if (review === undefined) return failed('卡上没有验收结论，没改。')
    const row = store.deliverables().find((d) => d.id === change.target.id)
    if (row === undefined) return failed('库里找不到这件交付物了，没改。')
    const notes = str(after.notes)
    store.saveDeliverable({ ...row, review, ...(notes === undefined ? {} : { notes }) })
    const back = store.deliverables().find((d) => d.id === row.id)
    if (back?.review !== review) return failed('写进去之后读回不对，验收结论没改成。')
    const collab = store.collaboration(row.collaboration_id)
    if (collab !== undefined) store.saveCollaboration({ ...collab, last_activity_at: clock.now() })
    emit('kol.deliverable_review_applied', { deliverable_id: row.id, review })
    return {
      status: 'ok',
      execution_id: `kol_review_${change.id}`,
      outcome_ref: { type: 'deliverable', id: row.id },
    }
  }

  /* ── 2. 回信 ─────────────────────────────────────────────────────── */

  /** 我们发出去的每一封的 Message-ID → 那条往来。 */
  const sentById = (): Map<string, KolExchange> => {
    const out = new Map<string, KolExchange>()
    for (const x of store.exchanges())
      if (x.direction === 'out' && x.mail_message_id !== undefined)
        out.set(normId(x.mail_message_id), x)
    return out
  }

  const creatorByAddress = (address: string): string | undefined => {
    const key = suppressionKey(address)
    for (const c of store.contacts()) {
      if (c.kind !== 'email') continue
      const value = reveal(c.value_ref)
      if (value !== undefined && suppressionKey(value) === key) return c.creator_id
    }
    return undefined
  }

  const intake = (mail: KolInboundMail): KolInboundResult => {
    const sent = sentById()
    const ids = [mail.in_reply_to, ...(mail.references ?? [])].filter(
      (x): x is string => typeof x === 'string' && x.trim() !== '',
    )
    const hit = ids.map((id) => sent.get(normId(id))).find((x) => x !== undefined)
    const creator_id = hit?.creator_id ?? creatorByAddress(mail.from_email)
    if (creator_id === undefined || store.creator(creator_id) === undefined)
      return { matched: false }
    // 同一封信只记一次（按对方的 Message-ID）
    if (mail.message_id !== undefined) {
      const seen = normId(mail.message_id)
      const dup = store
        .exchanges({ creator_id })
        .find(
          (x) => x.direction === 'in' && x.mail_message_id && normId(x.mail_message_id) === seen,
        )
      if (dup !== undefined)
        return {
          matched: true,
          creator_id,
          ...(dup.collaboration_id === undefined ? {} : { collaboration_id: dup.collaboration_id }),
        }
    }
    const collab =
      (hit?.collaboration_id === undefined
        ? undefined
        : store.collaboration(hit.collaboration_id)) ??
      (hit === undefined ? undefined : openCollab(creator_id, hit.channel)) ??
      store
        .collaborations()
        .find((c) => c.creator_id === creator_id && c.stage !== 'closed' && c.stage !== 'declined')
    const known =
      hit !== undefined || store.exchanges({ creator_id }).some((x) => x.direction === 'out')
    const verdict = classifyReply({ text: `${mail.subject}\n${mail.text}`, known_contact: known })
    const at = mail.at ?? clock.now()
    const exchange: KolExchange = {
      id: `xch_in_${(mail.message_id ?? `${creator_id}_${at}`).replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      creator_id,
      ...(collab === undefined ? {} : { collaboration_id: collab.id }),
      channel: collab?.channel ?? hit?.channel ?? 'youtube',
      direction: 'in',
      subject: mail.subject,
      body: mail.text,
      at,
      reply_class: verdict.klass,
      ...(verdict.opt_out ? { opt_out: true } : {}),
      ...(mail.message_id === undefined ? {} : { mail_message_id: mail.message_id }),
      ...(mail.account === undefined ? {} : { mailbox: mail.account }),
    }
    store.saveExchange(exchange)
    let stage: CollaborationStage | undefined
    if (collab !== undefined) {
      const stop = verdict.opt_out || verdict.klass === 'declined'
      /*
       * WP489（决策 1685）：全阶段——对方的信里有报价 / 谈妥 / 单号 / 脚本 / 发布链接就推到那一步（只往前推）。
       * 「不做」仍只在还没谈起来时（已找到 / 已建联）判谢绝：谈到一半的一句 decline 多半是在还价。
       */
      const early = collab.stage === 'sourced' || collab.stage === 'contacted'
      const next = advanceByMail(
        collab.stage,
        { id: exchange.id, direction: 'in', at, subject: mail.subject, text: mail.text },
        { declined: stop && early },
      )
      stage = next?.stage ?? collab.stage
      store.saveCollaboration({
        ...collab,
        stage,
        last_activity_at: at,
        ...(next === undefined
          ? {}
          : {
              stage_source: 'mail' as const,
              ...(next.quote === undefined
                ? {}
                : {
                    stage_evidence: [
                      {
                        message_id: exchange.id,
                        at,
                        direction: 'in' as const,
                        subject: mail.subject,
                        quote: next.quote,
                      },
                    ],
                  }),
            }),
      })
    }
    emit('kol.reply_matched', {
      creator_id,
      ...(collab === undefined ? {} : { collaboration_id: collab.id }),
      reply_class: verdict.klass,
      by: hit === undefined ? 'address' : 'thread',
    })
    return {
      matched: true,
      creator_id,
      ...(collab === undefined ? {} : { collaboration_id: collab.id }),
      reply_class: verdict.klass,
      ...(stage === undefined ? {} : { stage }),
    }
  }

  return {
    connected: () => (options.mail()?.addresses().length ?? 0) > 0,

    async apply(change) {
      if (change.workspace_id !== workspace_id) return undefined
      if (change.kind === 'kol_outreach') return applyOutreach(change)
      if (change.kind === 'kol_collaboration') return applyCollaboration(change)
      if (change.kind === 'kol_deliverable_review') return applyReview(change)
      return undefined
    },

    onDecided(item) {
      if (!isKolCollaborationCard(item) || item.workspace_id !== workspace_id) return
      if (item.state !== 'rejected' && item.state !== 'withdrawn' && item.state !== 'expired')
        return
      const payload = rec(item.payload)
      if (rec(payload.after).collaboration_id !== undefined) return
      const target = item.subject.object
      if (target.type !== 'collaboration') return
      const row = store.collaboration(target.id)
      // 只删「还在等你点头」的那一行；已经生效的合作不因为一张旧卡被删
      if (row === undefined || row.awaiting_approval !== true) return
      store.removeRow('collaboration', row.id)
      emit('kol.collaboration_dropped', { collaboration_id: row.id, state: item.state })
    },

    isOurThread(thread_id, refs) {
      const sent = sentById()
      if (sent.size === 0) return false
      return [thread_id, ...refs].some((id) => sent.has(normId(id)))
    },

    intake,
  }
}
