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

/** WP260：要产出东西的运行（`RunRequest.produce`）怎么压。 */
export interface CompactPolicy {
  /** 最近这几条工具结果原样留着（「刚读完、马上要改」的那几份）。 */
  keepRecent: number
  /** 压到阈值的几成为止（不是刚好压回阈值：那样之后每一步都要再压一次）。缺省 0.7。 */
  targetRatio?: number
  /** 被压的那条换成什么（按 `tool_call_id`）；不给 / 回 undefined = {@link COMPACT_PLACEHOLDER}。 */
  summaryOf?(call_id: string): string | undefined
  /** 这条工具调用读 / 写的是哪个文件（被后来的读 / 写顶替了的那条先压）。 */
  touchOf?(
    name: string,
    input: Record<string, unknown>,
  ): { op: 'read' | 'write'; path: string; key: string } | undefined
  /** 已经压过的那条认得出来（开头的记号）。 */
  compactedMark?: string
}

/**
 * WP260：按工作类型压（只给 `produce` 的运行用；别的运行照旧 {@link compactHistory}，一个字节不变）。
 *
 * 与老的那一版三处不同：
 * 1. **先压过时的**：同一个文件后来又读过（同一段）或写过，前面那次读的结果先换掉；
 * 2. **最近 `keepRecent` 条不压**：刚读完马上要照着改的那几份留着；
 * 3. **换成摘要不换空占位**：读过哪个文件、多长、要点（schema 的设置 id、模板的分区顺序……），
 *    并且压到阈值的七成（`targetRatio`）才停——过了线之后不至于每一步都压一次。
 */
export function compactHistoryFor(
  messages: ChatMessage[],
  tools: ToolDef[],
  limitTokens: number,
  policy: CompactPolicy,
): { messages: ChatMessage[]; compacted: number } {
  const target = Math.floor(limitTokens * (policy.targetRatio ?? 0.7))
  const out = [...messages]
  const isCompacted = (m: ChatMessage): boolean =>
    m.content === COMPACT_PLACEHOLDER ||
    (policy.compactedMark !== undefined &&
      typeof m.content === 'string' &&
      m.content.startsWith(policy.compactedMark))
  // tool_call_id → 调用（名字 + 入参），从 assistant 的 tool_calls 里认
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
  for (const m of out)
    for (const c of m.tool_calls ?? [])
      calls.set(c.id, {
        name: c.name,
        input:
          c.input !== null && typeof c.input === 'object'
            ? (c.input as Record<string, unknown>)
            : {},
      })
  const toolIdx = out.flatMap((m, i) => (m.role === 'tool' ? [i] : []))
  const protectedIdx = new Set(toolIdx.slice(Math.max(0, toolIdx.length - policy.keepRecent)))
  const touch = (i: number) => {
    const id = out[i]?.tool_call_id
    const call = id === undefined ? undefined : calls.get(id)
    return call === undefined ? undefined : policy.touchOf?.(call.name, call.input)
  }
  const superseded = (i: number): boolean => {
    const mine = touch(i)
    if (mine?.op !== 'read') return false
    return toolIdx.some((j) => {
      if (j <= i) return false
      const later = touch(j)
      return (
        later !== undefined &&
        ((later.op === 'read' && later.key === mine.key) ||
          (later.op === 'write' && later.path === mine.path))
      )
    })
  }
  // 过时的（后来又读过同一段 / 写过同一个文件）最近的也压：原文在后面那次里还有
  const stale = toolIdx.filter(superseded)
  const order = [...stale, ...toolIdx.filter((i) => !protectedIdx.has(i) && !stale.includes(i))]
  let compacted = 0
  for (const idx of order) {
    if (historyTokens(out, tools) <= target) break
    const victim = out[idx]
    if (victim === undefined || isCompacted(victim)) continue
    const id = victim.tool_call_id
    const summary = id === undefined ? undefined : policy.summaryOf?.(id)
    out[idx] = { ...victim, content: summary ?? COMPACT_PLACEHOLDER }
    compacted += 1
  }
  return { messages: out, compacted }
}
