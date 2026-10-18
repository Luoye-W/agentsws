/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/rules.ts
 * （GOODS_CHAT_RULES / GOODS_EMAIL_RULES / GOODS_TRIAGE_SCOPE，S039 FR-005），**逐字节**。
 *
 * 全部是 KefuAgent 现网 `chat-service.ts` / `service.ts` 的原文。它们是**产品口径**，
 * 不是实现细节：一条一条地写着 AI 到底被告知了什么不许做。
 *
 * `boundaryRuleIndex` / `boundaryRuleTemplate` 是规则 11——它在原代码里是条件插值，
 * 商家没配额外边界时整行求值成空串，在规则 10 与 12 之间留下一个**空行**。
 * 这个空行是每一次聊天 prompt 的一部分，所以不是可以顺手拍平的细节，
 * 条件语义由 `renderChatRules` 保住。
 *
 * 21–28（邮件）/ 19–26（聊天）本身移植自 Anthropic 开源 commerce-agents 的
 * customer-care skill（Apache-2.0）。
 *
 * 注：本文件里的字段名（`order_context` / `knowledge_base` / `lookup_status` …）是
 * KefuAgent 那一侧 prompt 的槽位名。**先原样收编**——L3 第 11 项（在线聊天流水线）
 * 落地时才会有装配层去填它们，那时改的是装配层的映射，不是这几百行产品口径。
 */

import { chatRulesFromRows, emailRulesFromRows, triageScopeFromRows } from '../content.js'
import type { VerticalChatRules, VerticalEmailRules } from '../types.js'
import { GOODS_TABLES } from './tables.js'

/**
 * WP404：原文在 `rules.content.json`（每条一行，id = 集合.编号），
 * 这里拼回原来的形状。`boundaryRuleIndex`（第 11 条插在第几行）是结构，留在代码里。
 */
export const GOODS_CHAT_RULES: VerticalChatRules = chatRulesFromRows(GOODS_TABLES.rules.rows, 12)

export const GOODS_EMAIL_RULES: VerticalEmailRules = emailRulesFromRows(GOODS_TABLES.rules.rows)

export const GOODS_TRIAGE_SCOPE = triageScopeFromRows(GOODS_TABLES.rules.rows)
