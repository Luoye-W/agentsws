/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/intents.ts
 * （DIGITAL_INTENTS / DIGITAL_CHAT_PLAN / DIGITAL_PRESALES，S039 FR-020/021），**逐字节**。
 *
 * 与 goods 同构的三套独立枚举。分开建模的收益在这里兑现——digital 的开场引导只卖
 * 五类 + 兜底，质检类目又是另一套写法，硬要一一对应只会逼出一堆没人点的按钮。
 *
 * **红线（parity guard 对词表源做断言）**：这张表里绝不允许出现
 * `package / delivery / track / shipment / parcel / my order`。它们在软件语境里全是
 * 高频误伤词——"email delivery failed" 是发信故障不是物流，"npm package" 是依赖，
 * "tracking link" 是埋点，"my order" 在 SaaS 里通常指订阅账单。goods 那张表把它们
 * 全列为订单 / 物流信号，原样搬过来会让 digital 的每一次故障报告都被判成查快递。
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
import { DIGITAL_TRIAGE_SCOPE } from './rules.js'
import { DIGITAL_TABLES } from './tables.js'

/** `DigitalChatIntent` 十值（产品 doc §3.2 表），顺序即标签表顺序。 */
export const DIGITAL_INTENT_VALUES = [
  'presales_plan',
  'how_to',
  'bug_report',
  'billing_credits',
  'account_access',
  'integration_setup',
  'data_privacy',
  'feature_request',
  'human_handoff',
  'general_support',
] as const

export const DIGITAL_INTENT_LABELS_ZH: Record<string, string> = labelsFromRows(
  DIGITAL_TABLES.intents.rows,
)

/**
 * 顺序即优先级：先命中先返回，最后一条无 `terms` 是兜底。
 *
 * 排序逻辑与 goods 同源 —— **钱和账号排在前面**：一句话同时像账单问题和使用方法
 * 时，判成账单的代价是多转一次人工，判成使用方法的代价是 AI 拿着知识库去回答一个
 * 它没有事实依据的扣费问题。
 *
 * 几处刻意的取舍：
 * - `account_access` 不收裸词 `account`，否则 "delete my account" 会被它截走，
 *   而那是数据删除请求（L3）；
 * - `feature_request` 排在 `bug_report` 之前：它的词面（"when will you support X"、
 *   "roadmap"、"什么时候上线"）比故障词更长更具体，而反过来 "when will you support
 *   SSO" 会先被 `integration_setup` 的 `sso` 截走，问路线图的人就被当成来配集成的；
 * - `bug_report` 排在 `integration_setup` 前面：接入过程中报错先当故障收集复现
 *   信息，比先讲一遍集成文档有用；
 * - `how_to` 的 `can i` 极宽，所以它排在倒数第二 —— 前面那些更具体的意图先取走
 *   "can i get a refund" / "can i change my email" 这类。
 */
export const DIGITAL_CLASSIFIER_RULES: readonly VerticalChatClassifierRule[] =
  classifierRulesFromRows(DIGITAL_TABLES.intents.rows)

/**
 * 开场引导类目 —— `values` 的**刻意真子集**（同 goods 的设计，research D-06）。
 *
 * `integration_setup` / `data_privacy` / `feature_request` / `human_handoff` 由
 * `normalizeGuideCategory` 降级到 `general_support`：开场引导是给客户看的几个按钮，
 * 「数据与隐私」「功能建议」这两类一年也点不了几次，占一个按钮位不如让位给
 * 「其他问题」；`human_handoff` 本来就有自己的转人工路径，不该混进意图按钮。
 * 兜底类必须是最后一个（`normalizeGuideCategory` 取末位作 fallback）。
 */
export const DIGITAL_GUIDE_CATEGORIES = [
  'presales_plan',
  'how_to',
  'bug_report',
  'billing_credits',
  'account_access',
  'general_support',
] as const

/**
 * 点了引导按钮之后 AI 该怎么开这个口 —— 六类各一句。
 *
 * 这些句子进的是 **prompt 的 user 侧**，不是对客文案：它们是给模型的策略，模型
 * 仍然用客户的语言、按既有硬性边界作答。一旦有一句被当成 reply 发出去，那是
 * bug 而不是翻译问题。
 */
export const DIGITAL_GUIDE_OPENING_STRATEGIES: Record<string, string> = openingStrategiesFromRows(
  DIGITAL_TABLES.intents.rows,
)

/**
 * 归一化 prompt 的铁律第 5 条 —— 枚举 + 中文释义。
 *
 * 值域必须与 `DIGITAL_GUIDE_CATEGORIES` 一致：模型吐出枚举外的值会被
 * `normalizeGuideCategory` 静默降级成兜底类，商家在候选表里就会看到一堆
 * 「其他」。跨三行是为了和 goods 的换行形态一致（同一个 join('\n')）。
 */
