/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/boundaries.ts
 * (GOODS_POLICY_BOUNDARIES, 10 条) 与 src/lib/support/policy/policy-boundaries.ts
 * (matchTriggeredBoundaries / validatePolicyBoundaryAnswer / buildAnsweredBoundariesPromptBlock)，
 * rewritten for agentsws contracts.
 *
 * 产品原则（product-principles-v2）：**业务边界不预收集**。
 * AI 第一次遇到一条没答过的边界时，以选择题问一次（36 §2.2 的 `policy_change` 问句形态卡），
 * 答案沉淀为策略（19 的 `layer: 'policy'` 事实 / 24 的 lesson → 次日提案）。
 *
 * 舍掉的：Drizzle 表、`ON CONFLICT` 并发写、fail-open 的 console 吞异常、
 * crawlPrefill 与 factSignature（源页复核属于 KefuAgent 的爬虫回路，我们这边由 19 的
 * 事实卡有效期与冲突双值承担）。留下的是**问什么、给哪几个选项、什么时候问**。
 *
 * 前 10 条与 KefuAgent 的 key / 问句 / 选项 id / 选项值逐条对齐（已答行以 id 关联，不可改名）；
 * 后 5 条是中台侧新增（丢件赔付、地址写错、优惠券补发、差评应对、升级人工），
 * 补齐 32 §5 客服职责包要求的最小边界集。
 */
import type { Iso8601, PersonId } from '@agentsws/contracts'
import type {
  BoundaryItem,
  BoundaryOption,
  Classification,
  SupportIntent,
  SupportPolicy,
} from './types.js'

/**
 * 首批业务边界。
 *
 * 顺序即 prompt 注入顺序与聚合读模型的列出顺序——**不要重排**。
 * `applies_when` 任一维度命中即触发（OR）。
 */
