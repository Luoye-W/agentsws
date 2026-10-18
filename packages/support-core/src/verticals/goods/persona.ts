/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/persona.ts（GOODS_PERSONA，
 * S039 FR-004），**逐字节**。
 *
 * 每一条都是 KefuAgent 现网原文。切分口径：从原 prompt 开头到第一个结构段落标记
 * （硬性边界 / 要求 / 规则 / 铁律 / 评分维度 / 判定范围 / 编号列表 / 只输出 JSON）之前；
 * 段落标记本身与其后的规则体在 `rules.ts` 或调用点，因为它们是两个包共用的结构。
 *
 * 第 20 条 `supportDraft` 是 agentsws 自己的起草站点，值 = 本仓 WP54 改造前
 * `prompts/customer-care.ts` 里那一句的**原文逐字节**（静态前缀的字节被测试钉着）。
 */
import { personaFromRows } from '../content.js'
import type { VerticalPersona } from '../types.js'
import { GOODS_TABLES } from './tables.js'

/** WP404：原文在 `persona.content.json`（一个站点一行，id = 站点名），这里拼回原来的形状。 */
export const GOODS_PERSONA: VerticalPersona = personaFromRows(GOODS_TABLES.persona.rows)
