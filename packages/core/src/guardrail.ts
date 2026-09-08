import type {
  AuthorizationCheckInput,
  AuthorizationCheckResult,
  ChangeKind,
  GuardrailHit,
  GuardrailResult,
  Iso8601,
  Mandate,
  ObjectRef,
  RiskClass,
} from '@agentsws/contracts'
import { capBool, capList, capNumber, mandateHash } from './mandate.js'
import type { Provenance } from './provenance.js'

/** 15 §2：kind 的风险等级与"永远 L1"硬顶。 */
export const KIND_RISK: Record<ChangeKind, RiskClass> = {
  refund: 'medium',
  reship: 'medium',
  address_change: 'medium',
  discount_code: 'low',
  price_change: 'medium',
  listing_edit: 'low',
  publish_product: 'medium',
  unpublish_product: 'medium',
  promotion: 'medium',
  campaign_send: 'medium',
  publish_post: 'medium',
  bid_change: 'medium',
  budget_change: 'medium',
  create_campaign: 'high',
  pause_ad: 'low',
  negative_keyword: 'low',
  publish_theme: 'high',
  merge_pr: 'high',
  deploy: 'high',
  dns_change: 'high',
  payment_config: 'high',
  tax_config: 'high',
  domain_config: 'high',
}
export const HARD_L1: ReadonlySet<ChangeKind> = new Set([
  'publish_theme',
  'merge_pr',
  'deploy',
  'dns_change',
  'payment_config',
  'tax_config',
  'domain_config',
  'create_campaign',
])
/** 09-08：受保护字段 = Agent 不得提议；人经 policy_change 可改。 */
export const PROTECTED_FIELDS: Partial<Record<ChangeKind, string[]>> = {
  address_change: ['total', 'currency', 'customer_id'],
  price_change: ['sku', 'currency', 'tax_category'],
  listing_edit: ['listing_id', 'compliance_notes'],
}

export interface ChangeLike {
  kind: ChangeKind
  target: ObjectRef
  field?: string
  before: unknown
  after: unknown
  amount_base?: number
  margin_after_pct?: number
}

