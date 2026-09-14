/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/boundaries.ts
 * （DIGITAL_POLICY_BOUNDARIES，7 条，S039 FR-020），rewritten for agentsws contracts。
 *
 * 形式与 `goods/boundaries.ts` 完全同构——同一个卡片渲染器、同一套答题语义、同一个
 * prompt 注入路径。差的只是问题本身：SaaS 的钱和期限长在订阅退款、故障补偿、试用
 * 延长、数据删除时限上，不在退货运费和关税上。
 *
 * key 一经冻结不可改名（已答行以 key 关联）；问句与选项恒中文；自定义出口由"其他…"
 * 承载、不占选项位；顺序即 prompt 注入顺序。
 *
 * **wiring**：四条 enforced、三条 declared。折扣权限 / 人工响应时限 / 账号操作代办
 * 是 declared，因为它们在这一版**没有一个不误伤的触发面**——折扣与响应时限的触发
 * 信号在售前会话里，而边界的触发点是邮件分类与自主发送门；宁可让团队在设置里主动
 * 预设，也不要每封售前邮件都弹一张卡。
 *
 * **触发面的两处取舍**（与 KefuAgent 的差别，都写在这里而不是藏在代码里）：
 * 1. KefuAgent 的 `triggers.classificationCategories` 是它自己的邮件类目，我们换成
 *    本仓的 `SupportIntent`；`l3Categories` 原样保留成 `l3_categories`——它现在还没有
 *    消费方（自主发送门是 48 §4 第 3 项、WP55 的活），先登记着，接线那天不用回头改数据。
 * 2. 数据删除那条在 KefuAgent 只有 `l3Categories` 一个触发面；我们额外给它
 *    `intents: ['data_privacy']`，否则在自主发送门接上之前它永远不会被问到，
 *    而"多久内完成删除"是有法定时限的题——宁可早问一次。
 */
import type { BoundaryItem } from '../../types.js'

/**
 * 虚拟产品与服务的业务边界。顺序即注入顺序，**不要重排**。
 */
export const DIGITAL_BOUNDARIES: readonly BoundaryItem[] = [
  {
    id: 'policy.subscription_refund',
    question: '订阅费的退款口径是什么？',
    label: '订阅退款口径',
    options: [
      { id: 'days_7', label: '7 天内无条件退', value: { days: 7 } },
      { id: 'days_14', label: '14 天内无条件退', value: { days: 14 } },
      { id: 'prorated', label: '按未使用比例退', value: { basis: 'prorated' } },
      {
        id: 'cancel_only',
        label: '不退款，只停止续费',
        value: { refund: false, cancel_only: true },
      },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    applies_when: {
      intents: ['returns_refunds', 'billing'],
      risk_terms: ['refund'],
      change_kinds: ['refund'],
      l3_categories: ['refund'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.credit_compensation_cap',
    question: '服务故障时最多补偿到什么程度？',
    label: '故障补偿上限',
    options: [
      { id: 'none', label: '不补偿', value: { allowed: false } },
      { id: 'day_1', label: '补 1 天服务时长', value: { days: 1 } },
      { id: 'day_7', label: '补 7 天服务时长', value: { days: 7 } },
      { id: 'usd_10', label: '等值 ≤ $10 积分', value: { currency: 'USD', amount: 10 } },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    applies_when: {
      intents: ['complaint'],
      change_kinds: ['goodwill_credit'],
      l3_categories: ['compensation', 'outage_sla_claim'],
    },
    wiring: 'enforced',
  },
  {
    id: 'policy.trial_extension',
    question: '客服可以给客户延长多久试用？',
    label: '试用延长权限',
    options: [
      { id: 'none', label: '不延长', value: { allowed: false } },
      { id: 'days_7', label: '最多 7 天', value: { days: 7 } },
      { id: 'days_14', label: '最多 14 天', value: { days: 14 } },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    // 试用延长的诉求几乎全在售前会话里（"还没试完能不能多给几天"）
    applies_when: { intents: ['pre_sales'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.discount_authority',
    question: '客服能给客户什么折扣？',
    label: '折扣权限',
    options: [
      { id: 'none', label: '一律不给', value: { allowed: false } },
      {
        id: 'public_codes',
        label: '只给公开折扣码',
        value: { allowed: true, scope: 'public_codes' },
      },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    applies_when: {},
    wiring: 'declared',
  },
  {
    id: 'policy.data_deletion_sla',
    question: '客户要求删除或导出数据，多久内完成？',
    label: '数据删除/导出时限',
    options: [
      { id: 'instant_self_serve', label: '即时自助完成', value: { self_serve: true } },
      { id: 'days_7', label: '7 天内', value: { days: 7 } },
      { id: 'days_30', label: '30 天内', value: { days: 30 } },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    applies_when: { intents: ['data_privacy'], l3_categories: ['data_deletion_request'] },
    wiring: 'enforced',
  },
  {
    id: 'policy.support_sla',
    question: '人工客服的响应时限对客户承诺到什么程度？',
    label: '人工响应时限',
    options: [
      { id: 'none', label: '不承诺时限', value: { committed: false } },
      { id: 'business_day_1', label: '1 个工作日', value: { business_days: 1 } },
      { id: 'hours_24', label: '24 小时', value: { hours: 24 } },
      { id: 'enterprise_only', label: '企业客户另议', value: { scope: 'enterprise' } },
    ],
    applies_when: {},
    wiring: 'declared',
  },
  // 聊天硬性边界第 8 条已经把默认口径钉死成"一律不代办、只指路"，这条边界只提供
  // **放宽**的出口（收紧一键、放宽走建议卡）。放宽这种事不该由一封邮件顺手问出来，
  // 所以这一版只登记、不发卡。
  {
    id: 'policy.account_actions',
    question: '客服可以代客户做哪些账号操作？',
    label: '账号操作代办范围',
    options: [
      { id: 'never', label: '一律不代办，只指路', value: { mode: 'never' } },
      { id: 'guide_plan_change', label: '仅可引导改套餐', value: { mode: 'guide_plan_change' } },
      { id: 'manual', label: '个案人工决定', value: { manual: true } },
    ],
    applies_when: {},
    wiring: 'declared',
  },
]