export const SUPPORT_BOUNDARIES: readonly BoundaryItem[] = [
  {
    id: 'policy.refund_window',
    question: '你们的退款/退货窗口是多少天？',
    label: '退款/退货窗口',
    options: [
      { id: 'days_7', label: '7 天', value: { days: 7 } },
      { id: 'days_14', label: '14 天', value: { days: 14 } },
      { id: 'days_30', label: '30 天', value: { days: 30 } },
      { id: 'days_60', label: '60 天', value: { days: 60 } },
    ],
    applies_when: {
      intents: ['returns_refunds'],
      risk_terms: ['refund'],
      change_kinds: ['refund'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.return_shipping_payer',
    question: '客户退货时，退货运费谁承担？',
    label: '退货运费承担方',
    options: [
      {
        id: 'merchant_label',
        label: '我们出预付标签',
        value: { payer: 'merchant', prepaid_label: true },
      },
      { id: 'customer', label: '客户自付', value: { payer: 'customer' } },
      { id: 'by_reason', label: '质量问题我们出，其余客户自付', value: { payer: 'by_reason' } },
    ],
    applies_when: {
      intents: ['returns_refunds'],
      risk_terms: ['refund'],
      change_kinds: ['refund'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.replacement_first',
    question: '缺件/破损时优先补发还是退款？',
    label: '缺件/破损处理',
    options: [
      {
        id: 'replace_first',
        label: '优先补发，不要求退回',
        value: { prefer: 'replacement', return_required: false },
      },
      { id: 'refund_only', label: '一律退款', value: { prefer: 'refund' } },
      { id: 'customer_choice', label: '客户二选一', value: { prefer: 'customer_choice' } },
    ],
    applies_when: {
      intents: ['returns_refunds'],
      risk_terms: ['damaged', 'broken', 'replace'],
      change_kinds: ['reship'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.compensation_cap',
    question: '单笔补偿（部分退款/优惠券）上限是多少？',
    label: '单笔补偿上限',
    options: [
      { id: 'usd_5', label: '$5', value: { currency: 'USD', amount: 5 } },
      { id: 'usd_15', label: '$15', value: { currency: 'USD', amount: 15 } },
      { id: 'usd_30', label: '$30', value: { currency: 'USD', amount: 30 } },
      { id: 'pct_30', label: '订单金额 30%', value: { percent_of_order: 30 } },
    ],
    applies_when: { change_kinds: ['discount_code'], risk_terms: ['chargeback'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.cancel_change_window',
    question: '订单什么阶段还能取消/改地址？',
    label: '取消/改址窗口',
    options: [
      { id: 'before_ship', label: '未发货都可以', value: { until: 'shipped' } },
      { id: 'never', label: '一律不改，引导退货', value: { until: 'never' } },
      { id: 'platform_rules', label: '平台单让客户在平台操作', value: { until: 'platform' } },
    ],
    applies_when: {
      intents: ['cancellation', 'order_tracking'],
      change_kinds: ['address_change'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.logistics_anomaly_days',
    question: '发货后多少天物流未更新算异常？',
    label: '物流异常判定天数',
    options: [
      { id: 'days_7', label: '7 天', value: { days: 7 } },
      { id: 'days_10', label: '10 天', value: { days: 10 } },
      { id: 'days_15', label: '15 天', value: { days: 15 } },
      { id: 'days_20', label: '20 天', value: { days: 20 } },
    ],
    applies_when: { intents: ['order_tracking'], risk_terms: ['tracking'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.customs_duty_payer',
    question: '关税/清关费用谁承担？',
    label: '关税/清关承担方',
    options: [
      { id: 'merchant_ddp', label: '我们已包税', value: { payer: 'merchant', scheme: 'ddp' } },
      { id: 'customer', label: '客户自理（页面有声明）', value: { payer: 'customer' } },
      { id: 'by_region', label: '分地区（补充说明）', value: { payer: 'by_region' } },
    ],
    applies_when: { intents: ['order_tracking'], risk_terms: ['customs'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.warranty_period',
    question: '产品保修期是多久？',
    label: '保修期',
    options: [
      { id: 'm6', label: '6 个月', value: { months: 6 } },
      { id: 'm12', label: '12 个月', value: { months: 12 } },
      { id: 'm24', label: '24 个月', value: { months: 24 } },
      { id: 'none', label: '无保修', value: { months: 0 } },
    ],
    applies_when: { intents: ['warranty', 'product_question'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.presale_discount',
    question: '售前咨询能给什么优惠？',
    label: '售前优惠权限',
    options: [
      { id: 'none', label: '不给优惠', value: { allowed: false } },
      { id: 'pct_5', label: '可给 5% 通用码', value: { percent: 5 } },
      { id: 'manual', label: '一律人工决定', value: { manual: true } },
    ],
    applies_when: {},
    wiring: 'declared',
  },
  {
    id: 'policy.vip_threshold',
    question: '多大金额/什么客户算 VIP 需要特殊对待？',
    label: 'VIP 阈值',
    options: [
      { id: 'usd_200', label: '单笔超 $200', value: { currency: 'USD', amount: 200 } },
      { id: 'usd_500', label: '单笔超 $500', value: { currency: 'USD', amount: 500 } },
      { id: 'none', label: '不区分 VIP', value: { none: true } },
    ],
    applies_when: {},
    wiring: 'declared',
  },
  /* ---- 中台侧新增（32 §5 客服职责包）------------------------------------ */
  {
    id: 'policy.lost_package_liability',
    question: '物流显示已签收但客户说没收到，怎么处理？',
    label: '物流丢件赔付',
    options: [
      { id: 'reship_free', label: '直接免费补发', value: { remedy: 'reship', free: true } },
      { id: 'refund_full', label: '全额退款', value: { remedy: 'refund', portion: 'full' } },
      {
        id: 'carrier_first',
        label: '先向承运商发起查件，再定',
        value: { remedy: 'carrier_claim_first' },
      },
      { id: 'manual', label: '一律人工决定', value: { manual: true } },
    ],
    applies_when: { intents: ['order_tracking'], risk_terms: ['tracking'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.wrong_address_liability',
    question: '客户自己填错地址导致寄丢，运费与货款谁承担？',
    label: '地址写错责任',
    options: [
      { id: 'customer_pays', label: '客户承担，重寄需再付款', value: { payer: 'customer' } },
      {
        id: 'merchant_once',
        label: '首次我们承担，之后客户自付',
        value: { payer: 'merchant_once' },
      },
      { id: 'split', label: '只补运费，货款客户承担', value: { payer: 'split' } },
    ],
    applies_when: { intents: ['cancellation'], change_kinds: ['address_change'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.goodwill_coupon',
    question: '什么情况下可以补发优惠券安抚客户？',
    label: '优惠券补发',
    options: [
      { id: 'never', label: '一律不补', value: { allowed: false } },
      {
        id: 'our_fault_only',
        label: '只在我们出错时补',
        value: { allowed: true, when: 'our_fault' },
      },
      {
        id: 'any_complaint',
        label: '客户明确不满就可以补',
        value: { allowed: true, when: 'complaint' },
      },
    ],
    applies_when: { intents: ['complaint'], change_kinds: ['discount_code'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.negative_review_response',
    question: '客户威胁要给差评或已经给了差评，怎么应对？',
    label: '差评应对',
    options: [
      {
        id: 'no_trade',
        label: '不拿补偿换评价，照常按政策处理',
        value: { trade_for_review: false },
      },
      { id: 'escalate', label: '一律转人工处理', value: { escalate: true } },
      {
        id: 'offer_remedy',
        label: '先给政策内的补救方案，不提评价',
        value: { trade_for_review: false, offer_remedy: true },
      },
    ],
    applies_when: { intents: ['complaint'], risk_terms: ['review', 'lawsuit'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.escalation_trigger',
    question: '什么情况下必须转人工，不让 AI 直接回？',
    label: '升级人工的条件',
    options: [
      {
        id: 'money_or_legal',
        label: '涉钱、涉法律、涉差评就转',
        value: { on: ['money', 'legal', 'review'] },
      },
      { id: 'legal_only', label: '只有法律与安全事故才转', value: { on: ['legal'] } },
      { id: 'always_review', label: '所有对外回复都要人看一眼', value: { on: ['all'] } },
    ],
    applies_when: { intents: ['complaint'], risk_terms: ['lawsuit', 'chargeback'] },
    wiring: 'enforced',
  },
]

const BY_ID = new Map(SUPPORT_BOUNDARIES.map((b) => [b.id, b]))

export function findBoundary(
  id: string,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): BoundaryItem | undefined {
  return registry === SUPPORT_BOUNDARIES ? BY_ID.get(id) : registry.find((b) => b.id === id)
}

export function findBoundaryOption(
  boundary: BoundaryItem,
  option_id: string,
): BoundaryOption | undefined {
  return boundary.options.find((o) => o.id === option_id)
}

function signalsOf(input: SupportIntent | Classification): {
  intent: SupportIntent
  risk_terms: readonly string[]
} {
  return typeof input === 'string'
    ? { intent: input, risk_terms: [] }
    : { intent: input.intent, risk_terms: input.entities.risk_terms }
}

/** 一条边界是否被这次来信触发。任一维度命中即触发（OR）；`declared` 的从不触发。 */
export function boundaryTriggered(
  boundary: BoundaryItem,
  input: SupportIntent | Classification,
  change_kinds: readonly string[] = [],
): boolean {
  if (boundary.wiring !== 'enforced') return false
  const { intent, risk_terms } = signalsOf(input)
  const t = boundary.applies_when
  if (t.intents?.includes(intent) === true) return true
  if (t.risk_terms?.some((term) => risk_terms.includes(term)) === true) return true
  if (t.change_kinds?.some((k) => change_kinds.includes(k)) === true) return true
  return false
}

/** 只看 `boundary_id`：调用方手里可能只有"答过哪些"的轻量列表。 */
export interface AnsweredBoundaryRef {
  boundary_id: string
}

export function isAnswered(boundary_id: string, policies: readonly AnsweredBoundaryRef[]): boolean {
  return policies.some((p) => p.boundary_id === boundary_id)
}

/**
 * 这次来信触发、但还没答过的边界，按注册表顺序。
 * "只问一次"由调用方的 `dedupe_key`（14 §4）与这里的 `policies` 一起保证。
 */
export function findUnansweredBoundaries(
  input: SupportIntent | Classification,
  policies: readonly AnsweredBoundaryRef[],
  opts: { change_kinds?: readonly string[]; registry?: readonly BoundaryItem[] } = {},
): BoundaryItem[] {
  const registry = opts.registry ?? SUPPORT_BOUNDARIES
  return registry.filter(
    (b) => boundaryTriggered(b, input, opts.change_kinds ?? []) && !isAnswered(b.id, policies),
  )
}

/** 第一条没答过的边界——一次只问一个问题（36 §2.2 选择题卡）。 */
export function findUnansweredBoundary(
  input: SupportIntent | Classification,
  policies: readonly AnsweredBoundaryRef[],
  opts: { change_kinds?: readonly string[]; registry?: readonly BoundaryItem[] } = {},
): BoundaryItem | undefined {
  return findUnansweredBoundaries(input, policies, opts)[0]
}

/* ------------------------------------------------------------------ */
/* 答案 → 策略                                                          */
/* ------------------------------------------------------------------ */

export type BoundaryAnswer =
  | { kind: 'option'; option_id: string }
  | { kind: 'custom'; text: string }
  | { kind: 'decline' }

export const MAX_CUSTOM_ANSWER_CHARS = 2000

export type AnswerError = 'unknown_boundary' | 'unknown_option' | 'invalid_answer'

/** 纯校验，无副作用（KefuAgent validatePolicyBoundaryAnswer 的移植）。 */
export function validateBoundaryAnswer(
  boundary_id: string,
  answer: BoundaryAnswer,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): { ok: true } | { ok: false; code: AnswerError } {
  const boundary = findBoundary(boundary_id, registry)
  if (boundary === undefined) return { ok: false, code: 'unknown_boundary' }
  if (answer.kind === 'decline') return { ok: true }
  if (answer.kind === 'option') {
    return findBoundaryOption(boundary, answer.option_id) === undefined
      ? { ok: false, code: 'unknown_option' }
      : { ok: true }
  }
  const text = answer.text.trim()
  return text.length === 0 || text.length > MAX_CUSTOM_ANSWER_CHARS
    ? { ok: false, code: 'invalid_answer' }
    : { ok: true }
}

export interface AnswerContext {
  by: PersonId | 'import'
  at: Iso8601
  source?: SupportPolicy['source']
  approval_item_id?: string
}

/**
 * 边界答案 → `SupportPolicy`。
 * `value` 是**答题那一刻的快照**：以后改注册表不回写已答的行（KefuAgent 的 value_json 语义）。
 * `decline`（"暂不回答"）不产策略——场景保持人工，且不再自动问第二次，
 * 那条"不再问"的记忆由调用方按 `dedupe_key` 保存。
 */
export function answerBoundary(
  boundary_id: string,
  answer: BoundaryAnswer,
  ctx: AnswerContext,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): SupportPolicy | undefined {
  const check = validateBoundaryAnswer(boundary_id, answer, registry)
  if (!check.ok || answer.kind === 'decline') return undefined
  const boundary = findBoundary(boundary_id, registry)
  if (boundary === undefined) return undefined
  const source = ctx.source ?? 'approval'
  if (answer.kind === 'option') {
    const option = findBoundaryOption(boundary, answer.option_id)
    if (option === undefined) return undefined
    return {
      boundary_id,
      option_id: option.id,
      value: { ...option.value },
      statement: `${boundary.label}：${option.label}`,
      answered_by: ctx.by,
      answered_at: ctx.at,
      source,
      ...(ctx.approval_item_id === undefined ? {} : { approval_item_id: ctx.approval_item_id }),
    }
  }
  const text = answer.text.trim()
  return {
    boundary_id,
    value: { text },
    statement: `${boundary.label}：${text}`,
    answered_by: ctx.by,
    answered_at: ctx.at,
    source,
    ...(ctx.approval_item_id === undefined ? {} : { approval_item_id: ctx.approval_item_id }),
  }
}

/** 从策略里取一个数值槽（`policy.refund_window` 的 `days` 之类）。 */
export function policyValue(
  policies: readonly SupportPolicy[],
  boundary_id: string,
  key: string,
): unknown {
  return policies.find((p) => p.boundary_id === boundary_id)?.value[key]
}

export function policyNumber(
  policies: readonly SupportPolicy[],
  boundary_id: string,
  key: string,
): number | undefined {
  const v = policyValue(policies, boundary_id, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 已确认边界的 prompt 块（KefuAgent buildAnsweredBoundariesPromptBlock 的移植）。
 * 空数组返回 `undefined`：没有边界时 prompt 里连标题都不出现，静态前缀才稳定（22 §缓存纪律）。
 */
export function answeredBoundariesBlock(
  policies: readonly SupportPolicy[],
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): string | undefined {
  const lines: string[] = []
  for (const boundary of registry) {
    const policy = policies.find((p) => p.boundary_id === boundary.id)
    if (policy === undefined) continue
    const answer = policy.statement.includes('：')
      ? policy.statement.slice(policy.statement.indexOf('：') + 1)
      : policy.statement
    if (answer.length === 0) continue
    lines.push(`- ${boundary.label}：${answer}`)
  }
  if (lines.length === 0) return undefined
  return [
    '商户已确认的业务边界（这些是商户明确拍板的事实，优先级高于爬取到的政策页；如与知识库冲突，以本块为准）：',
    ...lines,
  ].join('\n')
}
