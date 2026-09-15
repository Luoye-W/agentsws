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
import { suppressedRecipients } from './suppression.js'

/** 15 §2：kind 的风险等级与"永远 L1"硬顶。 */
export const KIND_RISK: Record<ChangeKind, RiskClass> = {
  refund: 'medium',
  reship: 'medium',
  address_change: 'medium',
  discount_code: 'low',
  goodwill_credit: 'medium',
  price_change: 'medium',
  listing_edit: 'low',
  publish_product: 'medium',
  unpublish_product: 'medium',
  promotion: 'medium',
  campaign_send: 'medium',
  // WP64（51 §2.3 / §2.4）
  segment_edit: 'low',
  flow_edit: 'medium',
  create_fulfillment: 'low',
  split_order: 'low',
  cancel_order: 'high',
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
  // WP64（51 §2.3）：一次群发出去收不回来，而且收信的是**顾客**不是同事——发送永远人审。
  'campaign_send',
  // WP64（51 §2.4）：取消订单连带退款与库存回补，不可逆。
  'cancel_order',
  'publish_theme',
  'merge_pr',
  'deploy',
  'dns_change',
  'payment_config',
  'tax_config',
  'domain_config',
  'create_campaign',
])
/**
 * 44 G2：这些变更的**目标是一件具体商品**，于是"目标在不在我管的范围里"这句话才有意义。
 *
 * 挂整家店的岗位判起来永远是真（整店的过滤下推 19 §3 早就管住了）；只有挂**产品线**的
 * 岗位才切得到商品这一级——同一个亚马逊账号里，厨房线的运营不该改得动户外线的价。
 *
 * 补货计划暂时不在这张表里：15 §2 还没有对应的 `ChangeKind`；加的时候记得一起加进来。
 */
export const TARGET_SCOPED_KINDS: ReadonlySet<ChangeKind> = new Set([
  'price_change',
  'promotion',
  'listing_edit',
  'publish_product',
  'unpublish_product',
])

/**
 * 48 §4 L3 #3：15 guardrail 前置里三道「不自主」的门 + Amazon 出站硬闸。
 *
 * 名字集中在这里，是因为它们要在三处保持一致：`PrecheckResult` 的字段名、
 * `guardrail.gate_decided` 事件的 `gate` 值、以及给人看的那句话的键。三处各写一遍
 * 的话，改一处忘两处是迟早的事。
 *
 * 前三道**只记录不改状态**（门说「不自主」= 这张卡转人审，不是这张卡不该建）；
 * `amazon_outbound` 不同，它是「这封信根本不能这样发出去」，命中就 blocked。
 */
export const PRECHECK_GATES = [
  'l3_denylist',
  'draft_origin',
  'commitment_scan',
  'amazon_outbound',
] as const
export type PrecheckGateId = (typeof PRECHECK_GATES)[number]

/** 只记录、不改状态的那三道（`amazon_outbound` 不在其中：它会 block）。 */
export const AUTONOMY_GATES: readonly PrecheckGateId[] = [
  'l3_denylist',
  'draft_origin',
  'commitment_scan',
]

