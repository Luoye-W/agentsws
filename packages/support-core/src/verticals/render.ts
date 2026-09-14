/**
 * Extracted from KefuAgent src/lib/support/verticals/render.ts（`renderChatRuleLines`），
 * rewritten for agentsws contracts.
 *
 * 包文件只放数据；"怎么把数据拼成一段话"是纯函数，住在这里。两件事：
 *
 * 1. `renderChatRules`：把编号规则拼成给模型看的那一段，并保住规则 11 的**条件语义**
 *    （商家没配额外边界时，那一行求值成空串，在规则 10 与 12 之间留下一个空行）。
 * 2. `fillTemplate`：回信模板的占位替换。只做整串替换，不求值任何表达式——
 *    模板串里出现 `{amount}` 就替换，出现别的花括号原样留着。
 */
import type { VerticalChatRules } from './types.js'

/**
 * 聊天硬性边界的完整行列表。
 *
 * `boundaries` 是商家额外配的边界短语；空数组时规则 11 那一行是**空串**而不是不存在
 * ——那个空行是 prompt 的一部分，拍平它会改掉每一次聊天的字节。
 */
export function renderChatRules(
  rules: VerticalChatRules,
  boundaries: readonly string[] = [],
): string[] {
  const line =
    boundaries.length === 0
      ? ''
      : rules.boundaryRuleTemplate.replace('{boundaries}', boundaries.join('；'))
  const out = [...rules.numbered]
  out.splice(rules.boundaryRuleIndex, 0, line)
  return out
}

/** 占位替换：`{key}` → `values[key]`。表里没有的 key 原样留着（好定位漏填）。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  let out = template
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value)
  return out
}
