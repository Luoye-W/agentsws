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

import {
  classifierRulesFromRows,
  labelsFromRows,
  missingInfoFromRows,
  normalizeEnumLineFromRows,
  openingStrategiesFromRows,
  planTextFromRows,
} from '../content.js'
import type {
  VerticalChatClassifierRule,
  VerticalChatPlanPack,
  VerticalIntentPack,
  VerticalPresalesPack,
} from '../types.js'
import { GOODS_TRIAGE_SCOPE } from './rules.js'
import { GOODS_TABLES } from './tables.js'

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

export const GOODS_INTENT_LABELS_ZH: Record<string, string> = labelsFromRows(
  GOODS_TABLES.intents.rows,
)

/**
 * 顺序即优先级：先命中先返回。这张表的顺序被打乱不会抛错，只表现为「某些话被
 * 判成了另一类」——parity guard 钉的是整表对 20 条语料的分类结果。
 *
 * 最后一条没有 `terms`，是兜底。
 */
export const GOODS_CLASSIFIER_RULES: readonly VerticalChatClassifierRule[] =
  classifierRulesFromRows(GOODS_TABLES.intents.rows)

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
export const GOODS_GUIDE_OPENING_STRATEGIES: Record<string, string> = openingStrategiesFromRows(
  GOODS_TABLES.intents.rows,
)

/** 归一化 prompt 的铁律第 5 条 —— 在源码里横跨三个数组元素。 */
export const GOODS_NORMALIZE_ENUM_LINE = normalizeEnumLineFromRows(GOODS_TABLES.intents.rows)

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
  missingInfo: missingInfoFromRows(GOODS_TABLES.intents.rows),
  // 售前是买家时刻：停下来先要型号，是最贵的一处摩擦。答完再在结尾追问。
  nonBlockingIntents: ['presales_product'],
  mustReviewIntents: ['return_refund'],
  handoffIntent: 'human_handoff',
  defaultNextQuestionZh: planTextFromRows(GOODS_TABLES.intents.rows, 'defaultNextQuestionZh'),
  // WP404：两句计划文案（与原注释）在 `intents.content.json`（kind = plan_text）
  handoffReplyEn: planTextFromRows(GOODS_TABLES.intents.rows, 'handoffReplyEn'),
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
