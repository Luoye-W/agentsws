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
  // WP63（51 §2.1）：库存写错当场超卖、集合改的是整家店的货架，都按 medium；
  // 评价那两条对外可见但改不了钱，按 low（额度与合规词表在 mandate 上）。
  inventory_adjust: 'medium',
  collection_edit: 'low',
  review_reply: 'low',
  review_invite: 'low',
  // WP67（48 §5.1）：红人那五条。开发信对外但改不了钱（禁承诺词表把"改得了钱"
  // 那一半直接拦死），按 low；合作是一笔钱和一纸条款，按 high；
  // 审核结论与联盟码对外可见、额度在 mandate 上，按 low；追踪链接只是给链接加参数。
  kol_outreach: 'low',
  kol_collaboration: 'high',
  kol_deliverable_review: 'low',
  kol_affiliate_code: 'low',
  kol_tracked_link: 'low',
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
  /**
   * WP63（51 §2.1）：**上下架与全站活动永远人审**。
   *
   * 上架 = 让顾客能买到，撤下 = 让顾客买不到，全站活动 = 全店的价都动了——
   * 三件事都是"一按下去整家店的样子就变了"，跟改一句文案不是同一个量级。
   * 把它们放进硬顶而不是只在职责 yml 里写 `ceiling: L1`：yml 是可以被工作区策略
   * 放宽的，硬顶不行（15 §2）。
   *
   * `publish_post` **不在**这里：51 §2.2 明说博客草稿 L2、发布 L1，
   * 所以它按 `after.published` 分档，见下面的 switch。
   */
  'publish_product',
  'unpublish_product',
  'promotion',
  /**
   * WP67（48 §5.1）：**建合作 / 改预算永远人审**。
   *
   * 与群发同理但理由不同：群发是"收不回来"，合作是"这是一笔钱和一纸条款"。
   * 采纳率再高也只能证明这个 Agent 挑人挑得准，证明不了这个价该给、这个条款该签。
   * 放在硬顶而不是只写在职责 yml 的 `ceiling: L1` 里——yml 可以被工作区策略放宽，
   * 硬顶不行（15 §2）。
   */
  'kol_collaboration',
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
  // WP63（51 §2.1）：库存落在一个库存项上、集合落在一个集合上、评价落在一条评价上——
  // 每一条都能顺着目标问出"这件货 / 这个货架 / 这条评价归不归你管"，所以都进这张表。
  'inventory_adjust',
  'collection_edit',
  'review_reply',
  'review_invite',
])

/**
 * 15 §1「改前必读」：这几种变更**必须**先把目标的全记录读回来才准提。
 *
 * 为什么不是所有写动作都要：退款的 `before` 来自订单金额，读一次订单就够了；
 * 而改文案 / 改货架 / 回评价这三件事，`before` 就是那段**正文**——没读全文就改，
 * 等于拿着摘要覆盖原文。
 *
 * 前置层（`packages/txn` 的 `runPrecheck`）与 guardrail 读的是同一张表，
 * 免得"前置放过、guardrail 拦下"这种两头不一致。
 */
export const RECORD_READ_KINDS: ReadonlySet<ChangeKind> = new Set([
  'listing_edit',
  'collection_edit',
  'review_reply',
])

/**
 * WP63（51 §2.1 评价管理「邀评 L2 且合规词表」）：邀评正文里**不许出现**的说法。
 *
 * 这不是措辞偏好，是平台规则：拿好处换好评在 Shopify / Amazon / Google 都是封号级
 * 违规。所以它是 `block` 而不是 `review`——这种句子不该有"人点一下就发出去"的路径。
 */
export const REVIEW_INVITE_FORBIDDEN: readonly string[] = [
  '返现',
  '好评返',
  '五星好评',
  '删差评',
  '改评价',
  'free gift',
  'gift card',
  'refund for',
  '5-star',
  'five star',
  'positive review',
  'remove your review',
]

