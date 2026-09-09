/**
 * Extracted from KefuAgent src/lib/support/email-triage.ts (classifyEmailHeuristically 的词表)
 * 与 src/lib/support/verticals/goods/boundaries.ts 头注里冻结的 riskTerms 词集，
 * rewritten for agentsws contracts.
 *
 * 词表是这个包唯一允许"看起来像魔法字符串"的地方：它们是产品口径，不是实现细节。
 * 每张表的顺序即命中顺序，命中顺序进 `matched_terms`，所以**不要重排**。
 */

/** 平台 / 账单 / 安全通知：不是客服邮件。 */
export const PLATFORM_TERMS = [
  'shopify',
  'stripe',
  'paypal',
  'facebook ads',
  'google ads',
  'verification code',
  'security alert',
  'monthly statement',
  'invoice available',
] as const

/** 推广、SEO、合作邀约：不是客服邮件。 */
export const MARKETING_TERMS = [
  'guest post',
  'seo service',
  'partnership proposal',
  'collaboration proposal',
  'influencer collaboration',
  'advertising opportunity',
  'unsubscribe',
] as const

/** 商务合作 / 供应链：不是客服邮件。 */
export const BUSINESS_TERMS = [
  'wholesale',
  'distributor',
  'business cooperation',
  'b2b',
  'partnership',
  '采购',
  '供应商',
  '合作',
] as const

/** 典型售前 / 售后诉求。命中其一才进入下面的细分。 */
export const SUPPORT_TERMS = [
  'order',
  'tracking',
  'track',
  'shipment',
  'shipping',
  'delivery',
  'delivered',
  'package',
  'refund',
  'return',
  'exchange',
  'cancel',
  'address',
  'warranty',
  'broken',
  'damaged',
  'missing',
  'wrong item',
  'not working',
  'defective',
  'where is my',
  'when will',
  'how long',
  'customs',
  'tax',
  'duties',
  'size',
  'compatible',
  '售后',
  '订单',
  '物流',
  '退款',
  '退货',
  '换货',
  '损坏',
  '没有收到',
  '怎么用',
] as const

export const RETURN_REFUND_TERMS = [
  'refund',
  'return',
  'exchange',
  'money back',
  '退款',
  '退货',
  '换货',
  '退回',
] as const

export const TRACKING_TERMS = [
  'tracking',
  'track',
  'shipment',
  'delivery',
  'package',
  'where is my',
  'not arrived',
  'lost in transit',
  '物流',
  '快递',
  '没有收到',
  '未收到',
] as const

export const DAMAGE_TERMS = [
  'broken',
  'damaged',
  'defective',
  'not working',
  'scratch',
  'scratched',
  'missing',
  'wrong item',
  '损坏',
  '坏了',
  '少件',
  '错发',
  '漏发',
] as const

/** 取消 / 改单 / 改地址。 */
export const CANCELLATION_TERMS = [
  'cancel',
  'change my address',
  'wrong address',
  'update the address',
  'change the order',
  '取消',
  '改地址',
  '地址写错',
  '改订单',
] as const

export const WARRANTY_TERMS = ['warranty', 'guarantee', 'repair', '保修', '质保', '维修'] as const

export const PRODUCT_QUESTION_TERMS = [
  'compatible',
  'size',
  'manual',
  'how do i use',
  'how to use',
  'instructions',
  'specification',
  '怎么用',
  '尺寸',
  '兼容',
  '说明书',
] as const

/** 投诉 / 升级信号（比 damage 更强，进 urgency）。 */
export const COMPLAINT_TERMS = [
  'complaint',
  'unacceptable',
  'lawsuit',
  'lawyer',
  'chargeback',
  'dispute',
  'bad review',
  'one star',
  'report you',
  'consumer protection',
  '投诉',
  '差评',
  '曝光',
  '起诉',
  '律师',
] as const

export const SPAM_TERMS = [
  'viagra',
  'crypto investment',
  'bitcoin giveaway',
  'work from home opportunity',
  'you have won',
  'click here to claim',
] as const

/**
 * 风险词。词面取自 KefuAgent `deriveRiskLevel` 的冻结词集
 * （refund / chargeback / replace / damaged / broken / scratch(ed) /
 *  unsafe / danger / lawsuit / review / amazon claim），不新增词面。
 */
export const RISK_TERMS = [
  'refund',
  'chargeback',
  'replace',
  'damaged',
  'broken',
  'scratch',
  'scratched',
  'unsafe',
  'danger',
  'lawsuit',
  'review',
  'amazon claim',
] as const

/**
 * "缺什么资料"的词面 → 要什么。取自 KefuAgent `deriveMissingInfoSummary`
 * （damaged / broken / scratch → 照片；tracking / customs → 运单号；refund → 订单号）。
 */
export const MISSING_INFO_RULES: readonly { terms: readonly string[]; need: string }[] = [
  { terms: ['damaged', 'broken', 'scratch', 'scratched', '损坏', '坏了'], need: 'photos' },
  { terms: ['tracking', 'customs', 'duties', '物流', '关税'], need: 'tracking_number' },
  { terms: ['refund', 'return', '退款', '退货'], need: 'order_ref' },
]

/** 客户声称我们承诺过什么。 */
export const COMMITMENT_PATTERNS: readonly RegExp[] = [
  /\byou (?:promised|said|told me|guaranteed)\b[^.!?\n]{0,120}/i,
  /\byour (?:agent|colleague|team) (?:promised|said|confirmed)\b[^.!?\n]{0,120}/i,
  /(?:你们|客服)(?:答应|承诺|保证|说过)[^。！？\n]{0,60}/,
]

/** 期限线索。 */
export const DEADLINE_PATTERNS: readonly RegExp[] = [
  /\b(?:by|before|no later than)\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d{1,2}\s*(?:st|nd|rd|th)?\s*(?:of\s+)?[a-z]{3,9})\b/i,
  /\bwithin\s+\d{1,3}\s*(?:hours?|days?|weeks?)\b/i,
  /(?:在|于)?\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:前|之前)/,
  /\d{1,3}\s*(?:天|小时|周)(?:内|以内)/,
]

/** 紧急语气。 */
export const URGENCY_TERMS = [
  'urgent',
  'asap',
  'immediately',
  'right now',
  'still waiting',
  '紧急',
  '马上',
  '立刻',
  '还没',
] as const
