/**
 * WP442（docs/108 §5.3 / M4，Luoye 10-21）：**回信跟进**——你或岗位发出去的信，对方是真人、N 个工作日没回 → 出卡
 * 「X 还没回，要不要催？」附一封催促草稿。
 *
 * ```text
 * 巡检（挂在客服回复时限那一拍上，自己一小时最多跑一次）
 *   │  已发 30 天内的会话 + 账上在跟的
 *   ├─ followUpCandidate：最后一封是我们发的、对方是真人、不在别的跟进里（红人 / B2B 序列、客服）
 *   ├─ followUpDue：默认 N 个工作日（催过翻倍）/ 对方说过哪天答复 → 那天再过 1 个工作日 / 再等等
 *   └─ 到点 → 起草（按对方语言、接口吻、短；没接模型用模板）→ outbound_draft 卡（form = follow_up_nudge）
 *        会话归岗位 → 那个岗位的人；没归属 → 品牌里第一个持岗位的人（卡在消息页「等对方回」批，决策 1452）
 *
 * 卡上：发出（审批总线 → 执行器 → 这里的 deliver → 已连邮箱 sendMail：急停 / outbox 幂等，即出站门）
 *       修改（卡上改字，带着改过的那一版批）/ 再等等（顺延 3 个工作日）/ 不用跟了
 * 对方来信 → 卡撤掉（expireNow）、这条跟进收掉。一个会话同一时刻只有一张；最多提醒两次。
 * ```
 *
 * 落盘 `message-follow-up.json`（系统规则的设置 + 每条在跟的会话一行）；事件只带计数、会话 id 的哈希，
 * 不带正文与邮箱地址（与消息那一层同一条纪律）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MessageStore } from '@agentsws/channels'
import {
  addBusinessDays,
  aggregateThreads,
  businessDaysBetween,
  followUpCandidate,
  followUpDue,
  nudgeSubject,
  nudgeTemplate,
  ownText,
} from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  EventEnvelope,
  FollowUpNudgePayload,
  Halt,
  Iso8601,
  MessageAddress,
  MessageFollowUp,
  MessageFollowUpAction,
  MessageFollowUpBasis,
  MessageFollowUpRow,
  MessageFollowUpSettings,
  MessageFollowUpSettingsPatch,
  MessageRecord,
  ModelGateway,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  FOLLOW_UP_CARD_FORM,
  FOLLOW_UP_DEFAULT_BUSINESS_DAYS,
  FOLLOW_UP_LOOKBACK_DAYS,
  FOLLOW_UP_MAX_BUSINESS_DAYS,
  FOLLOW_UP_MAX_REMINDERS,
  FOLLOW_UP_MIN_BUSINESS_DAYS,
  FOLLOW_UP_WAIT_BUSINESS_DAYS,
  isFollowUpNudgePayload,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { type BackendResult, finalPayload } from '@agentsws/txn'
import type { DirectMailInput, DirectMailResult } from './channels.js'
import { replyLanguage } from './reply-language.js'

export const FOLLOW_UP_FILE = 'message-follow-up.json'
/** 巡检挂在客服回复时限那一拍（一刻钟）上，自己一小时最多真跑一次（docs/108：一小时一次足够）。 */
export const FOLLOW_UP_SWEEP_EVERY_MS = 60 * 60_000
/** 一轮最多看多少封已发的（新的在前）。 */
const SENT_SCAN_LIMIT = 1000
/** 草稿最长多少字（模型偶尔写长，截一下）。 */
const DRAFT_LIMIT = 1200
/** 卡上「你上次发的」那一段最长多少字。 */
const QUOTE_LIMIT = 280

/** 压成一行、截到 `limit`（不在词中间截断；截了加省略号）。 */
function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** 卡给谁。 */
export interface FollowUpPosition {
  person_id: PersonId
  assignment_id: string
  role_id: RoleId | string
}

