/**
 * WP376：本机假的 **OpenAI 兼容口**（官方目录里那几家的替身）。只听 127.0.0.1、随机端口，不联网、不花钱。
 *
 * 官方目录是按地址认的（`https://openrouter.ai/api/v1` 这种），所以测试里用 {@link redirectFetch}
 * 把发往官方地址的请求原样改投到这里——请求体一个字节不改。
 *
 * - `POST …/chat/completions` → SSE（Chat Completions 的形状）：开了思考（请求体里有 `reasoning.effort`、
 *   `enable_thinking: true` 或 `thinking.type: enabled`）先回一段 `reasoning_content`，再回正文；
 *   最后一句用户话里有「调用工具」且带了工具 → 回一次工具调用；
 * - `POST …/responses` → SSE（Responses 的形状，最小的那几种事件）；
 * - `POST …/chat/completions`（`stream` 不是 true）→ 一整个 JSON（原来那条通道的非流式）；
 * - key 是 {@link BAD_KEY} → 401；{@link BROKE_KEY} → 429「exceeded your current quota」。
 * 每次请求的路径、key 对不对（值本身不记）与请求体都记下来给断言用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const GOOD_KEY = 'sk-fake-openai-good'
export const BAD_KEY = 'sk-fake-openai-bad'
export const BROKE_KEY = 'sk-fake-openai-broke'

export interface FakeOpenAiRequest {
  path: string
  key: 'good' | 'bad' | 'none' | 'other'
  body: Record<string, unknown> | undefined
}

export interface FakeOpenAi {
  /** 根地址（`http://127.0.0.1:端口`）。 */
  url: string
  requests: FakeOpenAiRequest[]
  close(): Promise<void>
}

const keyOf = (raw: string | undefined): FakeOpenAiRequest['key'] => {
  const key = raw?.replace(/^Bearer\s+/iu, '')
  if (key === undefined || key === '') return 'none'
  if (key === GOOD_KEY) return 'good'
  if (key === BAD_KEY || key === BROKE_KEY) return 'bad'
  return 'other'
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 请求里有没有开思考（几家的几种写法都认）。 */
function thinkingOn(body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning as { effort?: unknown } | undefined
  const thinking = body.thinking as { type?: unknown } | undefined
  return (
    (typeof reasoning?.effort === 'string' && reasoning.effort !== 'none') ||
    body.enable_thinking === true ||
    thinking?.type === 'enabled' ||
    (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none')
  )
}

function lastUserText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as Record<string, unknown>[]) : []
  const last = [...list].reverse().find((m) => m.role === 'user')
  const content = last?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return (content as { text?: unknown }[]).map((p) => String(p.text ?? '')).join('')
  return ''
}

function chatSse(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
    const chunk = { id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  const tools = Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]) : []
  if (thinkingOn(body)) send({ role: 'assistant', reasoning_content: '先想一想。' })
  if (tools.length > 0 && lastUserText(body.messages).includes('调用工具')) {
    const name = tools[0]?.function?.name ?? 'tool'
    send({ tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name, arguments: '{"order":' } }] })
    send({ tool_calls: [{ index: 0, function: { arguments: '"A1001"}' } }] })
    send({}, 'tool_calls')
  } else {
    send({ role: 'assistant', content: '你好，' })
    send({ content: '我是假的上游。' })
    send({}, 'stop')
  }
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 } }
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}

function responsesSse(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  let seq = 0
  const send = (type: string, data: Record<string, unknown>): void => {
    seq += 1
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...data })}\n\n`)
  }
  send('response.created', { response: { id: 'resp_1', status: 'in_progress', output: [] } })
  let index = 0
  if (thinkingOn(body)) {
    const item = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先想一想。' }], encrypted_content: 'ENC' }
    send('response.output_item.added', { output_index: index, item: { ...item, summary: [] } })
    send('response.output_item.done', { output_index: index, item })
    index += 1
  }
  const text = '你好，我是假的上游。'
  const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  send('response.output_item.added', { output_index: index, item: { ...msg, status: 'in_progress', content: [] } })
  send('response.output_text.delta', { output_index: index, item_id: 'msg_1', content_index: 0, delta: text })
  send('response.output_item.done', { output_index: index, item: msg })
  const usage = { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 2 } }
  send('response.completed', { response: { id: 'resp_1', status: 'completed', output: [], usage } })
  res.end()
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: FakeOpenAiRequest[] = []
  const server = createServer(async (req, res) => {
    const text = await readBody(req)
    const body = text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>)
    const path = req.url ?? ''
    const raw = req.headers.authorization
    requests.push({ path, key: keyOf(typeof raw === 'string' ? raw : undefined), body })
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    const key = (typeof raw === 'string' ? raw : '').replace(/^Bearer\s+/iu, '')
    if (key === BAD_KEY)
      return json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })
    if (key === BROKE_KEY)
      return json(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, { 'retry-after-ms': '1' })
    if (path.endsWith('/models')) return json(200, { data: [{ id: 'openai/gpt-5' }, { id: 'relay-own-model' }] })
    if (body === undefined) return json(400, { error: { message: 'no body' } })
    if (path.endsWith('/responses')) return responsesSse(res, body)
    if (body.stream !== true)
      return json(200, {
        choices: [{ message: { role: 'assistant', content: '非流式的回答' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })
    return chatSse(res, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** 把发往 `from`（官方地址）的请求改投到 `to`（假上游），别的原样。请求体与头一个字节不改。 */
export function redirectFetch(from: string, to: string): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const target = url.startsWith(from) ? `${to}${url.slice(from.length)}` : url
    if (typeof input === 'object' && !(input instanceof URL))
      return globalThis.fetch(new Request(target, input), init)
    return globalThis.fetch(target, init)
  }) as typeof globalThis.fetch
}
