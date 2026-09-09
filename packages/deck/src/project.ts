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
  DeckContentVariants,
  DeckEntityChip,
  DeckEvidenceChip,
  DeckHighlight,
  DeckKind,
  DeckOption,
  DeckSource,
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

/** 37 §1 第 5 行：证据芯片上限 10 条。 */
export const MAX_EVIDENCE_CHIPS = 10
/** 实体芯片另起一行；也得有个上限，否则一个读了 40 条记录的运行会把卡面撑爆。 */
export const MAX_ENTITY_CHIPS = 8

/**
 * 证据芯片：**只出 i18n key + 展示名 / 计数**（37 §1 第 5 行）。
 *
 * 与 WP15 的差别是硬性的：这里再也不带 `ref`。「读过订单 #1001」里的 `#1001` 是
 * enrichment 查出来的**展示名**；查不到展示名就退成「读了 N 条记录」，绝不退成
 * `ord_1001`。run id 一个字都不进来——它只在 `detail.run_id` 上。
 */
export function evidenceChipsOf(item: ApprovalItem, ctx?: ProjectContext): DeckEvidenceChip[] {
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

  const citations = item.evidence.citations ?? []
  if (citations.length > 0) {
    out.push({ label_key: 'evidence.citation', params: { count: citations.length } })
  }

  // provenance.seen = 本次运行「见过」的对象（15 §6）。人真正想知道的是「它查单了没有」，
  // 所以订单单拎出来说，其余的只报条数。
  const seen = item.evidence.provenance.seen
  const orders = seen.filter((r) => r.type === 'order' || r.type === 'shipment')
  const orderNames = orders
    .map((r) => ctx?.label?.(r))
    .filter((n): n is string => n !== undefined && n !== '')
  if (orderNames.length === 1 && orderNames[0] !== undefined) {
    out.push({ label_key: 'evidence.order_checked', params: { order: orderNames[0] } })
  } else if (orders.length > 0) {
    out.push({ label_key: 'evidence.orders_checked', params: { count: orders.length } })
  }
  const others = seen.length - orders.length
  if (others > 0) out.push({ label_key: 'evidence.records_read', params: { count: others } })

  return out.slice(0, MAX_EVIDENCE_CHIPS)
}

/**
 * 实体芯片：订单 / 客户 / 事实卡…，**带展示名**，另起一行（37 §1 第 5 行）。
 *
 * 29 §2 的 enrichment 在这里落地：`ctx.label` 是以本人身份查出来的展示名，返回
 * `undefined` 就是「这个人看不到这条」——那条 ref 直接丢掉，只在 `dropped` 上记个数。
 * 先给再脱敏是 19 §3 明令禁止的那种做法。
 */
export function entityChipsOf(
  item: ApprovalItem,
  ctx: ProjectContext,
): { chips: DeckEntityChip[]; dropped: number } {
  const refs: ObjectRef[] = [
    item.subject.object,
    ...item.evidence.provenance.seen,
    ...(item.evidence.citations ?? []).map(
      (c): ObjectRef => ({ type: 'fact_card', id: c.fact_card_id }),
    ),
  ]
  const target = targetOf(item)
  if (target !== undefined) refs.unshift(target)

  const chips: DeckEntityChip[] = []
  const seenKeys = new Set<string>()
  let dropped = 0
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const label = ctx.label?.(ref)
    if (label === undefined || label === '') {
      dropped += 1
      continue
    }
    if (chips.length < MAX_ENTITY_CHIPS) chips.push({ type: ref.type, id: ref.id, label })
  }
  return { chips, dropped }
}

/** 内容盒的三种语言变体；只从结构化字段里取，一个字不编（37 §1 第 4 行）。 */
export function contentVariantsOf(item: ApprovalItem): DeckContentVariants {
  const payload = isRecord(item.payload) ? item.payload : {}
  const body = isRecord(payload.body) ? payload.body : {}
  const original =
    str(payload.original) ??
    str(payload.original_text) ??
    str(payload.source_text) ??
    str(body.text)
  const en = str(payload.summary_en) ?? str(payload.en)
  return {
    zh_summary: item.summary,
    ...(original === undefined ? {} : { original }),
    ...(en === undefined ? {} : { en }),
  }
}

/**
 * 这张卡是谁引出来的（37 §3 的第四枚筛选 chip）。
 *
 * 判序是「越具体越先」：挂在某条对话上的一定是 `conversation`（客户来信），
 * 只挂事项没挂对话的是待办委托跑出来的 `todo`，剩下的（哨兵、注册表、系统卡）
 * 是 `system`。
 */
export function sourceOf(item: ApprovalItem, kind: DeckKind): DeckSource {
  if (kind === 'system_alert' || kind === 'digest') return 'system'
  if (item.subject.conversation_id !== undefined) return 'conversation'
  const subjectType = item.subject.object.type
  if (subjectType === 'thread' || subjectType === 'message' || subjectType === 'customer')
    return 'conversation'
  if (item.subject.todo_id !== undefined || item.subject.work_item_id !== undefined) return 'todo'
  return 'system'
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
  // 展示名查不到就**没有客户标签**——退成 `cus_anna` 正是 37 §1 要删掉的那种裸 id。
  const customer =
    (to === undefined ? undefined : ctx.label?.(to)) ??
    (subject.type === 'customer' ? ctx.label?.(subject) : undefined)
  const channel =
    CHANNEL_OF[str(payload.channel) ?? ''] ??
    (kind === 'system_alert' || kind === 'digest' ? 'system' : undefined)
  const entities = entityChipsOf(item, ctx)
  // 37 §2.2b：事项 = 正名后的 work_item；两者同值，优先读新名
  const matter_id = item.subject.matter_id ?? item.subject.work_item_id
  const todo_id = item.subject.todo_id
  const matter_label =
    matter_id === undefined ? undefined : ctx.label?.({ type: 'work_item', id: matter_id })

  return {
    id: item.id,
    kind,
    status: item.state,
    priority_band: priorityBandOf(item, risk, ctx.now),
    priority: item.priority,
    risk_class: risk,
    title: item.title,
    summary: item.summary,
    content_variants: contentVariantsOf(item),
    position_id: ctx.position_id,
    role_id: item.role_id,
    ...(customer === undefined ? {} : { customer_label: customer }),
    ...(channel === undefined ? {} : { channel }),
    ...(matter_id === undefined ? {} : { matter_id }),
    ...(matter_label === undefined ? {} : { matter_label }),
    ...(todo_id === undefined ? {} : { todo_id }),
    source: sourceOf(item, kind),
    highlights: highlightsOf(item, ctx),
    evidence_chips: evidenceChipsOf(item, ctx),
    entity_chips: entities.chips,
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
      ...(item.evidence.run_id === undefined ? {} : { run_id: item.evidence.run_id }),
      enrichment: { dropped_refs: entities.dropped },
    },
    dedupe_key: item.dedupe_key,
    ...(item.expires_at === undefined ? {} : { expires_at: item.expires_at }),
    ...(item.state === 'deferred' && item.decision?.defer_until !== undefined
      ? { snoozed_until: item.decision.defer_until }
      : {}),
    snooze_count: ctx.snoozeCount?.(item) ?? (item.state === 'deferred' ? 1 : 0),
    merge_count: 1,
    version: item.revision,
  }
}

/** 14 §8「今天队列预计 X 分钟」。 */
export function estimatedMinutes(cards: DeckCard[]): number {
  return cards.reduce((sum, c) => sum + minutesFor(c.kind), 0)
}
