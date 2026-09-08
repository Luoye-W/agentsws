import type { ChatMessage, ToolDef } from '@agentsws/contracts'
import { estimateInputTokens } from '@agentsws/model-gateway'

/** 被 compact 掉的工具结果占位（Commerce Agents `compact_history` 的移植）。 */
export const COMPACT_PLACEHOLDER =
  '[compacted: an earlier tool result was dropped to stay inside the token budget]'

/** 预算耗尽 / 中断时补给未闭合工具调用的占位结果（`close_open_tool_uses`）。 */
export const CLOSED_TOOL_RESULT = (reason: string): string =>
  `[tool call closed without a result: ${reason}]`

export function historyTokens(messages: ChatMessage[], tools: ToolDef[]): number {
  return estimateInputTokens(messages, tools, 4)
}

/**
 * A9 `compact_history`：累计 token 超阈值时，把**最早**的 tool 结果换成占位，直到回到阈值以下。
 * 只动 `role: 'tool'` 的消息：system 前缀是缓存前缀不能动，assistant 的 tool_call 不能动
 * （动了就成了"孤儿工具结果"），user 消息是本次要回答的问题。
 */
export function compactHistory(
  messages: ChatMessage[],
  tools: ToolDef[],
  limitTokens: number,
): { messages: ChatMessage[]; compacted: number } {
  const out = [...messages]
  let compacted = 0
  while (historyTokens(out, tools) > limitTokens) {
    const idx = out.findIndex((m) => m.role === 'tool' && m.content !== COMPACT_PLACEHOLDER)
    const victim = out[idx]
    if (idx < 0 || victim === undefined) break
    out[idx] = { ...victim, content: COMPACT_PLACEHOLDER }
    compacted += 1
  }
  return { messages: out, compacted }
}
