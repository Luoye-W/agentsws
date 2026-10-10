/**
 * WP290（决策 332）：装包前冒烟用的**本机假模型**——一个 OpenAI 兼容口，按剧本回固定的工具调用 / 文字。
 *
 * 不联网、不花钱、不要任何真 key。只听 127.0.0.1 的随机端口。剧本按用户那句话里的记号走：
 *
 *   [smoke:card]  第一轮调 `draft_reply`（起草一封回信 → 出一张卡），看到工具结果后说一句收尾
 *   [smoke:fail]  直接回 400（模型那一跳出错 → 这次运行没跑成）
 *   别的          回一句话（问一句的当场回答 / 工具编译那一轮）
 *
 * 每一次请求都记下来（用了哪些工具、是不是流式），冒烟按时间窗把它们归到每一次运行上。
 */
import { createServer } from 'node:http'

export const SMOKE_MODEL = 'smoke-model'
export const MARK_CARD = '[smoke:card]'
export const MARK_FAIL = '[smoke:fail]'
export const SMOKE_ANSWER = '冒烟回答：店里现在有 3 件商品（假模型按剧本回的）。'
export const SMOKE_DRAFT = {
  subject: 'Re: 冒烟测试的来信',
  body: '你好，\n\n这是冒烟测试起草的一封回信（假模型按剧本写的，不会发出去）。\n\n祝好',
}
const FAIL_MESSAGE = 'smoke: 假模型按剧本报错（[smoke:fail]）'

/** 一次请求里人说的话 + 系统给的现场（拼成一段，只用来认记号）。 */
function textOf(messages) {
  return (messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n')
}

/**
 * 剧本：给一份 chat/completions 请求体，回 `{ status, message?, error? }`（纯函数，单测直接打它）。
 * `message` 是 OpenAI 形状的 assistant 消息（可能带 `tool_calls`）。
 */
export function scriptedReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map((t) => t?.function?.name)
    .filter((n) => typeof n === 'string')
  const said = textOf(messages)
  if (said.includes(MARK_FAIL)) return { status: 400, error: FAIL_MESSAGE, tools }
  const toolTurns = messages.filter((m) => m.role === 'tool').length
  if (said.includes(MARK_CARD) && tools.includes('draft_reply') && toolTurns === 0) {
    return {
      status: 200,
      tools,
      message: {
        role: 'assistant',
        content: '我先把回信起草好，放进待批。',
        tool_calls: [
          {
            id: 'call_smoke_draft_1',
            type: 'function',
            function: { name: 'draft_reply', arguments: JSON.stringify(SMOKE_DRAFT) },
          },
        ],
      },
    }
  }
  // 要 JSON 的辅助调用（摘要、判断…）回一个空对象，别的一律回一句话
  const wantsJson = body?.response_format?.type === 'json_object'
  const content = wantsJson ? '{}' : toolTurns > 0 ? '稿子放进待批了，你看一眼。' : SMOKE_ANSWER
  return { status: 200, tools, message: { role: 'assistant', content } }
}

const USAGE = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }

/** 非流式回包。 */
function wholeBody(message) {
  return {
    id: 'chatcmpl-smoke',
    object: 'chat.completion',
    created: 0,
    model: SMOKE_MODEL,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls === undefined ? 'stop' : 'tool_calls',
      },
    ],
    usage: USAGE,
  }
}

/** 流式回包（SSE）：先文字、再工具调用、再收尾与用量，最后 `[DONE]`。 */
function streamChunks(message) {
  const base = {
    id: 'chatcmpl-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: SMOKE_MODEL,
  }
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }]
  if (typeof message.content === 'string' && message.content !== '')
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: message.content } }] })
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] } }],
    })
  }
  chunks.push({
    ...base,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: message.tool_calls === undefined ? 'stop' : 'tool_calls',
      },
    ],
  })
  chunks.push({ ...base, choices: [], usage: USAGE })
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
}

/**
 * 起假模型。回 `{ baseUrl, requests, close }`；`requests` 每条：`{ seq, path, stream, tools, status }`。
 */
export async function startFakeModel() {
  const requests = []
  let seq = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      if (req.method === 'GET' && path.endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: SMOKE_MODEL, object: 'model' }] })
        return
      }
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        send(400, { error: { message: 'smoke: 请求体不是 JSON' } })
        return
      }
      if (path.endsWith('/embeddings')) {
        const input = Array.isArray(body.input) ? body.input : [body.input]
        send(200, {
          object: 'list',
          data: input.map((_, index) => ({ object: 'embedding', index, embedding: [0, 0, 0, 1] })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
        return
      }
      if (!path.endsWith('/chat/completions')) {
        send(404, { error: { message: `smoke: 假模型没有 ${path}` } })
        return
      }
      const reply = scriptedReply(body)
      seq += 1
      requests.push({
        seq,
        path,
        stream: body.stream === true,
        tools: reply.tools,
        status: reply.status,
      })
      if (reply.status !== 200) {
        send(reply.status, { error: { message: reply.error, type: 'invalid_request_error' } })
        return
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(streamChunks(reply.message))
        return
      }
      send(200, wholeBody(reply.message))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
