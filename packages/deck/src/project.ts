/**
 * 36 §2「卡 = 审批项的投影」。
 *
 * 这个文件是 WP15 里唯一一处「审批项 → 界面」的翻译。它不读库、不调模型、不做 IO：
 * 给一条 `ApprovalItem` 就出一张 `DeckCard`，因此六端（工作台 / IM 卡片 / Pet / 移动 …）
 * 拿到的一定是同一份。
 */
import type { ApprovalItem, Iso8601, ObjectRef, RiskClass } from '@agentsws/contracts'
import { actionsFor, labelsFor, minutesFor, riskClassFor } from './matrix.js'
import type {
  DeckCard,
  DeckEvidenceChip,
  DeckHighlight,
  DeckKind,
  DeckOption,
  PriorityBand,
  ProjectContext,
} from './types.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 承诺类词（人看到要警惕的那种句子）；只在模型写的 title / summary 上扫。 */
const COMMITMENT_TERMS = ['保证', '一定', '承诺', '包退', '包换', 'guarantee', 'promise']
/** 风险词。 */
const RISK_TERMS = ['投诉', '拒付', '差评', '升级', '律师', 'chargeback', 'complaint', 'refuse']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isObjectRef = (v: unknown): v is ObjectRef =>
  isRecord(v) && typeof v.type === 'string' && typeof v.id === 'string'

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 金额一律「数值 + 币种」，格式化交给前端的 Intl（数字不经模型手，也不经字符串拼接的四舍五入）。 */
function moneyText(amount: number, currency: string): string {
  return `${amount} ${currency}`
}

/** 从 payload 的结构化字段里挖金额（不同 kind 放的位置不同）。 */
function amountOf(payload: unknown): { amount: number; currency: string } | undefined {
  if (!isRecord(payload)) return undefined
  const money = payload.money
  if (isRecord(money)) {
    const amount = num(money.amount)
    const currency = str(money.currency)
    if (amount !== undefined && currency !== undefined) return { amount, currency }
  }
  const after = payload.after
  if (isRecord(after)) {
    const amount = num(after.refund_amount) ?? num(after.refunded) ?? num(after.amount)
    const currency = str(after.currency) ?? str(payload.currency)
    if (amount !== undefined) return { amount, currency: currency ?? 'USD' }
  }
  return undefined
}

/** 14 §2 subject / payload 上的目标对象。 */
function targetOf(item: ApprovalItem): ObjectRef | undefined {
  const payload = item.payload
  if (isRecord(payload) && isObjectRef(payload.target)) return payload.target
  return item.subject.object
}

export function highlightsOf(item: ApprovalItem, ctx: ProjectContext): DeckHighlight[] {
  const out: DeckHighlight[] = []
  const money = amountOf(item.payload)
  if (money) out.push({ type: 'amount', text: moneyText(money.amount, money.currency) })

  const deadline = item.due_at ?? item.expires_at
  if (deadline !== undefined) out.push({ type: 'deadline', text: deadline })

  const target = targetOf(item)
  if (target !== undefined && (target.type === 'order' || target.type === 'shipment')) {
    out.push({ type: 'order_ref', text: ctx.label?.(target) ?? target.id })
  }

  const text = `${item.title}\n${item.summary}`
  for (const term of COMMITMENT_TERMS) {
    if (text.includes(term)) {
      out.push({ type: 'commitment', text: term })
      break
    }
  }
  for (const term of RISK_TERMS) {
    if (text.includes(term)) {
      out.push({ type: 'risk_term', text: term })
      break
    }
  }
  for (const cap of item.automation.mandate_check.caps_hit) {
    out.push({ type: 'risk_term', text: cap })
  }
  return out
}

/** 证据芯片：i18n key + 出处 ref（36 §2.1）。 */
export function evidenceChipsOf(item: ApprovalItem): DeckEvidenceChip[] {
  const out: DeckEvidenceChip[] = []
  const p = item.evidence.precheck
  const values = Object.values(p).filter((v) => typeof v === 'string') as string[]
  if (values.length > 0) {
    const bad = values.some((v) => v === 'fail' || v === 'block')
    const warn = values.some((v) => v === 'review' || v === 'empty')
    out.push({
      label_key: bad
        ? 'evidence.precheck.fail'
        : warn
          ? 'evidence.precheck.warn'
          : 'evidence.precheck.ok',
    })
  }
  if (item.evidence.diff !== undefined) out.push({ label_key: 'evidence.diff' })
  for (const c of item.evidence.citations ?? []) {
    out.push({ label_key: 'evidence.citation', ref: { type: 'fact_card', id: c.fact_card_id } })
  }
  // provenance.seen = 本次运行「见过」的 id（15 §6）；只露前四个，够人判断「它读过单没有」。
  for (const ref of item.evidence.provenance.seen.slice(0, 4)) {
    out.push({ label_key: 'evidence.seen', ref })
  }
  if (item.evidence.run_id !== undefined) {
    out.push({ label_key: 'evidence.run', ref: { type: 'work_item', id: item.evidence.run_id } })
  }
  return out
}

