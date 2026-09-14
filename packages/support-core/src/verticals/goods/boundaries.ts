/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/boundaries.ts
 * （GOODS_POLICY_BOUNDARIES，10 条）+ 中台侧新增 5 条，rewritten for agentsws contracts。
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
 *
 * WP54：本文件从 `src/boundaries.ts` 搬到垂直包里——registry 本来就是**按垂直分**的
 * （SaaS 的钱长在订阅退款与故障补偿上，不在退货运费和关税上）。
 * `src/boundaries.ts` 只留判定与答题那几个纯函数，并按 `getVerticalPack` 取 registry。
 */
import type { BoundaryItem } from '../../types.js'

/**
 * 实物商品的业务边界。
 *
 * 顺序即 prompt 注入顺序与聚合读模型的列出顺序——**不要重排**。
 * `applies_when` 任一维度命中即触发（OR）。
 */
export const GOODS_BOUNDARIES: readonly BoundaryItem[] = [
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