/** 09-08：受保护字段 = Agent 不得提议；人经 policy_change 可改。 */
export const PROTECTED_FIELDS: Partial<Record<ChangeKind, string[]>> = {
  address_change: ['total', 'currency', 'customer_id'],
  // WP64（51 §2.3）：自动流的**触发条件**不许 Agent 动。见下面 `flow_edit` 那一条的注释。
  flow_edit: ['trigger', 'trigger_conditions', 'trigger_filters', 'audience_filter'],
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
  /**
   * 44 G2：目标商品在不在这个岗位的范围里（职责层 `targetInRange` 的结论）。
   *
   * 不给 = 调用方还不认范围模型，这一条不判（老调用方一个字不用改）；
   * 给了而且是 `false` → **block**，理由原样带进 hit 里让人看得懂。
   */
  target_in_range?: { ok: boolean; reason?: string }
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
/** 从 `before` / `after` 里取一串字符串（不是数组或含非字符串 = 空）。 */
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
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

  // 44 G2：目标不在这个岗位管的范围里 —— 越权，当场拦（`unassigned_range` 同一条路）
  if (facts.target_in_range !== undefined && !facts.target_in_range.ok)
    block(
      'target_in_range',
      `${change.target.type}:${change.target.id}`,
      facts.target_in_range.reason ?? 'out_of_range',
    )

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
      // WP64 / 51 §2.3：退订与抑制名单**必查**。
      //
      // 判据是"这次提案报没报查过"而不是"名单里有没有人"——`suppression_checked` 不为真
      // 就是 block：没问过与问过了没人，在群发这件事上必须分得开（18 §3 的老规矩）。
      // 规则本身在 `suppression.ts`，与 WP55 客服出站那条是**同一份**，不在这里再写一遍。
      if (after.suppression_checked !== true)
        block('suppression_list_required', 'checked', String(after.suppression_checked ?? 'never'))
      else {
        const leaked = suppressedRecipients(strings(after.audience), strings(after.suppressed))
        if (leaked.length > 0)
          block('suppression_list', 0, `${leaked.length}: ${leaked.slice(0, 3).join(', ')}`)
      }
      break
    }
    case 'segment_edit': {
      // 分群本身不发信，但它决定下一次发给谁。人群大小超额 = 转人审，不是拦。
      const size = num(after.size) ?? num(after.audience_size)
      const cap = capNumber(mandate, 'max_segment_size')
      if (size !== undefined && cap !== undefined && size > cap)
        review('max_segment_size', cap, size)
      break
    }
    case 'flow_edit': {
      // 51 §2.3 的那条硬规则：**流的触发条件不可由 Agent 放宽**。
      //
      // 上面的受保护字段（`PROTECTED_FIELDS.flow_edit`）已经拦住了"改触发字段"这一半；
      // 这里补的是另一半——延迟改短、上限调大，字段名不同但效果一样是"发给更多人、发得更早"。
      // 两条都是 block 而不是 review：转人审等于让人替 Agent 判断一条流会多发给几万人，
      // 而卡面上根本看不出来。要放宽，人自己去后台改。
      const beforeDelay = num(before.delay_minutes)
      const afterDelay = num(after.delay_minutes)
      if (beforeDelay !== undefined && afterDelay !== undefined && afterDelay < beforeDelay)
        block('flow_trigger_not_loosened', beforeDelay, afterDelay)
      const beforeCap = num(before.max_recipients)
      const afterCap = num(after.max_recipients)
      if (beforeCap !== undefined && afterCap !== undefined && afterCap > beforeCap)
        block('flow_trigger_not_loosened', beforeCap, afterCap)
      break
    }
    case 'create_fulfillment': {
      // 51 §2.4：标记发货**必须带单号与承运商**。没单号的"已发货"比"未发货"更糟——
      // 顾客查不到轨迹，客服也无从回答，而订单状态已经变了。
      const tracking = typeof after.tracking_number === 'string' ? after.tracking_number.trim() : ''
      const carrier = typeof after.carrier === 'string' ? after.carrier.trim() : ''
      if (tracking === '') block('tracking_number_required')
      if (carrier === '') block('carrier_required')
      // 记录层给的键名两种都有（`fulfillment` / `fulfillment_status`），认哪一个都行——
      // 少认一个的后果是"已发货的单又发一次"，宁可两个都查。
      const state = before.fulfillment_status ?? before.fulfillment
      if (state === 'fulfilled') block('already_fulfilled', 'unfulfilled', String(state))
      break
    }
    case 'split_order': {
      // 拆单拆成一份 = 什么也没干却占了一次额度；拆过头则是包裹数失控（运费与体验都要人看）。
      const parts = num(after.parts)
      if (parts === undefined || parts < 2) block('split_needs_two_parts', 2, parts ?? 'unknown')
      else {
        const cap = capNumber(mandate, 'max_split_parts')
        if (cap !== undefined && parts > cap) review('max_split_parts', cap, parts)
      }
      break
    }
    case 'cancel_order': {
      // 已发货的订单取消不了（货在路上）——这是事实判断，不是额度，所以 block。
      const shipped = before.fulfillment_status ?? before.fulfillment
      if (shipped === 'fulfilled') block('fulfilled_cannot_cancel', 'unfulfilled', String(shipped))
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
