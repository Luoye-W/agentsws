/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/intents.ts
 * （GOODS_INTENTS / GOODS_CHAT_PLAN / GOODS_PRESALES，S039 FR-005），**逐字节**。
 *
 * 这里是**三套各自独立**的枚举，不是一套到处引：
 *
 * - `values`：聊天分类器与卡面标签用的八值；
 * - `guideCategories`：开场引导六值，是 `values` 的**刻意真子集**（保修 / 配件与
 *   联系人工降级到"其他"，把它们偷偷并进"产品故障"会让商家读到一个错误的分类标注）；
 * - `shadowEvalCategories`：影子质检的第三套词汇，与前两套只有两个 key 重合。
 *
 * 三套分开建模是为了让 digital 能各写各的：它的开场引导子集与质检类目本来就不会
 * 跟聊天意图一一对应。
 *
 * `chatPlan.missingInfo` 的**顺序即拼装顺序**：产品故障那两条必须是「订单号或下单
 * 邮箱」在前、「问题照片或短视频」在后——缺料清单会原样进对客模板（"I just need A,
 * and B"），换个顺序就是换一句对客文案。
 */

import type {
  ChatClassifierRule,
  VerticalChatPlanPack,
  VerticalIntentPack,
  VerticalPresalesPack,
} from '../types.js'
import { GOODS_TRIAGE_SCOPE } from './rules.js'

export const GOODS_INTENT_VALUES = [
  'presales_product',
  'order_tracking',
  'shipping_delay',
  'return_refund',
  'product_issue',
  'warranty_parts',
  'human_handoff',
  'general_support',
] as const

export const GOODS_INTENT_LABELS_ZH: Record<string, string> = {
  presales_product: '售前产品咨询',
  order_tracking: '订单追踪',
  shipping_delay: '物流/发货问题',
  return_refund: '退换货/退款',
  product_issue: '产品使用/故障',
  warranty_parts: '保修/配件',
  human_handoff: '联系人工',
  general_support: '其他客服问题',
}

/**
 * 顺序即优先级：先命中先返回。这张表的顺序被打乱不会抛错，只表现为「某些话被
 * 判成了另一类」——parity guard 钉的是整表对 20 条语料的分类结果。
 *
 * 最后一条没有 `terms`，是兜底。
 */