/** 评估所需的外部事实，由账本 / 数据层提供；纯函数本身不查库。 */
export interface GuardrailFacts {
  now: Iso8601
  /** 同一 change_set 内的其他变更（防拆单累加） */
  changeSet: { target: ObjectRef; field?: string; kind: ChangeKind }[]
  /** 该 (assignment, kind) 在窗口内已 applied + 在途 + 预占 的计数 */
  windowCount: number
  /** 同目标同 kind 最近 N 天累计变动百分比（applied + 在途 + 预占） */
  cumulativePct?: number
  /** 所有广告账户今日花费（含在途） */
  dailySpendTotal?: number
  provenance?: Provenance
  /** 已被人批准的软额度例外（apply 阶段） */
  approvedException?: boolean
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const pct = (before: number, after: number) =>
  before === 0 ? Number.POSITIVE_INFINITY : (Math.abs(after - before) / Math.abs(before)) * 100

/**
 * 15 §3 两次评估共用。超上限 = review；状态条件 / 受保护字段 / 集合重复 / 改前未读 = block。
 * apply 阶段带 approvedException 时，review 类命中不改变 verdict（记 approved_exception）。
 */
export function evaluateGuardrail(
  change: ChangeLike,
  mandate: Mandate,
  facts: GuardrailFacts,
  phase: 'stage' | 'apply',
): GuardrailResult {
  const hits: GuardrailHit[] = []
  const push =
    (severity: GuardrailHit['severity']) =>
    (rule: string, cap?: number | string, actual?: number | string) =>
      hits.push({
        rule,
        severity,
        ...(cap !== undefined ? { cap } : {}),
        ...(actual !== undefined ? { actual } : {}),
      })
  const review = push('review')
  const block = push('block')
  const before = rec(change.before)
  const after = rec(change.after)

  // 集合内重复 (target, field)
  const same = facts.changeSet.filter(
    (c) =>
      c.kind === change.kind &&
      c.target.type === change.target.type &&
      c.target.id === change.target.id &&
      (c.field ?? '') === (change.field ?? ''),
  )
  if (same.length > 0 && (mandate.per_change_limits?.no_repeat_target_field ?? true))
    block('no_repeat_target_field', 1, same.length + 1)
  const maxItems = mandate.per_change_limits?.max_items
  if (
    maxItems !== undefined &&
    facts.changeSet.filter((c) => c.kind === change.kind).length + 1 > maxItems
  )
    review('max_items_per_change', maxItems, facts.changeSet.length + 1)

  // 受保护字段
  const protectedFields = [
    ...(PROTECTED_FIELDS[change.kind] ?? []),
    ...capList(mandate, 'protected'),
  ]
  if (
    change.field &&
    protectedFields.map((f) => f.toLowerCase()).includes(change.field.toLowerCase())
  )
    block('protected_field', protectedFields.join(','), change.field)
  for (const f of protectedFields)
    if (f in after && f in before && JSON.stringify(after[f]) !== JSON.stringify(before[f]))
      block('protected_field', f, 'changed')

  // 频次窗口
  if (mandate.window && facts.windowCount + 1 > mandate.window.max_count)
    review('window', `${mandate.window.max_count}/${mandate.window.per}`, facts.windowCount + 1)

  // 硬顶：永远 L1
  if (HARD_L1.has(change.kind)) review('hard_ceiling', 'L1', change.kind)

  switch (change.kind) {
    case 'refund': {
      const amount = change.amount_base ?? num(after.refund_amount)
      const total = num(before.total)
      const cap = capNumber(mandate, 'max_auto_refund_amount')
      if (amount === undefined) block('refund_amount_required')
      else {
        if (total !== undefined && amount > total - (num(before.refunded) ?? 0))
          block('refund_exceeds_paid', total, amount)
        if (cap !== undefined && amount > cap) review('max_auto_refund_amount', cap, amount)
      }
      if (capBool(mandate, 'within_policy_window_only')) {
        const days = capNumber(mandate, 'return_window_days') ?? 14
        const delivered =
          typeof before.delivered_at === 'string' ? Date.parse(before.delivered_at) : Number.NaN
        if (Number.isNaN(delivered))
          block('within_policy_window_only', days, 'delivered_at unknown')
        else if (Date.parse(facts.now) - delivered > days * 86_400_000)
          block(
            'within_policy_window_only',
            days,
            Math.floor((Date.parse(facts.now) - delivered) / 86_400_000),
          )
      }
      break
    }
    case 'reship': {
      if (before.financial_status !== undefined && before.financial_status !== 'paid')
        block('paid_only', 'paid', String(before.financial_status))
      const items = num(after.items) ?? 1
      const cap = capNumber(mandate, 'max_items_per_order')
      if (cap !== undefined && items > cap) review('max_items_per_order', cap, items)
      break
    }
    case 'address_change': {
      if (
        capBool(mandate, 'unfulfilled_only') &&
        before.fulfillment !== undefined &&
        before.fulfillment !== 'unfulfilled'
      )
        block('unfulfilled_only', 'unfulfilled', String(before.fulfillment))
      break
    }
    case 'discount_code': {
      const p = num(after.percent)
      const cap = capNumber(mandate, 'max_presales_discount_pct')
      if (p !== undefined && cap !== undefined && p > cap)
        review('max_presales_discount_pct', cap, p)
      break
    }
    case 'price_change':
    case 'promotion': {
      const b = num(before.price),
        a = num(after.price)
      if (a === undefined || a <= 0) block('price_positive_required')
      else if (b === undefined || b <= 0) block('price_before_ungrounded')
      else {
        const d = pct(b, a)
        const capName =
          change.kind === 'promotion' ? 'max_promotion_discount_pct' : 'max_price_delta_pct'
        const cap = capNumber(mandate, capName)
        if (cap !== undefined && d > cap) review(capName, cap, Math.round(d))
        const cum = capNumber(mandate, 'max_cumulative_delta_pct_30d')
        if (cum !== undefined && facts.cumulativePct !== undefined && facts.cumulativePct + d > cum)
          review('max_cumulative_delta_pct_30d', cum, Math.round(facts.cumulativePct + d))
      }
      const floor = capNumber(mandate, 'margin_floor_pct')
      if (
        floor !== undefined &&
        change.margin_after_pct !== undefined &&
        change.margin_after_pct < floor
      )
        review('margin_floor_pct', floor, change.margin_after_pct)
      break
    }
    case 'listing_edit': {
      if (facts.provenance && !facts.provenance.hasFull(change.target))
        block('requires_record_read', 'get_full_record', change.target.id)
      break
    }
    case 'campaign_send': {
      const n = num(after.audience_size)
      const cap = capNumber(mandate, 'max_campaign_audience')
      if (n !== undefined && cap !== undefined && n > cap) review('max_campaign_audience', cap, n)
      break
    }
    case 'bid_change':
    case 'budget_change': {
      const b = num(before.value),
        a = num(after.value)
      const capName = change.kind === 'bid_change' ? 'max_bid_change_pct' : 'max_budget_change_pct'
      const cap = capNumber(mandate, capName)
      if (b !== undefined && a !== undefined && cap !== undefined && pct(b, a) > cap)
        review(capName, cap, Math.round(pct(b, a)))
      const total = capNumber(mandate, 'max_daily_spend_total')
      if (
        total !== undefined &&
        facts.dailySpendTotal !== undefined &&
        facts.dailySpendTotal + Math.max(0, (a ?? 0) - (b ?? 0)) > total
      )
        block('max_daily_spend_total', total, facts.dailySpendTotal)
      break
    }
    default:
      break
  }

  // provenance：目标必须见过（stage 与 apply 都查）
  if (facts.provenance && !facts.provenance.has(change.target))
    block('provenance_missing', 'seen', `${change.target.type}:${change.target.id}`)

  const hasBlock = hits.some((h) => h.severity === 'block')
  const hasReview = hits.some((h) => h.severity === 'review')
  const approvedException =
    phase === 'apply' && hasReview && !hasBlock && facts.approvedException === true
  const verdict: GuardrailResult['verdict'] = hasBlock
    ? 'block'
    : hasReview && !approvedException
      ? 'require_review'
      : 'allow'
  return {
    verdict,
    hits,
    effective_mandate_hash: mandateHash(mandate),
    evaluated_at: facts.now,
    ...(approvedException ? { approved_exception: true } : {}),
  }
}

/** 15 §6.1（09-08）关系授权：请求者必须与目标订单的客户身份匹配。provenance 只证明"读过"。 */
export function authorizationCheck(input: AuthorizationCheckInput): AuthorizationCheckResult {
  const guarded: ChangeKind[] = ['refund', 'reship', 'address_change']
  if (!guarded.includes(input.kind)) return { ok: true }
  if (!input.target_owner) return { ok: false, reason: 'target owner unknown; verify manually' }
  const r = input.requester.resolved
  if (!r) return { ok: false, reason: 'requester not resolved to a known customer' }
  if (r.type === input.target_owner.type && r.id === input.target_owner.id) return { ok: true }
  return {
    ok: false,
    reason: `requester ${r.type}:${r.id} is not the owner ${input.target_owner.type}:${input.target_owner.id}`,
  }
}
