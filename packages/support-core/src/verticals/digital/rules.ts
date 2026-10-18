/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/rules.ts
 * （DIGITAL_CHAT_RULES / DIGITAL_EMAIL_RULES / DIGITAL_TRIAGE_SCOPE，S039 FR-020），**逐字节**。
 *
 * 两类条目，处理方式不同：
 *
 * 1. **产品 doc 标了「同现状」的**——从 goods 包**按编号取用同一个字符串**，不抄一份。
 *    抄一份看着更好读，但那是两份会各自漂移的原文；引用则永远相等，且 goods 那侧
 *    改了编号会在导入时当场抛错，而不是让 digital 静默少一条边界。
 * 2. **doc 给了 digital 版本的**——inline 写在这里，因为读这个文件的人要能一眼看全
 *    AI 到底被告知了什么。
 *
 * 与 goods 的结构差异只有一处：**digital 没有规则 6a**（它讲 `products` 里抓取快照的
 * 价格，虚拟产品不跑商品枚举，这条规则没有指涉对象）。于是 `numbered` 比 goods 少一行，
 * `boundaryRuleIndex` 相应是 11 而不是 12。
 *
 * 一条红线（`test/vertical-parity.test.ts` 断言）：拼接结果里**不得出现「订单 / 物流 /
 * Shopify」**。不是文风问题——digital 的 AI 手上根本没有订单上下文，提到订单就只能是编的。
 */

import { chatRulesFromRows, emailRulesFromRows, triageScopeFromRows } from '../content.js'
import { GOODS_TABLES } from '../goods/tables.js'
import type { VerticalChatRules, VerticalEmailRules } from '../types.js'
import { DIGITAL_TABLES } from './tables.js'

/**
 * WP404：原文在 `rules.content.json`（每条一行，id = 集合.编号；「同现状」那几行写 `same_as: goods`，按 id 取 goods 包同一行），
 * 这里拼回原来的形状。`boundaryRuleIndex`（第 11 条插在第几行）是结构，留在代码里。
 */
export const DIGITAL_CHAT_RULES: VerticalChatRules = chatRulesFromRows(
  DIGITAL_TABLES.rules.rows,
  11,
  { goods: GOODS_TABLES.rules.rows },
)

export const DIGITAL_EMAIL_RULES: VerticalEmailRules = emailRulesFromRows(
  DIGITAL_TABLES.rules.rows,
  { goods: GOODS_TABLES.rules.rows },
)

/**
 * 邮箱分流范围（产品 doc §3.2 末条）。
 *
 * digital 与 goods 的**根本差异在这里**：goods 把「账单、安全提醒」按**话题**
 * 整类排除（电商商家收到的账单邮件基本都是平台发来的通知）；SaaS 不成立 ——
 * 客户写来问「我为什么被扣了两次费」是标准客服工单，Stripe 发来的月度发票不是。
 * 同一个词、两个方向，所以 digital 必须按**方向**判定，而正/负两行文字就是这条
 * 判据进模型的唯一形态（`email-triage.ts` 只拼这两行）。
 */
export const DIGITAL_TRIAGE_SCOPE = triageScopeFromRows(DIGITAL_TABLES.rules.rows)
