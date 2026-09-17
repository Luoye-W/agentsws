/**
 * 假的 OpenAI（WP90，55 §9）：设备码端点 + token 端点 + 刷新 + `/codex/responses`。
 *
 * 为什么是**拦 `globalThis.fetch`** 而不是起一个本地 HTTP 服务器：官方 `pi-ai` 把
 * `https://auth.openai.com` 与 `https://chatgpt.com/backend-api` 写死在模块里
 * （只有回调主机名有一个 `PI_OAUTH_CALLBACK_HOST` 的口子，端点没有）。拦 fetch 是
 * 唯一不改上游代码、又能让 CI **一个包都不出网**的做法。
 *
 * 这个替身只答它认识的那几条；别的一律抛——CI 里任何一次真出网都会当场红，
 * 而不是悄悄连出去。
 */

/** 真实端点（原样抄自 `pi-ai/dist/auth/oauth/openai-codex.js`，抄错了用例就红）。 */
export const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
export const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** 测试里那个"账号 id"。脱敏之后界面上只应该看见头四位与尾四位。 */
export const ACCOUNT_ID = 'acct_0123456789abcdef'

/**
 * 一把长得像 JWT 的 access token。
 *
 * `pi-ai` 会解它的第二段找 `https://api.openai.com/auth` → `chatgpt_account_id`，
 * 找不到就抛 "Failed to extract accountId from token"。签名段是假的——它不验签。
 */
export function fakeAccessToken(marker: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64')
  const body = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
      marker,
    }),
    'utf8',
  ).toString('base64')
  return `${head}.${body}.${marker}`
}

export interface FakeOpenAiOptions {
  /** 轮询到第几次才算"人在别的设备上点完了"。缺省 2（第一次回 pending）。 */
  completeOnPoll?: number
  /** `/codex/responses` 这一轮回什么：一次工具调用，或一段结束文本。 */
  reply?: () => { toolCall?: { name: string; arguments: string }; text?: string }
  /** 这一轮报多少 token。 */
  usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number }
}

export interface FakeOpenAi {
  fetch: typeof globalThis.fetch
  /** 收到过哪些请求（只记 URL 与方法，不记 body——body 里有 token）。 */
  hits: { url: string; method: string }[]
  /** 发出去过几把 access token（刷新一次多一把）。 */
  issued: string[]
  /** `/codex/responses` 被调了几次。 */
  responses: number
  /** 请求头里带过的 Authorization 值（用例据此断言"用的是刷新后那一把"）。 */
  bearers: string[]
  restore(): void
}

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * 装上替身。**调用方负责 `restore()`**（`afterEach` 里），否则同一个进程里
 * 后面的用例会继续走这个假的。
 */
export function installFakeOpenAi(options: FakeOpenAiOptions = {}): FakeOpenAi {
  const original = globalThis.fetch
  const completeOn = options.completeOnPoll ?? 2
  let polls = 0
  let issues = 0
  const state: FakeOpenAi = {
    fetch: (() => undefined) as never,
    hits: [],
    issued: [],
    responses: 0,
    bearers: [],
    restore: () => {
      globalThis.fetch = original
    },
  }

  const issue = (): { access: string; refresh: string; expires_in: number } => {
    issues += 1
    const access = fakeAccessToken(`access-${issues}`)
    state.issued.push(access)
    return { access, refresh: `refresh-token-${issues}`, expires_in: 3600 }
  }

  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    state.hits.push({ url, method })

    if (url === DEVICE_USER_CODE_URL) {
      return Response.json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: 0 })
    }
    if (url === DEVICE_TOKEN_URL) {
      polls += 1
      // 403 = 还没点（上游把 403 / 404 都当 pending）
      if (polls < completeOn) return new Response('', { status: 403 })
      return Response.json({ authorization_code: 'auth_code_1', code_verifier: 'verifier_1' })
    }
    if (url === TOKEN_URL) {
      const token = issue()
      return Response.json({
        access_token: token.access,
        refresh_token: token.refresh,
        expires_in: token.expires_in,
      })
    }
    if (url.startsWith(CODEX_RESPONSES_URL)) {
      state.responses += 1
      const auth = new Headers(init?.headers ?? {}).get('authorization')
      if (auth !== null) state.bearers.push(auth)
      const reply = options.reply?.() ?? { text: '好的，我看一下。' }
      const usage = options.usage ?? { input_tokens: 120, output_tokens: 34, cached_tokens: 10 }
      const events: unknown[] = [{ type: 'response.created', response: { id: 'resp_1' } }]
      if (reply.toolCall !== undefined) {
        const item = {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: reply.toolCall.name,
          arguments: '',
        }
        events.push({ type: 'response.output_item.added', output_index: 0, item })
        events.push({
          type: 'response.function_call_arguments.done',
          output_index: 0,
          arguments: reply.toolCall.arguments,
        })
        events.push({
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...item, arguments: reply.toolCall.arguments },
        })
      }
      if (reply.text !== undefined) {
        const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [] }
        events.push({ type: 'response.output_item.added', output_index: 1, item })
        events.push({ type: 'response.output_text.delta', output_index: 1, delta: reply.text })
        events.push({
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            ...item,
            content: [{ type: 'output_text', text: reply.text }],
          },
        })
      }
      events.push({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
            input_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
          },
        },
      })
      return sse(events)
    }
    throw new Error(`CI 不出网：没有替身的请求 ${method} ${url}`)
  }) as typeof globalThis.fetch

  globalThis.fetch = fake
  state.fetch = fake
  return state
}