/**
 * 14 §8 排序：priority → due_at → 等待时长；36 §2.3 把它压成四档。
 *
 * 规则是确定性的、可测的：
 * - `immediate` 通知，或 4 小时内过期 → P0
 * - 高风险，或 24 小时内过期 → P1
 * - 其余进队列的 → P2
 * - 只进日报的 → P3
 */
export function priorityBandOf(
  item: Pick<ApprovalItem, 'priority' | 'expires_at' | 'due_at'>,
  risk: RiskClass,
  now: Iso8601,
): PriorityBand {
  const nowMs = Date.parse(now)
  const deadline = item.due_at ?? item.expires_at
  const left = deadline === undefined ? Number.POSITIVE_INFINITY : Date.parse(deadline) - nowMs
  if (item.priority === 'immediate' || left <= 4 * HOUR) return 'P0'
  if (risk === 'high' || left <= DAY) return 'P1'
  if (item.priority === 'queue') return 'P2'
  return 'P3'
}

const BAND_ORDER: Record<PriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** 队列排序：档位 → 期限 → 等待时长（14 §8）。同分按 id 保证稳定。 */
export function sortCards(cards: DeckCard[]): DeckCard[] {
  return [...cards].sort((a, b) => {
    const band = BAND_ORDER[a.priority_band] - BAND_ORDER[b.priority_band]
    if (band !== 0) return band
    const ea = a.expires_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.expires_at)
    const eb = b.expires_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.expires_at)
    if (ea !== eb) return ea - eb
    const ca = Date.parse(a.detail.created_at)
    const cb = Date.parse(b.detail.created_at)
    if (ca !== cb) return ca - cb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 选择题卡的选项（36 §2.2：`policy_change` 是问句形态）。 */
export function optionsOf(item: ApprovalItem): DeckOption[] | undefined {
  const payload = item.payload
  if (isRecord(payload) && Array.isArray(payload.options)) {
    const parsed: DeckOption[] = []
    for (const raw of payload.options) {
      if (!isRecord(raw)) continue
      const id = str(raw.id)
      const label = str(raw.label)
      if (id !== undefined && label !== undefined) parsed.push({ id, label })
    }
    if (parsed.length > 0) return parsed
  }
  if (item.kind !== 'policy_change') return undefined
  // 没写 options 的 policy_change 仍然是问句：把 before / after 变成两个选项，
  // 这样「裸 approve 被拒」对所有 policy_change 都成立，不会因为 payload 少写一个字段就退化成是非题。
  if (!isRecord(payload)) return undefined
  if (payload.after === undefined && payload.before === undefined) return undefined
  return [
    { id: 'after', label: '按提议改' },
    { id: 'before', label: '维持现状' },
  ]
}

const CHANNEL_OF: Record<string, DeckCard['channel']> = {
  email: 'email',
  whatsapp: 'chat',
  meta_dm: 'chat',
  chat: 'chat',
}

/** 36 §2：审批项 → 卡片。 */
export function projectCard(item: ApprovalItem, ctx: ProjectContext): DeckCard {
  const kind = item.kind as DeckKind
  const risk = ctx.riskClass?.(item) ?? riskClassFor(kind)
  const actions = actionsFor(kind, item.state)
  const options = optionsOf(item)
  const payload = isRecord(item.payload) ? item.payload : {}
  const to = isObjectRef(payload.to) ? payload.to : undefined
  const subject = item.subject.object
  const customer =
    (to === undefined ? undefined : (ctx.label?.(to) ?? to.id)) ??
    (subject.type === 'customer' ? (ctx.label?.(subject) ?? subject.id) : undefined)
  const channel =
    CHANNEL_OF[str(payload.channel) ?? ''] ??
    (kind === 'system_alert' || kind === 'digest' ? 'system' : undefined)

  return {
    id: item.id,
    kind,
    status: item.state,
    priority_band: priorityBandOf(item, risk, ctx.now),
    risk_class: risk,
    title: item.title,
    summary: item.summary,
    position_id: ctx.position_id,
    role_id: item.role_id,
    ...(customer === undefined ? {} : { customer_label: customer }),
    ...(channel === undefined ? {} : { channel }),
    highlights: highlightsOf(item, ctx),
    evidence_chips: evidenceChipsOf(item),
    available_actions: actions,
    action_labels: labelsFor(kind, actions),
    ...(options === undefined ? {} : { options }),
    detail: {
      payload: item.payload,
      precheck: item.evidence.precheck,
      ...(item.evidence.diff === undefined ? {} : { diff: item.evidence.diff }),
      citations: item.evidence.citations ?? [],
      links: item.links,
      created_at: item.created_at,
      updated_at: item.updated_at,
      proposer: item.proposer,
    },
    dedupe_key: item.dedupe_key,
    ...(item.expires_at === undefined ? {} : { expires_at: item.expires_at }),
    ...(item.state === 'deferred' && item.decision?.defer_until !== undefined
      ? { snoozed_until: item.decision.defer_until }
      : {}),
    snooze_count: ctx.snoozeCount?.(item) ?? (item.state === 'deferred' ? 1 : 0),
    version: item.revision,
  }
}

/** 14 §8「今天队列预计 X 分钟」。 */
export function estimatedMinutes(cards: DeckCard[]): number {
  return cards.reduce((sum, c) => sum + minutesFor(c.kind), 0)
}