/**
 * WP67（48 §5.1「开发信 L2 → L3 且禁承诺」）：开发信正文里**不许出现**的说法。
 *
 * 分三类，三类的理由不一样：
 *
 * 1. **钱**（"我们付你"/"报酬是"/"we will pay"）——给钱要走 `kol_collaboration`，
 *    那条永远人审。一封信里写死一个数，等于绕过了那道门。
 * 2. **白送**（"免费寄样"/"free sample"/"送你一台"）——样品也是成本，而且
 *    "免费"这个词在这种信里是承诺不是描述。
 * 3. **保证**（"保证出单"/"guaranteed"/"包爆"）——效果承诺在多数地区是广告法
 *    直接管的东西，写了就是给商家埋雷。
 *
 * 大小写不敏感（调用方先 `toLowerCase()`）。这张表与 `@agentsws/kol-core` 的
 * 起草那一步共用——那边 `import` 的就是这一个数组，不是抄一份。
 * **只可加行**（15 §2 对规则集的老规矩）。
 */
export const KOL_OUTREACH_FORBIDDEN: readonly string[] = [
  // 一、钱
  '我们付你',
  '报酬是',
  '稿费',
  '坑位费',
  '预付',
  'we will pay',
  'we can pay',
  'payment of',
  'flat fee of',
  'paid partnership of',
  // 二、白送
  '免费寄样',
  '免费送',
  '包邮送你',
  '送你一台',
  'free sample',
  'free product',
  'send you a free',
  'no cost to you',
  // 三、保证
  '保证出单',
  '保证销量',
  '包爆',
  '一定能',
  'guaranteed sales',
  'guaranteed results',
  'we guarantee',
]

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
  // WP63：换一个仓、换一个库存项 = 把数写到别的货上了，那不是"调库存"是"调错货"。
  inventory_adjust: ['inventory_item_id', 'location_id', 'sku'],
  // 集合 id 一变，改的就是另一个货架；智能集合的判据也不该由 Agent 动。
  collection_edit: ['collection_id', 'rule_set'],
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

  // 15 §1 改前必读：这几种变更的 `before` 就是那段正文，没读全文就改等于拿摘要覆盖原文。
  // 判据是这次运行的 provenance（读没读过是**事实**），不是调用方自报的一格。
  if (
    RECORD_READ_KINDS.has(change.kind) &&
    facts.provenance &&
    !facts.provenance.hasFull(change.target)
  )
    block('requires_record_read', 'get_full_record', change.target.id)

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
      // WP63（51 §2.1 促销与折扣）：营销发码与客服的安抚发码**分账**——
      // 同一条 kind，两组 cap：客服那条职责只配 `max_presales_discount_pct`，
      // 店铺管理那条只配 `max_promo_discount_pct` + `max_promo_uses`。
      // 配了哪一组就判哪一组，没配的一条都不多判（老调用方一个字不用改）。
      const promoCap = capNumber(mandate, 'max_promo_discount_pct')
      if (p !== undefined && promoCap !== undefined && p > promoCap)
        review('max_promo_discount_pct', promoCap, p)
      const usesCap = capNumber(mandate, 'max_promo_uses')
      if (usesCap !== undefined) {
        const uses = num(after.usage_limit)
        // 「无上限码」= 谁都能无限次用的码，51 §2.1 明说它永远人审。
        if (uses === undefined) review('max_promo_uses', usesCap, 'unlimited')
        else if (uses > usesCap) review('max_promo_uses', usesCap, uses)
      }
      break
    }
    /**
     * WP63（51 §2.1 商品管理）：库存。
     *
     * 两种写法在 API 上是同一次调用，在后果上不是：
     * - `adjust` 在现有数量上加减（收货 / 报损）——额内可自动；
     * - `set` 直接写一个数（盘点对账）——**永远人审**，因为写成 0 和写成 1000 一样容易。
     */
    case 'inventory_adjust': {
      const beforeQty = num(before.quantity)
      const mode = after.mode === 'set' ? 'set' : 'adjust'
      const delta =
        num(after.delta) ??
        (beforeQty !== undefined && num(after.quantity) !== undefined
          ? (num(after.quantity) as number) - beforeQty
          : undefined)
      if (beforeQty === undefined) block('inventory_before_ungrounded', 'quantity', 'missing')
      if (mode === 'set') {
        const target = num(after.quantity)
        if (target === undefined) block('inventory_quantity_required')
        else if (target < 0) block('inventory_negative', 0, target)
        review('inventory_set_needs_review', 'L1', 'set')
      } else {
        if (delta === undefined) block('inventory_delta_required')
        else {
          if (beforeQty !== undefined && beforeQty + delta < 0)
            block('inventory_negative', 0, beforeQty + delta)
          const cap = capNumber(mandate, 'max_inventory_adjust')
          if (cap !== undefined && Math.abs(delta) > cap)
            review('max_inventory_adjust', cap, Math.abs(delta))
        }
      }
      break
    }
    /** WP63（51 §2.1）：集合增删商品——改的是整家店的货架（"改之前先读全"见 switch 之前那一条）。 */
    case 'collection_edit': {
      const cap = capNumber(mandate, 'max_collection_products')
      const touched = Array.isArray(after.products) ? after.products.length : num(after.count)
      if (cap !== undefined && touched !== undefined && touched > cap)
        review('max_collection_products', cap, touched)
      break
    }
    /** WP63（51 §2.1 评价管理）：回复评价（"改之前先读全"见 switch 之前那一条）。 */
    case 'review_reply': {
      // 差评交给客服（`dtc.support`）处理，店铺管理这条职责不自己回——
      // 评分低于这条线就不该由这里出稿，转人（转岗）由上层按这条 hit 决定。
      const floor = capNumber(mandate, 'review_reply_min_rating')
      const rating = num(before.rating)
      if (floor !== undefined && rating !== undefined && rating < floor)
        review('review_reply_min_rating', floor, rating)
      break
    }
    /** WP63（51 §2.1 评价管理）：邀评——合规词表命中直接 block，不给"人点一下就发"的路。 */
    case 'review_invite': {
      const body = [after.body, after.subject]
        .filter((v): v is string => typeof v === 'string')
        .join('\n')
        .toLowerCase()
      const hit = REVIEW_INVITE_FORBIDDEN.find((w) => body.includes(w.toLowerCase()))
      if (hit !== undefined) block('review_invite_compliance', hit, 'found')
      const cap = capNumber(mandate, 'max_review_invites_per_day')
      if (cap !== undefined && facts.windowCount + 1 > cap)
        review('max_review_invites_per_day', cap, facts.windowCount + 1)
      break
    }
    /**
     * WP63（51 §2.2 内容与博客）：博客文章。
     *
     * 51 明说「新建 / 更新草稿 L2；**发布 L1**」，所以它不能进 `HARD_L1`
     * （那样草稿也自动不了），而是按 `after.published` 分档：躺在后台的草稿随便写，
     * 一旦要让它出现在店里，人必须点一下。
     */
    case 'publish_post': {
      if (after.published === true) review('publish_post_needs_review', 'L1', 'published')
      const cap = capNumber(mandate, 'max_posts_per_day')
      if (cap !== undefined && after.published === true && facts.windowCount + 1 > cap)
        review('max_posts_per_day', cap, facts.windowCount + 1)
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
    /**
     * WP67（48 §5.1）：开发信。**禁承诺是 block，不是转人审。**
     *
     * 理由与 51 §2.1 的邀评合规词表逐字相同：一封写着"我们付你 800 美元、
     * 样品免费寄"的信，不该存在"人点一下就发出去"的路径——人在一屏卡面上
     * 判不出这句话有没有超出授权，而对方收到之后会当真。要给钱，去建一条合作
     * （`kol_collaboration`，永远人审，48 §5.1）。
     *
     * 词表在 {@link KOL_OUTREACH_FORBIDDEN}，与 `@agentsws/kol-core` 的起草那一步
     * 是**同一份**——起草时先自查一遍（尽早给模型反馈），这里是最后一道，
     * 两边读的是同一个数组，不许各写一张。
     */
    case 'kol_outreach': {
      const body = [after.body, after.subject]
        .filter((v): v is string => typeof v === 'string')
        .join('\n')
        .toLowerCase()
      const hit = KOL_OUTREACH_FORBIDDEN.find((w) => body.includes(w.toLowerCase()))
      if (hit !== undefined) block('kol_outreach_commitment', hit, 'found')
      // 退订 / 抑制名单必查，fail-closed：不报"查过了"就 block（同 `campaign_send`）。
      // 开发信是**主动外发**，名单上的人一个都不许在里面。
      if (after.suppression_checked !== true)
        block('suppression_list_required', 'checked', String(after.suppression_checked ?? 'never'))
      else {
        const leaked = suppressedRecipients(strings(after.recipients), strings(after.suppressed))
        if (leaked.length > 0)
          block('suppression_list', 0, `${leaked.length}: ${leaked.slice(0, 3).join(', ')}`)
      }
      const cap = capNumber(mandate, 'max_outreach_per_day')
      if (cap !== undefined && facts.windowCount + 1 > cap)
        review('max_outreach_per_day', cap, facts.windowCount + 1)
      break
    }
    /**
     * WP67（48 §5.1）：合作。永远人审（`HARD_L1`），这里只判**超没超过人审线**——
     * 两件事不一样：硬顶说的是"这张卡要人点"，`max_collab_budget` 说的是
     * "这个价已经超出这条职责该谈的范围"，两条 hit 都要在卡面上看得见。
     */
    case 'kol_collaboration': {
      const budget = change.amount_base ?? num(after.budget)
      if (budget !== undefined && budget < 0) block('kol_budget_negative', 0, budget)
      const cap = capNumber(mandate, 'max_collab_budget')
      if (budget !== undefined && cap !== undefined && budget > cap)
        review('max_collab_budget', cap, budget)
      // 阶段机的合法迁移表在 `@agentsws/kol-core` 的 `stages.ts` 里（**只有那一份**）；
      // 这里只认调用方带进来的结论，没带就不判（老调用方一个字不用改）。
      if (after.stage_transition_ok === false)
        block('kol_stage_transition', String(before.stage ?? '?'), String(after.stage ?? '?'))
      break
    }
    /** WP67（48 §5.1）：交付物审核结论。额度是**每天审几条**，防的是"一口气全批了"。 */
    case 'kol_deliverable_review': {
      const verdictValue = after.review
      const allowed = ['approved', 'changes_requested', 'rejected']
      if (typeof verdictValue !== 'string' || !allowed.includes(verdictValue))
        block('kol_review_verdict_required', allowed.join('|'), String(verdictValue ?? 'missing'))
      const cap = capNumber(mandate, 'max_deliverable_reviews_per_day')
      if (cap !== undefined && facts.windowCount + 1 > cap)
        review('max_deliverable_reviews_per_day', cap, facts.windowCount + 1)
      break
    }
    /**
     * WP67（48 §5.1）：联盟折扣码。
     *
     * 折扣率与客服的安抚发码、营销的促销码**分账**：同样是"给一个码"，
     * 红人那条职责只配 `max_affiliate_discount_pct`（默认 20），配了才判。
     */
    case 'kol_affiliate_code': {
      const p = num(after.percent)
      if (p !== undefined && p < 0) block('kol_discount_negative', 0, p)
      const cap = capNumber(mandate, 'max_affiliate_discount_pct')
      if (p !== undefined && cap !== undefined && p > cap)
        review('max_affiliate_discount_pct', cap, p)
      break
    }
    /**
     * WP67（48 §5.1）：追踪链接。L3——它不动钱也不发信。
     *
     * 唯一的硬判断是 UTM 三个必填参数在不在：少一个，归因表上这条链接带回来的
     * 订单就归不到任何一次合作头上，等于这条链接白建了。
     */
    case 'kol_tracked_link': {
      const utm = rec(after.utm)
      const missing = ['source', 'medium', 'campaign'].filter(
        (k) => typeof utm[k] !== 'string' || (utm[k] as string).trim() === '',
      )
      if (missing.length > 0) block('kol_utm_required', 'source,medium,campaign', missing.join(','))
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
