import type { ChatMessage, Iso8601, ToolDef } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { GatewayError } from './types.js'

/**
 * 17 §1 装配顺序：静态前缀（persona、skills 索引、工具定义）在 breakpoint 之前，字节稳定。
 * 默认断点 = 开头连续的 system 消息条数；工具定义永远算进静态前缀。
 */
export function staticPrefixLength(messages: ChatMessage[], cacheBreakpoints?: number[]): number {
  const explicit = cacheBreakpoints?.[0]
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0 || explicit > messages.length) {
      throw new GatewayError('invalid_input', 'cache_breakpoints[0] out of range', {
        breakpoint: explicit,
        messages: messages.length,
      })
    }
    return explicit
  }
  let n = 0
  while (n < messages.length && messages[n]?.role === 'system') n += 1
  return n
}

function normalizeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.name !== undefined) out.name = m.name
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id
  return out
}

function normalizeTool(t: ToolDef): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.input_schema }
}

/** 静态前缀的 canonical 哈希：同一前缀两次装配必然相同，改一条 system 消息必然不同。 */
export function staticPrefixHash(
  messages: ChatMessage[],
  tools?: ToolDef[],
  cacheBreakpoints?: number[],
): string {
  const n = staticPrefixLength(messages, cacheBreakpoints)
  return sha256(
    canonicalJson({
      messages: messages.slice(0, n).map(normalizeMessage),
      tools: (tools ?? []).map(normalizeTool),
    }),
  )
}

/**
 * 22 §2 缓存纪律：时间戳类内容截到小时，否则每分钟都换前缀、缓存永不命中。
 * 调用方在装配静态前缀前把时间过一遍这个函数。
 */
export function truncateToHour(iso: Iso8601): Iso8601 {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms))
    throw new GatewayError('invalid_input', 'not an ISO-8601 timestamp', { iso })
  const d = new Date(ms)
  d.setUTCMinutes(0, 0, 0)
  return `${d.toISOString().slice(0, 13)}:00:00Z`
}
