/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/persona.ts（DIGITAL_PERSONA，
 * S039 FR-020），**逐字节**。
 *
 * 口径：**出海软件产品（App / SaaS / 在线服务）**。
 *
 * 逐条对着 `goods/persona.ts` 的同名 key 改写，**句式保持同构**——不是因为好看，
 * 是因为这些段落各自嵌在一段现成的 prompt 里（后面紧跟"硬性边界：""要求："这类
 * 结构段落），句式一旦跑偏，接上去的那半段就读不通。goods 那侧每一处的句子骨架
 * 都已经被现网验证过一遍，digital 只换名词与事实源：
 *
 *   店铺 → 产品 / 团队；订单事实 → 账户事实；售前导购 → 售前答疑。
 *
 * WP404：原来抽成常量 `BIZ` 的那个定语（出海软件产品（App / SaaS / 在线服务））在数据文件里已展开写进每一句。
 *
 * 键与 goods 一一对应（少一键就有一处 prompt 插值成 `undefined`，parity guard 会当场红）。
 */
import { personaFromRows } from '../content.js'
import type { VerticalPersona } from '../types.js'
import { DIGITAL_TABLES } from './tables.js'

/** WP404：原文在 `persona.content.json`（一个站点一行，id = 站点名），这里拼回原来的形状。 */
export const DIGITAL_PERSONA: VerticalPersona = personaFromRows(DIGITAL_TABLES.persona.rows)
