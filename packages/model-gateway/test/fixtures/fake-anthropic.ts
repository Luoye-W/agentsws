/**
 * WP374：本机假的 **Anthropic 兼容口**（Claude 中转站的替身）。只听 127.0.0.1、随机端口，不联网、不花钱。
 *
 * - `GET /v1/models` → 一页清单（`data` 数组，Anthropic 的形状）；
 * - `POST /v1/messages` → 一律 SSE 流式（官方 SDK 经 pi-ai 发的都是 `stream: true`）：
 *   - key 是 {@link BAD_KEY} → 401 `authentication_error`；{@link BROKE_KEY} → 400「credit balance is too low」
 *     （Anthropic 本家的说法）；{@link RELAY_QUOTA_KEY} → 403「额度不足」（中转站常见的说法）；
 *   - 请求里有图 → 回 `ZEBRA`（过「看图」那一步）；最后一句用户话里有「调用工具」且带了工具 → 回一次工具调用；
 *   - 请求开了思考（`thinking.type` 是 enabled / adaptive）→ 先回一个带签名的思考块，再回正文。
 * 每次请求的路径、头（**不存 key 的值，只存"对不对"**）与请求体都记下来给断言用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 测试用的假 key（不是任何真实服务的 key）。 */
export const GOOD_KEY = 'sk-fake-relay-good'
export const BAD_KEY = 'sk-fake-relay-bad'
export const BROKE_KEY = 'sk-fake-relay-broke'
export const RELAY_QUOTA_KEY = 'sk-fake-relay-quota'

export interface FakeAnthropicRequest {
  method: string
  path: string
  /** `x-api-key` 是不是 {@link GOOD_KEY}（值本身不记）。 */
  key: 'good' | 'bad' | 'none' | 'other'
  version: string | undefined
  body: Record<string, unknown> | undefined
}

export interface FakeAnthropic {
  /** 根地址（不带 `/v1`）。 */
  url: string
  requests: FakeAnthropicRequest[]
  close(): Promise<void>
}

const MODELS = {
  data: [
    { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
    { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
    { type: 'model', id: 'relay-claude-special', display_name: '中转站自己起名的模型' },
  ],
  has_more: false,
}

const keyOf = (raw: string | string[] | undefined): FakeAnthropicRequest['key'] => {
  if (raw === undefined) return 'none'
  if (raw === GOOD_KEY) return 'good'
  if (raw === BAD_KEY || raw === BROKE_KEY || raw === RELAY_QUOTA_KEY) return 'bad'
  return 'other'
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const anthropicError = (type: string, message: string) => ({
  type: 'error',
  error: { type, message },
})

/** 一次回复里的几块：思考（带签名）、正文、工具调用。 */
type Block =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function sse(res: ServerResponse, model: string, blocks: Block[], stop: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`)
  }
  send('message_start', {
    message: {
      id: 'msg_fake_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 4 },
    },
  })
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } })
      send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } })
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } })
    } else if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      // 拆成两段吐：流式那一路要看到不止一个片段
      const half = Math.ceil(b.text.length / 2)
      for (const part of [b.text.slice(0, half), b.text.slice(half)])
        if (part !== '') send('content_block_delta', { index, delta: { type: 'text_delta', text: part } })
    } else {
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      })
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } })
  send('message_stop', {})
  res.end()
}

type Msg = { role?: string; content?: unknown }
const hasImage = (messages: Msg[]): boolean =>
  messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type?: string; content?: unknown }[]).some(
        (c) =>
          c.type === 'image' ||
          (Array.isArray(c.content) && (c.content as { type?: string }[]).some((x) => x.type === 'image')),
      ),
  )
const lastUserText = (messages: Msg[]): string => {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (last === undefined) return ''
  if (typeof last.content === 'string') return last.content
  return (last.content as { type?: string; text?: string }[])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: FakeAnthropicRequest[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>)
      const header = req.headers['x-api-key']
      const key = Array.isArray(header) ? header[0] : header
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        key: keyOf(key),
        version: req.headers['anthropic-version'] as string | undefined,
        body,
      })
      if (key === BAD_KEY || key === undefined)
        return json(res, 401, anthropicError('authentication_error', 'invalid x-api-key'))
      if (key === BROKE_KEY)
        return json(
          res,
          400,
          anthropicError(
            'invalid_request_error',
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
          ),
        )
      if (key === RELAY_QUOTA_KEY)
        return json(res, 403, { error: { type: 'new_api_error', message: '用户额度不足，剩余额度: ＄0.0000' } })
      if (req.method === 'GET' && path === '/v1/models') return json(res, 200, MODELS)
      if (req.method !== 'POST' || path !== '/v1/messages')
        return json(res, 404, anthropicError('not_found_error', 'not found'))
      const messages = (body?.messages ?? []) as Msg[]
      const model = String(body?.model ?? '')
      const thinking = (body?.thinking as { type?: string } | undefined)?.type
      const blocks: Block[] =
        thinking === 'enabled' || thinking === 'adaptive'
          ? [{ type: 'thinking', thinking: '先想一想退货流程。', signature: 'sig-fake-001' }]
          : []
      const tools = (body?.tools ?? []) as { name?: string }[]
      const toolResult = messages.some(
        (m) => Array.isArray(m.content) && (m.content as { type?: string }[]).some((c) => c.type === 'tool_result'),
      )
      if (tools.length > 0 && !toolResult && lastUserText(messages).includes('调用工具')) {
        blocks.push({
          type: 'tool_use',
          id: 'toolu_fake_1',
          name: tools[0]?.name ?? 'tool',
          input: { order: 'A1001' },
        })
        return sse(res, model, blocks, 'tool_use')
      }
      blocks.push({ type: 'text', text: hasImage(messages) ? 'ZEBRA' : '好的，我在。退货已经登记了。' })
      return sse(res, model, blocks, 'end_turn')
    })().catch((e: unknown) => json(res, 500, anthropicError('api_error', String(e))))
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
