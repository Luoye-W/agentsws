/**
 * WP188：OpenAI 兼容口的**流式**回包（`stream: true` + `stream_options.include_usage`）。
 *
 * 线上是 SSE：一行一个 `data: {…}`，最后一行 `data: [DONE]`。每一块的形状是
 * `choices[0].delta.{content, reasoning_content, tool_calls[]}`，用量在最后那一块（`choices` 为空）。
 * 工具调用是按 `index` 分段拼的：第一段带 `id` 与 `function.name`，后面几段只带 `function.arguments`
 * 的一截。这里把它们拼回一整条，与非流式那条路回的形状一模一样。
 *
 * 读法两种：有 `body`（真 fetch）就边读边吐；没有（测试替身只给了 `text()`）就一次读完再按行吐。
 */

export interface StreamWireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

interface WireChunk {
  choices?: { delta?: WireDelta }[]
  usage?: StreamWireUsage | null
}

/** 拼回来的一整次回复（工具调用的参数还是字符串，交给调用方按非流式那条路解析）。 */
export interface StreamedReply {
  content: string
  reasoning: string
  tool_calls: { id?: string; name?: string; arguments: string }[]
  usage?: StreamWireUsage
}

/** 流式回包能读的样子：真 fetch 有 `body`；替身可能只有 `text()`。 */
export interface StreamSource {
  body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

/**
 * 读完一次流式回包。每收到一截正文就调一次 `onText`；`signal` abort 时停止读取并抛出
 * （`AbortError`——网关认得它是"调用方停的"）。
 */
export async function readChatStream(
  res: StreamSource,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<StreamedReply> {
  const reply: StreamedReply = { content: '', reasoning: '', tool_calls: [] }
  let done = false
  const line = (raw: string): void => {
    const trimmed = raw.trim()
    if (done || !trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      return
    }
    let chunk: WireChunk
    try {
      chunk = JSON.parse(data) as WireChunk
    } catch {
      // 半截 / 非 JSON 的行（心跳注释之类）跳过；上游真坏了会在用量或 HTTP 状态上体现
      return
    }
    if (chunk.usage !== undefined && chunk.usage !== null) reply.usage = chunk.usage
    const delta = chunk.choices?.[0]?.delta
    if (delta === undefined) return
    if (typeof delta.reasoning_content === 'string') reply.reasoning += delta.reasoning_content
    if (typeof delta.content === 'string' && delta.content !== '') {
      reply.content += delta.content
      onText(delta.content)
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? reply.tool_calls.length
      const slot = reply.tool_calls[index] ?? { arguments: '' }
      reply.tool_calls[index] = slot
      if (part.id !== undefined) slot.id = part.id
      if (part.function?.name !== undefined) slot.name = (slot.name ?? '') + part.function.name
      if (part.function?.arguments !== undefined) slot.arguments += part.function.arguments
    }
  }

  const stopped = (): Error => {
    const e = new Error('stream aborted by caller')
    e.name = 'AbortError'
    return e
  }

  const body = res.body
  if (body === undefined || body === null) {
    const text = await res.text()
    for (const raw of text.split('\n')) {
      if (signal?.aborted === true) throw stopped()
      line(raw)
    }
    return reply
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (signal?.aborted === true) throw stopped()
      const { value, done: finished } = await reader.read()
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        line(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
      }
      if (done) break
    }
    if (isAborted(signal)) throw stopped()
    buffer += decoder.decode()
    if (buffer !== '') line(buffer)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return reply
}

/** 读一次"停了没有"（`await` 之后要重新读，别让 TS 沿用前面的判断）。 */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true