export const DIGITAL_NORMALIZE_ENUM_LINE = normalizeEnumLineFromRows(DIGITAL_TABLES.intents.rows)

/**
 * shadow 质检的第三套词汇。
 *
 * 与聊天意图刻意不同名：质检看的是「这类工单 AI 写得怎么样」，颗粒度比客户按钮
 * 粗一档（接入与集成、数据与隐私在质检里合成 `integration` / `privacy` 就够用）。
 */
export const DIGITAL_SHADOW_EVAL_CATEGORIES = [
  'pre_sales',
  'how_to',
  'bug_report',
  'billing',
  'account',
  'integration',
  'privacy',
  'other',
] as const

/**
 * 计划构建的 digital 数据（S039 WU-6）。
 *
 * 三条纪律，都是从这个包已有的规则里读出来的，不是新发明的产品行为：
 *
 * 1. **「订单号」一个字都不许出现。** digital 的 AI 手上没有订单，也没有
 *    `account_context`（`context: null`）；账单与账号类该收的是**注册邮箱**
 *    ——chatRules 1a 的原话就是「请对方在已登录的应用内打开聊天，或留下注册
 *    邮箱由我们邮件跟进」，not_found 时「请对方核对注册邮箱」。
 * 2. **故障类收复现信息**，口径抄 chatRules 7：在哪一步、看到什么提示、大致
 *    发生时间。文本里没法可靠判定「他是不是已经说清了这三样」，所以这一条恒缺
 *    —— 而它同时是 non-blocking 的，后果只是 AI 答完在结尾追问，不是拿模板堵人。
 * 3. **V0 的 digital 不产生 `collect_info`**：有缺料规则的三个意图全在
 *    `nonBlockingIntents` 里。理由是这个垂直的答案来自文档与知识库，先答一句
 *    再追问，永远优于「先答录一张表」。真要堵，堵的也该是身份核实（V1 的
 *    `account_context`），不是 V0 的一个模板。
 *
 * `mustReviewIntents` 的两条来自本文件分类器规则自己的 `reasonZh`：数据/隐私
 * 「删除/导出有法定时限，绝不能自行承诺，必须转人工」、功能建议「绝不承诺上线
 * 时间，需要转人工」。账单与账号类不列在这里 —— 它们由**风险映射**升到 high
 * （退款/重复扣费/拒付、盗号/未授权访问），走的是同一道审核门，一步没放宽。
 */
export const DIGITAL_CHAT_PLAN: VerticalChatPlanPack = {
  missingInfo: missingInfoFromRows(DIGITAL_TABLES.intents.rows),
  nonBlockingIntents: ['billing_credits', 'account_access', 'bug_report'],
  mustReviewIntents: ['data_privacy', 'feature_request'],
  handoffIntent: 'human_handoff',
  defaultNextQuestionZh: planTextFromRows(DIGITAL_TABLES.intents.rows, 'defaultNextQuestionZh'),
  // WP404：两句计划文案（与原注释）在 `intents.content.json`（kind = plan_text）
  handoffReplyEn: planTextFromRows(DIGITAL_TABLES.intents.rows, 'handoffReplyEn'),
}

/**
 * 售前物料（S039 WU-6 后续）。
 *
 * digital 的售前问题（套餐、价格、能不能做某件事）必须走 **presales 阶段的知识
 * 检索** —— 答案都在 pricing / docs 页里。另外两样都关掉，且都不是"暂缺"：
 * 没有商品目录（`knowledge.enumerateCatalog=false`），推不出在售商品卡；标准层
 * 售前 playbook 是按实物卖家类型写的，digital 的标准库是 V3（§3.9）——让它去吃
 * 一份 generic 的实物售前话术，比没有更糟。
 */
export const DIGITAL_PRESALES: VerticalPresalesPack = {
  intent: 'presales_plan',
  standardPlaybook: false,
  productCards: false,
}

export const DIGITAL_INTENTS: VerticalIntentPack = {
  values: DIGITAL_INTENT_VALUES,
  labelsZh: DIGITAL_INTENT_LABELS_ZH,
  classifierRules: DIGITAL_CLASSIFIER_RULES,
  guideCategories: DIGITAL_GUIDE_CATEGORIES,
  guideOpeningStrategies: DIGITAL_GUIDE_OPENING_STRATEGIES,
  normalizeEnumLine: DIGITAL_NORMALIZE_ENUM_LINE,
  shadowEvalCategories: DIGITAL_SHADOW_EVAL_CATEGORIES,
  triageScope: DIGITAL_TRIAGE_SCOPE,
}