export interface MessageFollowUpOptions {
  workspace_id: WorkspaceId
  clock: Clock
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 消息库（这个品牌的整只邮箱）。 */
  store: MessageStore
  /** 现在连着的邮箱地址（「我们发的」、按邮箱分开设）。 */
  accounts(): readonly string[]
  /** 品牌时区（分钟偏移）。 */
  tz(): number
  /** 宿主说这条会话在别的跟进里（红人 / B2B 开发信序列）。 */
  otherFollowUp?(thread_id: string, refs: readonly string[]): boolean
  /**
   * 卡给谁：会话归某岗位 → 做那个岗位的人；没归属（`undefined`）→ 品牌里第一个持岗位的人。
   * 回 `undefined` = 没人可给，不出卡（下一拍再看）。
   */
  recipientFor(position_id: string | undefined): FollowUpPosition | undefined
  /** 卡片出口（同一条审批总线）。 */
  approvals: {
    create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
    get(id: string): Promise<ApprovalItem | undefined>
    expireNow?(id: string, reason: string): Promise<ApprovalItem | undefined>
  }
  /** 批了的卡过了取消窗口就施行（`txn.executor.applyApproval`）。 */
  applyApproval?(item_id: string): Promise<unknown>
  /** 取消窗口（毫秒；与 txn 策略同一个数）。 */
  cancelWindowMs?: number
  /** 已连邮箱发信（`channels.sendMail`：急停、outbox 幂等）。 */
  sendMail?(input: DirectMailInput): Promise<DirectMailResult>
  halt: Halt
  /** 起草用的模型（便宜档）；不给或 `modelReady()` 为假 → 模板。 */
  models?: ModelGateway
  modelReady?(): boolean
  /** 品牌 / 岗位口吻（同回复建议那一份）。 */
  voice?(position_id: string | undefined): string | undefined | Promise<string | undefined>
  /** 判不出对方语言时退回的品牌默认语言。 */
  brandLanguage?(): string | undefined
  /** 给了就落盘。 */
  dbDir?: string
}

/** 账上一行（一条在跟的会话）。 */
interface Row {
  thread_id: string
  account: string
  subject: string
  /** 我们最后发出那一封（库里那条记录的 id / 时间 / Message-ID）。 */
  anchor_id: string
  anchor_at: Iso8601
  anchor_message_id?: string
  waiting_on: MessageAddress
  nudges: number
  state: MessageFollowUp['state']
  basis: MessageFollowUpBasis
  due_at: Iso8601
  business_days: number
  promised_reply_at?: Iso8601
  wait_until?: Iso8601
  nudged_at?: Iso8601
  /** 经卡发出去的那几封的 Message-ID（「已发送」同步回来时认得出是我们催的，不当成新的一轮）。 */
  nudge_message_ids: string[]
  card_id?: string
  position_id?: string
  stopped_reason?: 'user' | 'max'
  updated_at: Iso8601
}

interface SettingsShape {
  enabled: boolean
  business_days: number
  accounts: Record<string, { enabled?: boolean; business_days?: number }>
  updated_at?: Iso8601
  updated_by?: PersonId
}

interface FileShape {
  version: 1
  settings: SettingsShape
  threads: Record<string, Row>
  last_sweep_at?: Iso8601
}

export interface FollowUpSweepReport {
  scanned: number
  /** 这一轮新出的卡。 */
  carded: number
  /** 对方回了 / 我们又发了新的 → 收掉的（含撤掉的卡）。 */
  closed: number
  /** 提醒满了停下的。 */
  stopped: number
  /** 批了、过了取消窗口、这一轮补施行的。 */
  applied: number
}

export interface MessageFollowUpService {
  /** 这条会话的跟进状态（列表 / 会话上那一格）。不在跟的回 `undefined`。 */
  of(thread_id: string): MessageFollowUp | undefined
  /** 「等对方回」那一堆（WP459 消息页）：在等的 + 出了卡的，到期早的在前。 */
  rows(): MessageFollowUpRow[]
  settings(): MessageFollowUpSettings
  setSettings(patch: MessageFollowUpSettingsPatch, by: PersonId): MessageFollowUpSettings
  /** 「等对方回」那一行上直接点的（不用跟了 / 再等等 / 接着跟 / 现在就催）。 */
  act(
    thread_id: string,
    action: MessageFollowUpAction,
    by: PersonId,
  ): Promise<MessageFollowUp | undefined>
  /** 来了一封信（同步分拣那一拍）：是在跟的会话 → 撤卡、收掉。 */
  noteInbound(record: Pick<MessageRecord, 'thread_id' | 'date' | 'from' | 'account'>): Promise<void>
  /** 巡检一轮（测试与「现在就看」直接调）。 */
  sweep(): Promise<FollowUpSweepReport>
  /** 挂在客服回复时限那一拍上：离上一轮不到一小时就不跑。 */
  sweepIfDue(): Promise<FollowUpSweepReport | undefined>
  /** 执行器（`deliverOutbound`）：是催促卡就从原邮箱在原会话里回一封；不是回 `undefined`。 */
  deliver(item: ApprovalItem, opts: { idempotencyKey: string }): Promise<BackendResult | undefined>
  /** 卡定了（`server.ts` 的决定钩子）：批了 → 过取消窗口施行；再等等 → 撤卡顺延；不用跟了 → 停。 */
  onDecided(item: ApprovalItem): Promise<void>
  close(): void
}

