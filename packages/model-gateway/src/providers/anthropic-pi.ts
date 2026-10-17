/**
 * WP374：我们的消息 ↔ 官方 pi-ai 的 `Context` / `AssistantMessage`（Anthropic 兼容口用）。
 *
 * 出处：照 `packages/dsh-adapter/src/subscription-chat.ts` 的 `toPiContext`（WP362，本仓库）改的——
 * 网关包不能反过来依赖 dsh-adapter，所以这里放一份走 `anthropic-messages` 的；多出来的只有两样：
 * assistant 轮带上 Anthropic 的思考块（含签名，下一轮原样带回），以及回包里把思考块收成回放。
 */
import type { ChatContentPart, ChatMessage, ReasoningReplay, ToolDef } from '@agentsws/contracts'

type PiText = { type: 'text'; text: string }
type PiImage = { type: 'image'; data: string; mimeType: string }
type PiThinking = {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
type PiToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
export type PiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: (PiText | PiImage)[]; timestamp: number }
  | {
      role: 'assistant'
      content: (PiText | PiThinking | PiToolCall)[]
      api: string
      provider: string
      model: string
      usage: Record<string, unknown>
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | {
      role: 'toolResult'
      toolCallId: string
      toolName: string
      content: (PiText | PiImage)[]
      isError: boolean
      timestamp: number
    }

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: { name: string; description: string; parameters: unknown }[]
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function textOf(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function partsOf(content: string | ChatContentPart[]): (PiText | PiImage)[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : { type: 'image' as const, data: p.data, mimeType: p.mime },
  )
}

/** 工具参数在 pi-ai 那里必须是对象；模型回过非对象的，包一层（不丢内容）。 */
function argsOf(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (isRecord(parsed)) return parsed
    } catch {
      // 不是 JSON：原样包一层
    }
  }
  return input === undefined ? {} : { value: input }
}

/**
 * 上一轮的思考块：**只认这个模型自己产出的**（签名跨模型不通用，官方同一条）；换了模型就不带。
 */
function thinkingOf(replay: ReasoningReplay | undefined, model: string): PiThinking[] {
  if (replay?.kind !== 'anthropic-messages' || replay.model !== model) return []
  return replay.blocks.map((b) => ({
    type: 'thinking' as const,
    thinking: b.thinking,
    ...(b.signature === undefined ? {} : { thinkingSignature: b.signature }),
    ...(b.redacted === true ? { redacted: true } : {}),
  }))
}

/**
 * `ChatMessage[]` → pi-ai 的 `Context`。
 *
 * - 开头连着的那几条 system → `systemPrompt`；之后再出现的 system 原样作 pi-ai 的 system 消息
 *   （pi-ai 按模型声明决定原位送还是并进开头）；
 * - assistant：上一轮的思考块（同一个模型才带）→ 正文 → 工具调用；
 * - 工具结果 → `toolResult`（工具名缺了就从上一条 assistant 里补）；图片部件原样（base64 + mime）。
 */
export function toAnthropicPiContext(
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[] | undefined,
  route: { api: string; provider: string; model: string },
  now: number = Date.now(),
): PiContext {
  const system: string[] = []
  const out: PiMessage[] = []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.content)
      if (text === '') continue
      if (out.length === 0) system.push(text)
      else out.push({ role: 'system', content: text })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: partsOf(m.content), timestamp: now })
      continue
    }
    if (m.role === 'assistant') {
      const content: (PiText | PiThinking | PiToolCall)[] = [
        ...thinkingOf(m.reasoning_replay, route.model),
      ]
      const text = textOf(m.content)
      if (text !== '') content.push({ type: 'text', text })
      for (const c of m.tool_calls ?? []) {
        toolNames.set(c.id, c.name)
        content.push({ type: 'toolCall', id: c.id, name: c.name, arguments: argsOf(c.input) })
      }
      out.push({
        role: 'assistant',
        content,
        api: route.api,
        provider: route.provider,
        model: route.model,
        usage: EMPTY_USAGE,
        stopReason: (m.tool_calls ?? []).length > 0 ? 'toolUse' : 'stop',
        timestamp: now,
      })
      continue
    }
    const id = m.tool_call_id ?? ''
    out.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: m.name ?? toolNames.get(id) ?? 'tool',
      content: partsOf(m.content),
      isError: false,
      timestamp: now,
    })
  }
  return {
    ...(system.length === 0 ? {} : { systemPrompt: system.join('\n\n') }),
    messages: out,
    ...(tools === undefined || tools.length === 0
      ? {}
      : {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          })),
        }),
  }
}

/** pi-ai 回的那条 assistant（只用到的几格）。 */
export interface PiAssistantLike {
  content?: {
    type: string
    text?: string
    thinking?: string
    thinkingSignature?: string
    redacted?: boolean
    id?: string
    name?: string
    arguments?: unknown
  }[]
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  stopReason?: string
  errorMessage?: string
}

/** pi-ai 的 assistant → 正文、工具调用、思考（原文 + 原样回放）、token（「含缓存」口径）。 */
export function readPiAssistant(
  message: PiAssistantLike,
  model: string,
): {
  text: string
  tool_calls?: { id: string; name: string; input: unknown }[]
  reasoning?: string
  reasoning_replay?: ReasoningReplay
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number }
} {
  const content = message.content ?? []
  const text = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')
  const calls = content
    .filter((c) => c.type === 'toolCall' && typeof c.name === 'string')
    .map((c) => ({ id: String(c.id ?? ''), name: c.name as string, input: c.arguments ?? {} }))
  const thinking = content.filter((c) => c.type === 'thinking')
  const reasoning = thinking
    .filter((c) => c.redacted !== true)
    .map((c) => c.thinking ?? '')
    .join('')
  const blocks = thinking.map((c) => ({
    thinking: c.thinking ?? '',
    ...(typeof c.thinkingSignature === 'string' ? { signature: c.thinkingSignature } : {}),
    ...(c.redacted === true ? { redacted: true } : {}),
  }))
  // pi-ai 的 `input` 不含命中 / 写入缓存的那两部分；我们的口径（与 OpenAI 兼容口同）是「含缓存」
  const cacheRead = message.usage?.cacheRead ?? 0
  const cacheWrite = message.usage?.cacheWrite ?? 0
  return {
    text,
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(reasoning === '' ? {} : { reasoning }),
    ...(blocks.length === 0
      ? {}
      : { reasoning_replay: { kind: 'anthropic-messages' as const, model, blocks } }),
    usage: {
      input_tokens: (message.usage?.input ?? 0) + cacheRead + cacheWrite,
      output_tokens: message.usage?.output ?? 0,
      cached_tokens: cacheRead,
    },
  }
}