export const GOODS_CLASSIFIER_RULES: readonly ChatClassifierRule[] = [
  {
    intent: 'return_refund',
    terms: ['refund', 'return', 'chargeback', '退款', '退货', '退换货', '拒付', '投诉'],
    confidenceScore: 92,
    riskLevel: 'high',
    reasonZh: '客户提到退款、退货、拒付或投诉，需要保守处理并进入人工审核边界。',
  },
  {
    intent: 'order_tracking',
    terms: [
      'tracking',
      'track',
      'where is my',
      'where my order is',
      'my order',
      'package',
      'parcel',
      'shipment',
      'delivery',
      'shipped',
      'not arrived',
      "hasn't arrived",
      '订单',
      '物流',
      '运单',
      '包裹',
      '发货了吗',
      '没收到',
      '到哪了',
    ],
    subIntent: {
      terms: ['delay', 'stuck', 'customs', '延迟', '卡住', '清关'],
      intent: 'shipping_delay',
    },
    confidenceScore: 88,
    riskLevel: 'normal',
    reasonZh: '客户在询问订单或物流状态，应优先查询订单、履约和 tracking 上下文。',
  },
  {
    intent: 'presales_product',
    terms: [
      'before i buy',
      'compatible',
      'fit',
      'size',
      'spec',
      'compare',
      '适合',
      '兼容',
      '尺寸',
      '规格',
      '购买前',
      '能买吗',
    ],
    // 提到了 workspace 学到的商品/品牌词本身就是售前信号。
    matchProductTerms: true,
    confidenceScore: 84,
    riskLevel: 'normal',
    reasonZh: '客户在购买前确认产品信息，应结合商品页、FAQ 和品牌知识回答。',
    dropOrderRef: true,
  },
  {
    intent: 'product_issue',
    terms: [
      'broken',
      'not working',
      // 真实客户描述故障有十几种说法。原先只匹配 'not working'，于是
      // "stopped working" / "won't turn on" 落成普通聊天，那些 case 从来没有
      // 去要它需要的那张照片。
      'stopped working',
      'stopped charging',
      'not turn on',
      "won't turn on",
      'wont turn on',
      'does not turn on',
      'no longer works',
      // 不是光秃秃的 'stopped'/'dead'："I stopped by" 和 "the deadline" 都不是
      // 故障，而词首边界规则分不开它们。
      'is dead',
      'went dead',
      'completely dead',
      'faulty',
      'defect',
      'malfunction',
      'damaged',
      'hot',
      'noise',
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
    confidenceScore: 86,
    riskLevel: 'normal',
    riskEscalation: {
      terms: ['unsafe', 'danger', '安全', '危险'],
      riskLevel: 'high',
    },
    reasonZh: '客户在描述产品使用或故障问题，需要先补齐证据，再判断是否转售后动作。',
  },
  {
    intent: 'warranty_parts',
    terms: ['warranty', 'part', 'accessory', 'replacement', '保修', '配件', '补件'],
    confidenceScore: 80,
    riskLevel: 'normal',
    reasonZh: '客户在询问保修、配件或补件，需要确认订单和具体部件。',
  },
  {
    intent: 'human_handoff',
    terms: ['human', 'agent', '人工', '真人', '客服'],
    confidenceScore: 90,
    riskLevel: 'normal',
    reasonZh: '客户明确要求人工，需要给出接管预期并通知值班人员。',
    dropOrderRef: true,
  },
  {
    intent: 'general_support',
    terms: [],
    confidenceScore: 58,
    riskLevel: 'normal',
    reasonZh: '客户问题还不够明确，AI 应先追问关键上下文，而不是直接泛泛回答。',
  },
]

export const GOODS_GUIDE_CATEGORIES = [
  'presales_product',
  'order_tracking',
  'shipping_delay',
  'return_refund',
  'product_issue',
  'general_support',
] as const

/**
 * 点了引导按钮之后 AI 该怎么开这个口 —— 六类各一句。
 *
 * 这些句子进的是 **prompt 的 user 侧**，不是对客文案：它们是给模型的策略，模型
 * 仍然用客户的语言、按既有硬性边界作答。一旦有一句被当成 reply 发出去，那是
 * bug 而不是翻译问题。
 */
export const GOODS_GUIDE_OPENING_STRATEGIES: Record<string, string> = {
  presales_product:
    '客户想了解商品。先确认他关心的点（用途/尺寸/兼容/材质），只依据 products 里的真实在售商品作答，不要编型号和价格。',
  order_tracking:
    '客户要查订单。直接、礼貌地请他给出订单号（仅邮箱在在线聊天里不足以证明身份），拿到之前不要透露任何订单事实。',
  shipping_delay:
    '客户关心物流时效或包裹异常。先说明可查的口径与所需信息（订单号/运单号），不要承诺具体到货日期。',
  return_refund:
    '客户问退换货政策。按知识库里的政策条款说明流程与条件；不要承诺退款、赔偿或具体时限——这类请求设 needs_handoff。',
  product_issue:
    '客户遇到产品问题。先问清具体现象与使用场景；有官方视频/FAQ 链接就附上，不要自己编维修步骤。',
  general_support: '客户点的是「其他问题」。用一句话邀请他把具体问题说出来，不要预设是哪类诉求。',
}

/** 归一化 prompt 的铁律第 5 条 —— 在源码里横跨三个数组元素。 */
export const GOODS_NORMALIZE_ENUM_LINE = [
  '5. intent 只能取：presales_product（售前咨询）/ order_tracking（订单查询）/',
  '   shipping_delay（物流问题）/ return_refund（退换货政策）/ product_issue（产品故障）/',
  '   general_support（其他）。',
].join('\n')

export const GOODS_SHADOW_EVAL_CATEGORIES = [
  'pre_sales',
  'order_query',
  'logistics',
  'return_refund',
  'product_issue',
  'complaint',
  'warranty',
  'other',
] as const

/**
 * 计划构建的 goods 数据（S039 WU-6）—— 每一项都是 `buildCommerceChatResponsePlan`
 * 里那段 if 链的逐字节搬迁，包括 label 的中英两句与「售前不阻塞」这条例外。
 *
 * 顺序即拼装顺序：`product_issue` 的两条必须是「订单号或下单邮箱」在前、
 * 「问题照片或短视频」在后 —— `missingInfo` 数组会原样进对客模板
 * （"I just need A, and B"），换个顺序就是换一句对客文案。
 */
export const GOODS_CHAT_PLAN: VerticalChatPlanPack = {
  missingInfo: [
    {
      intents: ['order_tracking', 'shipping_delay', 'return_refund'],
      label: '订单号或下单邮箱',
      labelEn: 'your order number or the email used at checkout',
      satisfiedBy: ['order_ref', 'email'],
    },
    {
      intents: ['product_issue'],
      label: '订单号或下单邮箱',
      labelEn: 'your order number or the email used at checkout',
      satisfiedBy: ['order_ref', 'email'],
    },
    {
      intents: ['product_issue'],
      label: '问题照片或短视频',
      labelEn: 'a photo or short video of the issue',
      // 词面判据保持原实现的朴素 `includes`（不走词首边界）：'photo' / 'video' /
      // '图片' 三个词一个字节不改。
      satisfiedBy: [],
      satisfiedByTerms: ['photo', 'video', '图片'],
    },
    {
      intents: ['presales_product'],
      label: '具体产品型号或使用场景',
      labelEn: 'the product model or your use case',
      satisfiedBy: ['product_context'],
    },
  ],
  // 售前是买家时刻：停下来先要型号，是最贵的一处摩擦。答完再在结尾追问。
  nonBlockingIntents: ['presales_product'],
  mustReviewIntents: ['return_refund'],
  handoffIntent: 'human_handoff',
  defaultNextQuestionZh: '我会根据当前商品、订单和客服知识继续帮你处理。',
  // 改造前 `chat-service.ts` 里那个 `HANDOFF_REPLY` 常量，逐字节原样（含破折号
  // 与那对括号）：现网每一次转人工、每一次预算/成本闸拦截，客户读到的都是它。
  handoffReplyEn:
    "Thanks for the details — I want to make sure you get an accurate answer, so I'm checking with my team on this. It may take a little while. If you'd like, leave your email (and your order number if you have one) and we'll follow up there, so you don't have to wait here.",
}

/**
 * 售前物料（S039 WU-6 后续）：goods 两样都有 —— 标准层按卖家类型写的售前
 * playbook，以及从商品目录里选出来的在售商品卡。改造前这两处都以
 * `plan.intent === 'presales_product'` 字面量为闸。
 */
export const GOODS_PRESALES: VerticalPresalesPack = {
  intent: 'presales_product',
  standardPlaybook: true,
  productCards: true,
}

export const GOODS_INTENTS: VerticalIntentPack = {
  values: GOODS_INTENT_VALUES,
  labelsZh: GOODS_INTENT_LABELS_ZH,
  classifierRules: GOODS_CLASSIFIER_RULES,
  guideCategories: GOODS_GUIDE_CATEGORIES,
  guideOpeningStrategies: GOODS_GUIDE_OPENING_STRATEGIES,
  normalizeEnumLine: GOODS_NORMALIZE_ENUM_LINE,
  shadowEvalCategories: GOODS_SHADOW_EVAL_CATEGORIES,
  triageScope: GOODS_TRIAGE_SCOPE,
}