/** 这张卡是不是催促卡。 */
export function isFollowUpCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'outbound_draft' && isFollowUpNudgePayload(item.payload)
}

const DAY_MS = 86_400_000
const OPEN_CARD = new Set(['pending', 'in_review', 'deferred', 'blocked'])
const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved'])
/** 没有岗位意义的「交给」（自己处理 / 只是通知 / 老数据）。 */
const NOT_A_POSITION = new Set(['me', 'notice', 'position'])

const clampDays = (n: number): number =>
  Math.min(FOLLOW_UP_MAX_BUSINESS_DAYS, Math.max(FOLLOW_UP_MIN_BUSINESS_DAYS, Math.round(n)))

const hashOf = (s: string): string => sha256(s).slice(0, 16)

function defaultFile(): FileShape {
  return {
    version: 1,
    settings: { enabled: true, business_days: FOLLOW_UP_DEFAULT_BUSINESS_DAYS, accounts: {} },
    threads: {},
  }
}

export function createMessageFollowUp(options: MessageFollowUpOptions): MessageFollowUpService {
  const { workspace_id, clock } = options
  const path = options.dbDir === undefined ? undefined : join(options.dbDir, FOLLOW_UP_FILE)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let seq = 0

  const load = (): FileShape => {
    if (path === undefined || !existsSync(path)) return defaultFile()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileShape>
      const base = defaultFile()
      return {
        version: 1,
        settings: { ...base.settings, ...(raw.settings ?? {}) },
        threads: raw.threads ?? {},
        ...(raw.last_sweep_at === undefined ? {} : { last_sweep_at: raw.last_sweep_at }),
      }
    } catch {
      return defaultFile()
    }
  }
  const file = load()
  const save = (): void => {
    if (path === undefined) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(file, null, 2))
    } catch {
      // 落盘失败不挡巡检：下一次改动再写
    }
  }

  const emit = (type: string, thread_id: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'messages.follow_up' },
      correlation: { trace_id: `tr_follow_up_${hashOf(thread_id)}_${clock.now()}` },
      // 只带会话 id 的哈希与计数：不打正文、不打邮箱地址
      payload: { thread: hashOf(thread_id), ...payload },
    })
  }

  /* ── 设置（系统规则） ─────────────────────────────────────────────── */

  const effective = (account: string): { enabled: boolean; business_days: number } => {
    const s = file.settings
    const a = s.accounts[account.trim().toLowerCase()]
    return {
      enabled: a?.enabled ?? s.enabled,
      business_days: clampDays(a?.business_days ?? s.business_days),
    }
  }

  const settingsView = (): MessageFollowUpSettings => {
    const s = file.settings
    return {
      enabled: s.enabled,
      business_days: clampDays(s.business_days),
      accounts: Object.entries(s.accounts).map(([account, v]) => ({
        account,
        ...(v.enabled === undefined ? {} : { enabled: v.enabled }),
        ...(v.business_days === undefined ? {} : { business_days: clampDays(v.business_days) }),
      })),
      // 连着的邮箱 + 账上在跟的会话用到的邮箱（演示 / 刚断开的那只也能单独设）
      mailboxes: [
        ...new Set([
          ...options.accounts().map((a) => a.trim().toLowerCase()),
          ...Object.values(file.threads).map((r) => r.account.trim().toLowerCase()),
        ]),
      ],
      ...(s.updated_at === undefined ? {} : { updated_at: s.updated_at }),
      ...(s.updated_by === undefined ? {} : { updated_by: s.updated_by }),
    }
  }

  /* ── 一行的视图 ──────────────────────────────────────────────────── */

  const viewOf = (row: Row): MessageFollowUp => ({
    due_at: row.due_at,
    nudges: row.nudges,
    state: row.state,
    basis: row.basis,
    since:
      row.nudged_at !== undefined && row.nudged_at > row.anchor_at ? row.nudged_at : row.anchor_at,
    waiting_on: row.waiting_on,
    business_days: row.business_days,
    ...(row.promised_reply_at === undefined ? {} : { promised_reply_at: row.promised_reply_at }),
    ...(row.card_id === undefined || row.state !== 'carded' ? {} : { card_id: row.card_id }),
    ...(row.position_id === undefined ? {} : { position_id: row.position_id }),
  })

  const recompute = (row: Row): void => {
    const due = followUpDue({
      anchor_at: row.anchor_at,
      ...(row.nudged_at === undefined ? {} : { nudged_at: row.nudged_at }),
      nudges: row.nudges,
      business_days: row.business_days,
      ...(row.promised_reply_at === undefined ? {} : { promised_reply_at: row.promised_reply_at }),
      ...(row.wait_until === undefined ? {} : { wait_until: row.wait_until }),
      tz: options.tz(),
    })
    row.due_at = due.due_at
    row.basis = due.basis
  }

  /** 撤掉还开着的那张卡（对方回了 / 我们又发了 / 再等等 / 不用跟了）。 */
  const withdrawCard = async (row: Row, reason: string): Promise<boolean> => {
    const id = row.card_id
    if (id === undefined) return false
    const item = await options.approvals.get(id).catch(() => undefined)
    if (item === undefined || !OPEN_CARD.has(item.state)) return false
    const out = await options.approvals.expireNow?.(id, reason).catch(() => undefined)
    return out !== undefined
  }

  /* ── 起草 ────────────────────────────────────────────────────────── */

  const NUDGE_SYSTEM = [
    '你替发件人写一封很短的跟进邮件：上次发出去的信对方还没回，礼貌地问一下进展。',
    '用 `lang` 那种语言写（ISO 639-1：zh = 中文、en = 英文……）。2–4 句，称呼对方（有名字就用名），',
    '提一句上次说的是什么事（看 `subject` 与 `our_last`），问有没有进展、方便时回一句。',
    '不要编造任何新的价格、日期、承诺、折扣；不要主题行；不要解释；只输出正文。',
    '`voice` 不为空时是这个品牌的说话方式（语气、用词、签名），照它写；`reminder` = 2 表示这是第二次催，语气再轻一点。',
  ].join('\n')

  const draft = async (input: {
    lang: string
    subject: string
    waiting_on: MessageAddress
    reminder: number
    our_last: string
    their_last?: string
    position?: FollowUpPosition
    position_id?: string
  }): Promise<string> => {
    const fallback = (): string =>
      nudgeTemplate({
        lang: input.lang,
        waiting_on: input.waiting_on,
        subject: input.subject,
        reminder: input.reminder,
      })
    const models = options.models
    if (models === undefined || options.modelReady?.() !== true) return fallback()
    try {
      const voice = await Promise.resolve(options.voice?.(input.position_id)).catch(() => undefined)
      const completion = await models.complete({
        messages: [
          { role: 'system', content: NUDGE_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              lang: input.lang,
              subject: input.subject,
              to_name: input.waiting_on.name ?? '',
              our_last: input.our_last.slice(0, 600),
              their_last: (input.their_last ?? '').slice(0, 400),
              reminder: input.reminder,
              voice: voice ?? '',
            }),
          },
        ],
        meta: {
          workspace_id,
          assignment_id: (input.position?.assignment_id ?? 'asg_unknown') as never,
          role_id: (input.position?.role_id ?? 'common.member') as never,
          run_id: 'run_message_follow_up' as never,
          purpose: 'extraction',
        },
      })
      const text = completion.text
        .replace(/^```[a-z]*\n?|```$/gim, '')
        .trim()
        .slice(0, DRAFT_LIMIT)
      return text === '' ? fallback() : text
    } catch {
      return fallback()
    }
  }

  /* ── 出卡 ────────────────────────────────────────────────────────── */

  const card = async (row: Row, messages: readonly MessageRecord[]): Promise<boolean> => {
    const position = options.recipientFor(row.position_id)
    if (position === undefined) return false
    const now = clock.now()
    const tz = options.tz()
    const sorted = [...messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    const anchor = sorted.find((m) => m.id === row.anchor_id) ?? sorted[sorted.length - 1]
    if (anchor === undefined) return false
    const theirs = [...sorted]
      .reverse()
      .find((m) => m.from.email.trim().toLowerCase() === row.waiting_on.email.trim().toLowerCase())
    const reminder = row.nudges + 1
    const ourLast = ownText(anchor.text).trim()
    // 按对方语言：对方来过信就看对方最近那封，没来过就看我们自己那封（同一种语言往来）
    const lang = replyLanguage(
      theirs === undefined ? `${anchor.subject}\n${ourLast}` : ownText(theirs.text),
      options.brandLanguage?.(),
    )
    const text = await draft({
      lang,
      subject: row.subject,
      waiting_on: row.waiting_on,
      reminder,
      our_last: ourLast,
      ...(theirs === undefined ? {} : { their_last: ownText(theirs.text) }),
      position,
      ...(row.position_id === undefined ? {} : { position_id: row.position_id }),
    })
    const since =
      row.nudged_at !== undefined && row.nudged_at > row.anchor_at ? row.nudged_at : row.anchor_at
    const waited = businessDaysBetween(since, now, tz)
    // 收件人：我们上一封的收件人（不含自己的邮箱）
    const own = new Set(options.accounts().map((a) => a.trim().toLowerCase()))
    own.add(row.account.trim().toLowerCase())
    const recipients = anchor.to.filter((a) => !own.has(a.email.trim().toLowerCase()))
    const cc = anchor.cc.filter((a) => !own.has(a.email.trim().toLowerCase()))
    const references = sorted.flatMap((m) => (m.message_id === undefined ? [] : [m.message_id]))
    const inReplyTo = row.nudge_message_ids[row.nudge_message_ids.length - 1] ?? anchor.message_id
    const toRef = {
      type: 'contact' as const,
      id: row.waiting_on.email,
      email: row.waiting_on.email,
    }
    const threadRef = { type: 'thread' as const, id: row.thread_id }
    const payload: FollowUpNudgePayload = {
      form: FOLLOW_UP_CARD_FORM,
      channel: 'email',
      thread_ref: row.thread_id,
      account: row.account,
      to: toRef,
      recipients: recipients.length === 0 ? [row.waiting_on] : recipients,
      ...(cc.length === 0 ? {} : { cc }),
      ...(inReplyTo === undefined ? {} : { in_reply_to: inReplyTo }),
      ...(references.length === 0 ? {} : { references }),
      body: { subject: nudgeSubject(row.subject), text },
      lang,
      ...(ourLast === '' ? {} : { quote: excerpt(ourLast, QUOTE_LIMIT) }),
      follow_up: {
        thread_id: row.thread_id,
        waiting_on: row.waiting_on,
        since,
        business_days: row.business_days,
        waited_business_days: waited,
        basis: row.basis,
        ...(row.promised_reply_at === undefined
          ? {}
          : { promised_reply_at: row.promised_reply_at }),
        reminder,
        nudges: row.nudges,
        ...(row.position_id === undefined ? {} : { position_id: row.position_id }),
      },
      surface: row.position_id === undefined ? 'messages' : 'position',
    }
    const who = row.waiting_on.name?.trim() || row.waiting_on.email
    const promisedDay =
      row.promised_reply_at === undefined
        ? undefined
        : new Date(Date.parse(row.promised_reply_at) + tz * 60_000).toISOString().slice(5, 10)
    const title =
      row.basis === 'promised' && promisedDay !== undefined
        ? `${who} 说 ${promisedDay} 答复，还没回`
        : `${who} 还没回（${waited} 个工作日）`
    seq += 1
    const participants = [
      ...new Set([row.waiting_on.email, ...payload.recipients.map((a) => a.email)]),
    ]
    const item = await options.approvals.create<FollowUpNudgePayload>({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: position.role_id as RoleId,
      subject: { object: threadRef },
      // 每张卡一个键（「一个会话同一时刻只一张」由账上的 card_id 管：出过卡的会话巡检不再出）
      dedupe_key: `${workspace_id}:follow_up:${hashOf(row.thread_id)}:${hashOf(row.anchor_id)}:${row.nudges}:${now}:${seq}`,
      title,
      summary: `「${row.subject}」`,
      payload,
      evidence: {
        run_id: `run_follow_up_${hashOf(row.thread_id)}_${seq}`,
        source_events: [],
        provenance: { seen: [threadRef, { type: 'contact', id: row.waiting_on.email }] },
        precheck: {},
      },
      proposer: { kind: 'system', id: 'messages.follow_up' },
      automation: {
        // 催促是往外发的：一律人批（docs/108 M2）
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: position.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      context: { thread_participants: participants, verified_contacts: [] },
    })
    row.card_id = item.id
    row.state = 'carded'
    row.updated_at = now
    emit('message.follow_up_due', row.thread_id, {
      card_id: item.id,
      reminder,
      basis: row.basis,
      waited_business_days: waited,
      ...(row.position_id === undefined ? {} : { position_id: row.position_id }),
    })
    return true
  }

  /* ── 一条会话过一遍 ──────────────────────────────────────────────── */

  type Outcome = 'none' | 'carded' | 'closed' | 'stopped' | 'applied'

  const evaluate = async (thread_id: string, opts: { force?: boolean } = {}): Promise<Outcome> => {
    const now = clock.now()
    const messages = await options.store.thread(thread_id)
    const refs = [...new Set(messages.flatMap((m) => m.references))]
    const cand = followUpCandidate(messages, {
      now,
      lookback_days: FOLLOW_UP_LOOKBACK_DAYS,
      ownAddresses: options.accounts(),
      otherFollowUp: options.otherFollowUp?.(thread_id, refs) === true,
    })
    let row = file.threads[thread_id]
    if (!cand.ok) {
      if (row === undefined) return 'none'
      // 太老了：还开着的卡留着让人定，账上的等待收掉
      if (cand.reason === 'stale' && row.state === 'carded') return 'none'
      const withdrawn = await withdrawCard(row, `follow_up_${cand.reason}`)
      delete file.threads[thread_id]
      emit('message.follow_up_closed', thread_id, {
        reason: cand.reason,
        card_withdrawn: withdrawn,
      })
      return 'closed'
    }
    const setting = effective(cand.account)
    if (!setting.enabled) {
      // 这只邮箱关了跟进：还在等的收掉，已经出的卡留着让人定
      if (row !== undefined && row.state !== 'carded') delete file.threads[thread_id]
      return 'none'
    }
    const anchor = cand.anchor
    const ours =
      anchor.message_id !== undefined && row?.nudge_message_ids.includes(anchor.message_id) === true
    if (row !== undefined && row.anchor_id !== anchor.id && !ours) {
      // 我们自己又发了一封（不是经卡催的那封）→ 新的一轮：旧卡撤掉，从头数
      const withdrawn = await withdrawCard(row, 'follow_up_new_outbound')
      emit('message.follow_up_closed', thread_id, {
        reason: 'new_outbound',
        card_withdrawn: withdrawn,
      })
      row = undefined
    }
    const position = aggregateThreads(messages)[0]?.handed_to
    const position_id =
      position === undefined || NOT_A_POSITION.has(position) ? undefined : position
    if (row === undefined) {
      row = {
        thread_id,
        account: cand.account,
        subject: anchor.subject,
        anchor_id: anchor.id,
        anchor_at: anchor.date,
        ...(anchor.message_id === undefined ? {} : { anchor_message_id: anchor.message_id }),
        waiting_on: cand.waiting_on,
        nudges: 0,
        state: 'waiting',
        basis: 'default',
        due_at: anchor.date,
        business_days: setting.business_days,
        nudge_message_ids: [],
        updated_at: now,
      }
      file.threads[thread_id] = row
    } else if (ours) {
      // 「已发送」同步回来的是我们经卡催的那封：钉到它上面，次数照旧
      row.anchor_id = anchor.id
      row.anchor_at = anchor.date
      if (anchor.message_id !== undefined) row.anchor_message_id = anchor.message_id
    }
    row.business_days = setting.business_days
    row.waiting_on = cand.waiting_on
    if (cand.promised_reply_at === undefined) delete row.promised_reply_at
    else row.promised_reply_at = cand.promised_reply_at
    if (position_id === undefined) delete row.position_id
    else row.position_id = position_id
    row.updated_at = now

    // 账上说出了卡：卡现在什么样
    if (row.state === 'carded' && row.card_id !== undefined) {
      const item = await options.approvals.get(row.card_id).catch(() => undefined)
      const state = item?.state
      if (
        state !== undefined &&
        (OPEN_CARD.has(state) ||
          APPROVED.has(state) ||
          state === 'applying' ||
          state === 'apply_failed')
      ) {
        if (state === 'deferred') await waitOn(row, 'card_deferred')
        else if (APPROVED.has(state) && (await tryApply(row.card_id))) return 'applied'
        return 'none'
      }
      if (state === 'rejected') {
        row.state = 'stopped'
        row.stopped_reason = 'user'
        return 'stopped'
      }
      if (state === 'applied') {
        // 发出去了、但 deliver 那一拍没记上（进程在中间重启）：照「催过一次」记
        if (item !== undefined) noteNudged(row, item.updated_at, undefined)
      } else {
        // 卡没了（放到过期 / 被撤回）：当成「再等等」——顺延 3 个工作日再出，不当场又冒一张
        await waitOn(row, 'card_gone')
        return 'none'
      }
    }
    if (row.state === 'stopped') return 'none'
    recompute(row)
    if (!opts.force && Date.parse(now) < Date.parse(row.due_at)) return 'none'
    if (row.nudges >= FOLLOW_UP_MAX_REMINDERS) {
      row.state = 'stopped'
      row.stopped_reason = 'max'
      emit('message.follow_up_stopped', thread_id, { reason: 'max', nudges: row.nudges })
      return 'stopped'
    }
    return (await card(row, messages)) ? 'carded' : 'none'
  }

  /** 催过一次（经卡发出去了）：次数 +1，从这一封开始重新等；满了就停。 */
  const noteNudged = (row: Row, at: Iso8601, message_id: string | undefined): void => {
    row.nudges += 1
    row.nudged_at = at
    if (message_id !== undefined && !row.nudge_message_ids.includes(message_id))
      row.nudge_message_ids.push(message_id)
    delete row.card_id
    delete row.wait_until
    row.updated_at = clock.now()
    if (row.nudges >= FOLLOW_UP_MAX_REMINDERS) {
      row.state = 'stopped'
      row.stopped_reason = 'max'
    } else row.state = 'waiting'
    recompute(row)
  }

  /** 「再等等」：撤卡，顺延 3 个工作日。 */
  const waitOn = async (row: Row, reason: string): Promise<void> => {
    await withdrawCard(row, 'follow_up_wait')
    row.wait_until = addBusinessDays(clock.now(), FOLLOW_UP_WAIT_BUSINESS_DAYS, options.tz())
    row.state = 'waiting'
    delete row.card_id
    delete row.stopped_reason
    row.updated_at = clock.now()
    recompute(row)
    emit('message.follow_up_waited', row.thread_id, { reason, until: row.wait_until })
  }

  const tryApply = async (item_id: string): Promise<boolean> => {
    if (options.applyApproval === undefined) return false
    try {
      await options.applyApproval(item_id)
      return true
    } catch {
      // 取消窗口没过 / 已经施行过 / 被撤了：下一轮再说
      return false
    }
  }

  const rowByCard = (card_id: string): Row | undefined =>
    Object.values(file.threads).find((r) => r.card_id === card_id)

  /* ── 巡检 ────────────────────────────────────────────────────────── */

  const sweep = async (): Promise<FollowUpSweepReport> => {
    const now = clock.now()
    const report: FollowUpSweepReport = { scanned: 0, carded: 0, closed: 0, stopped: 0, applied: 0 }
    const floor = Date.parse(now) - FOLLOW_UP_LOOKBACK_DAYS * DAY_MS
    const sent = await options.store.list({ folder_kind: 'sent', limit: SENT_SCAN_LIMIT })
    const ids = new Set<string>(Object.keys(file.threads))
    for (const m of sent) if (Date.parse(m.date) >= floor) ids.add(m.thread_id)
    for (const thread_id of ids) {
      report.scanned += 1
      try {
        const out = await evaluate(thread_id)
        if (out === 'carded') report.carded += 1
        else if (out === 'closed') report.closed += 1
        else if (out === 'stopped') report.stopped += 1
        else if (out === 'applied') report.applied += 1
      } catch {
        // 一条会话出错不挡别的
      }
    }
    file.last_sweep_at = now
    save()
    return report
  }

  return {
    of(thread_id) {
      const row = file.threads[thread_id]
      return row === undefined ? undefined : viewOf(row)
    },

    rows() {
      return Object.values(file.threads)
        .filter((r) => r.state !== 'stopped')
        .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))
        .map((r) => ({
          thread_id: r.thread_id,
          subject: r.subject,
          account: r.account,
          last_message_id: r.anchor_id,
          follow_up: viewOf(r),
        }))
    },

    settings: settingsView,

    setSettings(patch, by) {
      const s = file.settings
      if (patch.account !== undefined && patch.account.trim() !== '') {
        const key = patch.account.trim().toLowerCase()
        if (patch.reset === true) delete s.accounts[key]
        else {
          const prev = s.accounts[key] ?? {}
          s.accounts[key] = {
            ...prev,
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.business_days === undefined
              ? {}
              : { business_days: clampDays(patch.business_days) }),
          }
        }
      } else {
        if (patch.enabled !== undefined) s.enabled = patch.enabled
        if (patch.business_days !== undefined) s.business_days = clampDays(patch.business_days)
      }
      s.updated_at = clock.now()
      s.updated_by = by
      // 天数改了：在等的那几条按新天数重算到期（出了卡的不动）
      for (const row of Object.values(file.threads)) {
        if (row.state !== 'waiting') continue
        row.business_days = effective(row.account).business_days
        recompute(row)
      }
      save()
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'message.follow_up_settings_changed',
        actor: { kind: 'person', id: by },
        correlation: { trace_id: `tr_follow_up_settings_${clock.now()}` },
        payload: {
          enabled: s.enabled,
          business_days: s.business_days,
          per_account: Object.keys(s.accounts).length,
          scope: patch.account === undefined ? 'all' : 'account',
        },
      })
      return settingsView()
    },

    async act(thread_id, action, by) {
      if (file.threads[thread_id] === undefined) await evaluate(thread_id)
      const row = file.threads[thread_id]
      if (row === undefined) return undefined
      if (action === 'stop') {
        await withdrawCard(row, 'follow_up_stopped')
        row.state = 'stopped'
        row.stopped_reason = 'user'
        delete row.card_id
        row.updated_at = clock.now()
        emit('message.follow_up_stopped', thread_id, { reason: 'user', by_person: true })
      } else if (action === 'wait') {
        await waitOn(row, 'user')
      } else if (action === 'resume') {
        if (row.state === 'stopped') {
          row.state = 'waiting'
          delete row.stopped_reason
          recompute(row)
        }
      } else if (action === 'nudge') {
        if (row.state !== 'carded' && row.nudges < FOLLOW_UP_MAX_REMINDERS) {
          row.state = 'waiting'
          delete row.stopped_reason
          await evaluate(thread_id, { force: true })
        }
      }
      void by
      save()
      const after = file.threads[thread_id]
      return after === undefined ? undefined : viewOf(after)
    },

    async noteInbound(record) {
      const row = file.threads[record.thread_id]
      if (row === undefined) return
      // 自己发的（抄送回自己）不算对方回了
      const from = record.from.email.trim().toLowerCase()
      const own = new Set([...options.accounts(), row.account].map((a) => a.trim().toLowerCase()))
      if (own.has(from)) return
      const since =
        row.nudged_at !== undefined && row.nudged_at > row.anchor_at ? row.nudged_at : row.anchor_at
      if (Date.parse(record.date) < Date.parse(since)) return
      const withdrawn = await withdrawCard(row, 'follow_up_replied')
      delete file.threads[record.thread_id]
      save()
      emit('message.follow_up_closed', record.thread_id, {
        reason: 'replied',
        card_withdrawn: withdrawn,
      })
    },

    sweep,

    async sweepIfDue() {
      const last = file.last_sweep_at
      if (
        last !== undefined &&
        Date.parse(clock.now()) - Date.parse(last) < FOLLOW_UP_SWEEP_EVERY_MS
      )
        return undefined
      return sweep()
    },

    async deliver(item, opts) {
      if (item.workspace_id !== workspace_id || item.kind !== 'outbound_draft') return undefined
      const final = finalPayload(item)
      const p = isFollowUpNudgePayload(final)
        ? final
        : isFollowUpNudgePayload(item.payload)
          ? item.payload
          : undefined
      if (p === undefined) return undefined
      if (options.sendMail === undefined)
        return {
          status: 'failed',
          error: {
            message: '没发出去：这台机器还没连邮箱。去「设置 → 账号连接」连上邮箱再发。',
            retryable: false,
          },
        }
      const text = p.body.text.trim()
      if (text === '')
        return {
          status: 'failed',
          error: { message: '没发出去：催促草稿是空的。', retryable: false },
        }
      const sent = await options.sendMail({
        account: p.account,
        to: p.recipients.map((a) => a.email),
        ...(p.cc === undefined || p.cc.length === 0 ? {} : { cc: p.cc.map((a) => a.email) }),
        subject: p.body.subject,
        text,
        ...(p.in_reply_to === undefined ? {} : { in_reply_to: p.in_reply_to }),
        ...(p.references === undefined ? {} : { references: p.references }),
        thread_ref: p.thread_ref,
        idempotency_key: opts.idempotencyKey,
      })
      if (!sent.ok)
        return {
          status: 'failed',
          error: {
            message: `没发出去：${sent.error ?? '邮箱没接住'}`,
            retryable: sent.retryable === true,
          },
        }
      const row = file.threads[p.follow_up.thread_id]
      if (row !== undefined && (row.card_id === undefined || row.card_id === item.id)) {
        noteNudged(row, clock.now(), sent.message_id)
        save()
        emit('message.follow_up_nudged', row.thread_id, {
          card_id: item.id,
          nudges: row.nudges,
          state: row.state,
        })
      }
      return {
        status: 'ok',
        execution_id: sent.message_id,
        outcome_ref: { type: 'thread', id: p.thread_ref },
      }
    },

    async onDecided(item) {
      if (item.workspace_id !== workspace_id || !isFollowUpCard(item)) return
      const row = rowByCard(item.id)
      if (APPROVED.has(item.state)) {
        if (options.applyApproval === undefined) return
        const windowMs = options.cancelWindowMs ?? 120_000
        const t = setTimeout(() => {
          timers.delete(t)
          void tryApply(item.id)
        }, windowMs + 1_000)
        t.unref?.()
        timers.add(t)
        return
      }
      if (row === undefined) return
      if (item.state === 'deferred') {
        await waitOn(row, 'card')
        save()
        return
      }
      if (item.state === 'rejected') {
        row.state = 'stopped'
        row.stopped_reason = 'user'
        delete row.card_id
        row.updated_at = clock.now()
        save()
        emit('message.follow_up_stopped', row.thread_id, { reason: 'user', card_id: item.id })
      }
    },

    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
}
