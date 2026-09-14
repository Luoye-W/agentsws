/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/intents.ts
 * (GOODS_CLASSIFIER_RULES / GOODS_CHAT_PLAN), rewritten for agentsws contracts.
 *
 * 默认聊天垂直包 = 实物那一套。WP54 会把它挪进 `support-core/verticals/goods`，
 * 到那时这里只剩 `export { GOODS_CHAT_PACK as DEFAULT_CHAT_PACK }`——所以每个
 * 入口现在就收 `pack` 参数，换包不改调用点。
 *
 * **词表顺序即优先级，不要重排**：顺序进 `matched_terms`，断言按它写。
 */
import type { ChatClassifierRule, ChatMissingInfoRule, ChatPack } from './types.js'

/**
 * 涉钱词面。这是本 WP 那条硬规则的词表形态：
 * **聊天里只答不承诺，涉钱 / 退款 / 改单一律转卡片或邮件。**
 *
 * 它与 `lexicon.ts` 的 `RISK_TERMS` 不是一张表：那张表管的是"这封邮件有风险"，
 * 这张表管的是"这句话碰到了钱"——`review` 是邮件风险词但不是钱，
 * `discount` / `改地址` 是钱与订单但不在那张表里。
 */
export const CHAT_MONEY_TERMS = [
  'refund',
  'refunded',
  'money back',
  'chargeback',
  'charge back',
  'compensation',
  'compensate',
  'discount',
  'coupon',
  'promo code',
  'price match',
  'cancel my order',
  'change my order',
  'change the order',
  'change my address',
  'wrong address',
  'update the address',
  'replacement',
  'reship',
  '退款',
  '退钱',
  '赔偿',
  '补偿',
  '折扣',
  '优惠券',
  '改单',
  '改订单',
  '取消订单',
  '改地址',
  '补发',
  '换新',
  '拒付',
] as const

/** 分类规则表（八类，末条兜底）。 */
export const GOODS_CHAT_CLASSIFIER_RULES: readonly ChatClassifierRule[] = [
  {
    intent: 'return_refund',
    terms: ['refund', 'return', 'chargeback', '退款', '退货', '退换货', '拒付', '投诉'],
    confidence: 0.92,
    risk: 'high',
    reason: '客户提到退款、退货、拒付或投诉，聊天里只能安抚与收集信息，不能承诺。',
  },
  {
    intent: 'order_tracking',
    terms: [
      'tracking',
      'track',
      'where is my',
      'my order',
      'package',
      'parcel',
      'shipment',
      'delivery',
      'shipped',
      'not arrived',
      '订单',
      '物流',
      '运单',
      '包裹',
      '发货了吗',
      '没收到',
      '到哪了',
    ],
    sub_intent: {
      terms: ['delay', 'stuck', 'customs', '延迟', '卡住', '清关'],
      intent: 'shipping_delay',
    },
    confidence: 0.88,
    risk: 'normal',
    reason: '客户在问订单或物流状态，要先拿到订单号再给事实。',
  },
  {
    intent: 'presales_product',
    terms: [
      'before i buy',
      'compatible',
      'shipping cost',
      'shipping fee',
      'how much is shipping',
      'free shipping',
      'delivery time',
      'fit',
      'size',
      'spec',
      'compare',
      '运费',
      '邮费',
      '包邮',
      '多久到',
      '适合',
      '兼容',
      '尺寸',
      '规格',
      '购买前',
      '能买吗',
    ],
    match_product_terms: true,
    confidence: 0.84,
    risk: 'normal',
    reason: '客户在下单前确认产品或运费口径，可以结合商品页与 FAQ 直接回答。',
    drop_order_ref: true,
  },
  {
    intent: 'product_issue',
    terms: [
      'broken',
      'not working',
      'stopped working',
      'stopped charging',
      "won't turn on",
      'wont turn on',
      'does not turn on',
      'no longer works',
      'is dead',
      'faulty',
      'defect',
      'malfunction',
      'damaged',
      '故障',
      '坏了',
      '损坏',
      '发热',
      '异响',
      '失灵',
      '不工作',
      '打不开',
      '开不了机',
      '充不进电',
    ],
    confidence: 0.86,
    risk: 'normal',
    risk_escalation: { terms: ['unsafe', 'danger', '安全', '危险'], risk: 'high' },
    reason: '客户在描述产品故障，需要先补齐证据再判断走哪条售后。',
  },
  {
    intent: 'warranty_parts',
    terms: ['warranty', 'part', 'accessory', '保修', '配件', '补件'],
    confidence: 0.8,
    risk: 'normal',
    reason: '客户在问保修或配件，需要确认订单与具体部件。',
  },
  {
    intent: 'human_handoff',
    terms: ['human', 'real person', 'agent', 'speak to someone', '人工', '真人', '客服'],
    confidence: 0.9,
    risk: 'normal',
    reason: '客户点名要真人，AI 不再自作主张地继续答。',
    drop_order_ref: true,
  },
  {
    intent: 'general_support',
    terms: [],
    confidence: 0.58,
    risk: 'normal',
    reason: '问题还不够明确，先追问关键上下文，而不是泛泛地答。',
  },
]

/**
 * 缺料规则。顺序即拼装顺序——`missing_info` 会原样进对客追问句，
 * 换个顺序就是换一句对客文案。
 */
export const GOODS_CHAT_MISSING_INFO: readonly ChatMissingInfoRule[] = [
  {
    intents: ['order_tracking', 'shipping_delay', 'return_refund'],
    label: '订单号或下单邮箱',
    label_en: 'your order number or the email used at checkout',
    satisfied_by: ['order_ref', 'email'],
  },
  {
    intents: ['product_issue', 'warranty_parts'],
    label: '订单号或下单邮箱',
    label_en: 'your order number or the email used at checkout',
    satisfied_by: ['order_ref', 'email'],
  },
  {
    intents: ['product_issue'],
    label: '问题照片或短视频',
    label_en: 'a photo or short video of the issue',
    satisfied_by: [],
    satisfied_by_terms: ['photo', 'video', '图片', '照片'],
  },
  {
    intents: ['presales_product'],
    label: '具体产品型号或使用场景',
    label_en: 'the product model or your use case',
    satisfied_by: ['product_context'],
  },
]

/**
 * 措辞常量。
 *
 * WP54 的垂直包会覆盖它们；本版取自现有 `support-core` 的口径
 * （`draft.ts` 的回信模板："先回答，再说下一步，不承诺没有依据的事"）。
 */
export const DEFAULT_CHAT_PACK: ChatPack = {
  key: 'goods',
  classifier_rules: GOODS_CHAT_CLASSIFIER_RULES,
  missing_info: GOODS_CHAT_MISSING_INFO,
  non_blocking_intents: ['presales_product'],
  must_review_intents: ['return_refund'],
  handoff_intent: 'human_handoff',
  default_next_question: '我会按现在的商品、订单与客服知识继续帮你处理。',
  collect_info_template: '为了准确处理，请先补充：{items}。',
  answer_then_ask_template: '先按通用情况答复，并在结尾追问：{items}。',
  money_handoff_reply:
    '这件事涉及订单与金额，我在聊天里不能替你定下来。我已经把它交给客服同事核对，稍后在这里或邮件里给你确切答复。',
  assist_reply: '这个问题我想给你一个准确答复，正在跟同事确认，稍等一下。',
  email_follow_up_reply:
    '同事还在确认，别在这里干等了——留个邮箱（有订单号更好），我们把结果发给你。',
  assist_reminder_reply: '还在帮你确认中。如果你不方便等，留个邮箱，我们把结果发到邮件里。',
}
