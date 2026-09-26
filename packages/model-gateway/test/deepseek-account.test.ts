/**
 * WP134：第三种模型来源「用我的 DeepSeek 账号登录」的推理口。
 *
 * 三组：
 * (a) **凭据**：令牌每次现取自官方 `resolveToken`，只进 `x-dsh-auth-token` 头（不加 Bearer、
 *     不进请求体、不进错误信封）；没登录当场失败、一个请求都不发；拒绝重定向。
 * (b) **形状**：Messages 口（`/anthropic/v1/messages`）——system 抽顶层、工具调用 / 结果、图片块。
 * (c) **三步验证对这一来源生效**：经网关跑 `checkModel`，能看图的过、看不了图的卡在第 ③ 步。
 *
 * 上游全是替身（一个认识测试图的假 Messages 口），不联网。
 */
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { NO_VISION_REASON } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AccountFetch,
  checkModel,
  createModelGateway,
  DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
  DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE,
  DEEPSEEK_ACCOUNT_MODELS,
  DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
  DEEPSEEK_ACCOUNT_SIGN_IN_REQUIRED_MESSAGE,
  DEEPSEEK_API_QUOTA_MESSAGE,
  deepseekAccountProvider,
  deepseekMessagesProvider,
  deepseekQuotaKindOf,
  type FetchLike,
  GatewayError,
  isDeepSeekQuotaFailure,
  openaiCompatibleProvider,
  ProviderError,
  toMessagesRequest,
  VISION_PROBE_WORD,
  visionProbeBase64,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const TOKEN = 'dsk_SECRET_TOKEN_gateway'

interface Seen {
  url: string
  headers: Record<string, string>
  body: string
  redirect: string
}

/** 一个假的 Messages 口：看得见图就念出那个词（`vision: false` 时装瞎）。 */
function fakeMessages(opts: { vision?: boolean; status?: number } = {}): {
  fetch: AccountFetch
  seen: Seen[]
} {
  const seen: Seen[] = []
  const fetch: AccountFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
    if (opts.status !== undefined) {
      return {
        ok: false,
        status: opts.status,
        json: async () => ({}),
        text: async () => 'insufficient balance',
      }
    }
    const req = JSON.parse(init.body) as { messages: { content: { type: string }[] }[] }
    const hasImage = req.messages.some((m) => m.content.some((b) => b.type === 'image'))
    const text = hasImage ? (opts.vision === false ? '我看不到图片' : VISION_PROBE_WORD) : '好'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3 },
      }),
      text: async () => '',
    }
  }
  return { fetch, seen }
}

const signedIn = async (url: string): Promise<string | undefined> =>
  new URL(url).origin === 'https://api.deepseek.com' ? TOKEN : undefined

const gatewayOf = (provider: ModelProvider) =>
  createModelGateway({
    providers: [provider],
    policy: policy({
      default: provider.ref,
      prices: { [`${provider.ref.provider}/${provider.ref.model}`]: { in: 0, out: 0, cached: 0 } },
    }),
    clock: fixedClock(),
    eventSink: recorder().sink,
    env: {},
  })

const describeError = (e: unknown) => ({
  reason:
    typeof e === 'object' && e !== null && 'code' in e
      ? String((e as { code: unknown }).code)
      : 'x',
  detail: e instanceof Error ? e.message : String(e),
})

describe('WP134 (a) 凭据：官方 resolveToken 现取、只进 x-dsh-auth-token', () => {
  it('发到官方 Messages 口，令牌只在头里，不加 Bearer，拒绝重定向', async () => {
    const { fetch, seen } = fakeMessages()
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch })
    const out = await p.complete({ messages: [{ role: 'user', content: '在吗' }] })
    expect(out.text).toBe('好')
    // WP143：Messages 的 input_tokens 不含缓存命中（12 + 3）；我们的口径是含
    expect(out.usage).toEqual({
      input_tokens: 15,
      output_tokens: 1,
      cached_tokens: 3,
      cost_base: 0,
    })
    expect(seen[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(seen[0]?.headers['x-dsh-auth-token']).toBe(TOKEN)
    expect(seen[0]?.headers.authorization).toBeUndefined()
    expect(seen[0]?.redirect).toBe('error')
    expect(seen[0]?.body).not.toContain(TOKEN)
    expect(JSON.parse(seen[0]?.body ?? '{}').model).toBe(DEEPSEEK_ACCOUNT_DEFAULT_MODEL)
  })

  it('没登录：当场失败、一个请求都不发；错误里没有令牌', async () => {
    const { fetch, seen } = fakeMessages()
    const p = deepseekAccountProvider({ resolveToken: async () => undefined, fetch })
    await expect(p.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(seen).toEqual([])
  })

  it('推理地址不在官方 inferenceOrigin 下：官方不给令牌，我们也就发不出去', async () => {
    const { fetch, seen } = fakeMessages()
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch,
      baseUrl: 'https://evil.example/anthropic',
    })
    // WP150：没登录那句改成人话（官方 ACCOUNT_SIGN_IN_REQUIRED），错误码 unauthenticated
    await expect(p.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      DEEPSEEK_ACCOUNT_SIGN_IN_REQUIRED_MESSAGE,
    )
    expect(seen).toEqual([])
  })

  it('上游报错：原样带状态码，错误信封里没有令牌', async () => {
    // WP151 起 402 单独说"余额不足"（见文件末尾那一组），这里换成一个普通的上游错
    const { fetch } = fakeMessages({ status: 500 })
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect(String(err.message)).toContain('500')
  })

  it('官方目录：默认那一档能看图，listModels 不发请求', async () => {
    const { fetch, seen } = fakeMessages()
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch })
    expect(
      DEEPSEEK_ACCOUNT_MODELS.find((m) => m.id === DEEPSEEK_ACCOUNT_DEFAULT_MODEL)?.vision,
    ).toBe(true)
    expect((await p.listModels?.())?.map((m) => m.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(seen).toEqual([])
  })
})

describe('WP134 (b) Messages 形状', () => {
  it('system 抽顶层；工具调用 / 结果成块；相邻同角色合并；图片是 base64 块', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是客服' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', mime: 'image/png', data: 'AAA' },
        ],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'orders.get', input: { id: 1 } }],
      },
      { role: 'tool', tool_call_id: 't1', name: 'orders.get', content: '{"ok":true}' },
      { role: 'user', content: '然后呢' },
    ]
    const wire = toMessagesRequest(messages)
    expect(wire.system).toBe('你是客服')
    expect(wire.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(wire.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    })
    expect(wire.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'orders__get', input: { id: 1 } },
    ])
    expect(wire.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' },
      { type: 'text', text: '然后呢' },
    ])
  })

  it('回来的 tool_use 映射回原名；thinking 进 reasoning', async () => {
    const fetch: AccountFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'thinking', thinking: '想一想' },
          { type: 'text', text: '查一下' },
          { type: 'tool_use', id: 'c1', name: 'orders__get', input: { id: 7 } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    })
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch })
    const out = await p.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'orders.get', description: 'd', input_schema: { type: 'object' } }],
    })
    expect(out.tool_calls).toEqual([{ id: 'c1', name: 'orders.get', input: { id: 7 } }])
    expect(out.reasoning).toBe('想一想')
    expect(out.text).toBe('查一下')
  })
})

describe('WP134 (c) 三步验证对这一来源生效（经网关）', () => {
  const check = (provider: ModelProvider) => {
    const gateway = gatewayOf(provider)
    return checkModel({
      complete: (messages: ChatMessage[]) =>
        gateway.complete({
          messages,
          meta: meta({ purpose: 'judge' }),
          model: provider.ref,
          capability_probe: true,
        }),
      describe: describeError,
    })
  }

  it('能看图：连通 → 文字 → 看图三步都过；带图那一次真的带着那张测试图', async () => {
    const { fetch, seen } = fakeMessages()
    const outcome = await check(
      deepseekAccountProvider({ resolveToken: signedIn, fetch, provider: 'deepseek-account' }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map((s) => [s.step, s.ok])).toEqual([
      ['connect', true],
      ['text', true],
      ['vision', true],
    ])
    expect(seen).toHaveLength(2)
    expect(seen[1]?.body).toContain(visionProbeBase64())
  })

  it('看不了图：卡在第 ③ 步，reason = no_vision', async () => {
    const { fetch } = fakeMessages({ vision: false })
    const outcome = await check(deepseekAccountProvider({ resolveToken: signedIn, fetch }))
    expect(outcome.ok).toBe(false)
    expect(outcome.failed_step).toBe('vision')
    expect(outcome.reason).toBe(NO_VISION_REASON)
  })
})

describe('WP150 登录失效（推理口 401，照官方 dsh-llm-deepseek-account）', () => {
  it('401：把这一次用的令牌报回 rejectToken，这一次以 unauthenticated + 人话失败；错误里没有令牌', async () => {
    const { fetch } = fakeMessages({ status: 401 })
    const rejected: string[] = []
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      rejectToken: async (t) => {
        rejected.push(t)
      },
      fetch,
    })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('unauthenticated')
    expect((err as GatewayError).message).toBe(DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE)
    expect(rejected).toEqual([TOKEN])
    expect(
      JSON.stringify({ m: (err as Error).message, d: (err as GatewayError).details }),
    ).not.toContain(TOKEN)
  })

  it('rejectToken 自己出错也不改这一次的失败原因', async () => {
    const { fetch } = fakeMessages({ status: 401 })
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      rejectToken: async () => {
        throw new Error('credential store locked')
      },
      fetch,
    })
    await expect(p.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE,
    )
  })

  it('403 与别的错误不算失效：不去清登录，照旧是带状态码的 ProviderError', async () => {
    // 402 也不算失效，但 WP151 起它单独说"余额不足"（见文件末尾那一组）
    for (const status of [403, 500]) {
      const { fetch } = fakeMessages({ status })
      const rejected: string[] = []
      const p = deepseekAccountProvider({
        resolveToken: signedIn,
        rejectToken: async (t) => {
          rejected.push(t)
        },
        fetch,
      })
      const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
      expect(err, String(status)).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).status).toBe(status)
      expect(rejected).toEqual([])
    }
  })

  it('API key 那一路的 401 不碰账号：照旧 ProviderError', async () => {
    const { fetch } = fakeMessages({ status: 401 })
    const p = deepseekMessagesProvider({
      credential: { kind: 'api_key', apiKey: () => 'sk-x' },
      fetch,
    })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
  })

  it('经网关：不是泛泛的 all providers failed，而是 provider 那句人话原样往上抛；仍记一条 provider_down', async () => {
    const { fetch } = fakeMessages({ status: 401 })
    const events = recorder()
    const provider = deepseekAccountProvider({
      resolveToken: signedIn,
      rejectToken: async () => undefined,
      fetch,
      provider: 'deepseek-account',
    })
    const gateway = createModelGateway({
      providers: [provider],
      policy: policy({
        default: provider.ref,
        prices: {
          [`${provider.ref.provider}/${provider.ref.model}`]: { in: 0, out: 0, cached: 0 },
        },
      }),
      clock: fixedClock(),
      eventSink: events.sink,
      env: {},
    })
    const err = await gateway
      .complete({ messages: [{ role: 'user', content: 'x' }], meta: meta() })
      .catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('unauthenticated')
    expect((err as GatewayError).message).toBe(DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE)
    expect(events.events.map((e) => e.type)).toContain('model.provider_down')
  })

  it('经网关、没登录：同样原样抛"要登录"那句，一个请求都不发', async () => {
    const { fetch, seen } = fakeMessages()
    const gateway = gatewayOf(
      deepseekAccountProvider({
        resolveToken: async () => undefined,
        fetch,
        provider: 'deepseek-account',
      }),
    )
    const err = await gateway
      .complete({ messages: [{ role: 'user', content: 'x' }], meta: meta() })
      .catch((e) => e)
    expect((err as GatewayError).code).toBe('unauthenticated')
    expect((err as GatewayError).message).toBe(DEEPSEEK_ACCOUNT_SIGN_IN_REQUIRED_MESSAGE)
    expect(seen).toEqual([])
  })
})

describe('WP151 余额不足（照官方 0.1.7-rc.2：402 / 余额不足措辞；不是登录失效）', () => {
  /** 一个回固定错误的上游（正文是官方那种错误信封）。 */
  const failing = (status: number, message = 'Insufficient Balance'): AccountFetch =>
    (async () => ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message, type: 'unknown_error' } }),
    })) as AccountFetch

  it('判定：402 就算；别的状态看错误信封的措辞；401 / 403 先算凭据；纯文本不拿措辞判', () => {
    expect(isDeepSeekQuotaFailure(402, '')).toBe(true)
    expect(isDeepSeekQuotaFailure(400, '{"error":{"message":"Insufficient Balance"}}')).toBe(true)
    expect(isDeepSeekQuotaFailure(429, '{"error":{"message":"quota exceeded"}}')).toBe(true)
    expect(isDeepSeekQuotaFailure(429, '{"error":{"message":"rate limit reached"}}')).toBe(false)
    expect(isDeepSeekQuotaFailure(401, '{"error":{"message":"Insufficient Balance"}}')).toBe(false)
    expect(isDeepSeekQuotaFailure(403, '{"error":{"message":"Insufficient Balance"}}')).toBe(false)
    expect(isDeepSeekQuotaFailure(500, 'insufficient balance')).toBe(false)
  })

  it('账号路 402：人话是"账号余额不足"、reason 是 account_quota；不报 rejectToken；回调余额不足', async () => {
    const rejected: string[] = []
    const balance: boolean[] = []
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      rejectToken: async (t) => {
        rejected.push(t)
      },
      onBalance: (b) => balance.push(b),
      fetch: failing(402),
    })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('provider_error')
    expect((err as GatewayError).message).toBe(DEEPSEEK_ACCOUNT_QUOTA_MESSAGE)
    expect(deepseekQuotaKindOf(err)).toBe('account')
    expect(rejected).toEqual([])
    expect(balance).toEqual([true])
    expect(JSON.stringify(err)).not.toContain(TOKEN)
  })

  it('API key 路（Messages 口与 OpenAI 兼容口）402：人话是"API 余额不足，去开放平台充值"、reason 是 quota', async () => {
    const messages = deepseekMessagesProvider({
      credential: { kind: 'api_key', apiKey: () => 'sk-x' },
      fetch: failing(402),
    })
    const e1 = await messages
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e)
    expect((e1 as GatewayError).message).toBe(DEEPSEEK_API_QUOTA_MESSAGE)
    expect(deepseekQuotaKindOf(e1)).toBe('api_key')

    const balance: boolean[] = []
    const compatible = openaiCompatibleProvider({
      model: 'deepseek-chat',
      apiKey: () => 'sk-x',
      fetch: failing(402) as unknown as FetchLike,
      deepseekBalance: { onBalance: (b) => balance.push(b) },
    })
    const e2 = await compatible
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e)
    expect((e2 as GatewayError).message).toBe(DEEPSEEK_API_QUOTA_MESSAGE)
    expect(deepseekQuotaKindOf(e2)).toBe('api_key')
    expect(balance).toEqual([true])

    // 没说"这是 DeepSeek 官方"的 OpenAI 兼容口：别家的 402 照旧是带状态码的上游错
    const other = openaiCompatibleProvider({
      model: 'm',
      apiKey: () => 'sk-x',
      fetch: failing(402) as unknown as FetchLike,
    })
    const e3 = await other.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(e3).toBeInstanceOf(ProviderError)
    expect(deepseekQuotaKindOf(e3)).toBeUndefined()
  })

  it('一次成功就回调"余额够了"', async () => {
    const balance: boolean[] = []
    const { fetch } = fakeMessages()
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      onBalance: (b) => balance.push(b),
      fetch,
    })
    await p.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(balance).toEqual([false])
  })

  it('经网关：原样抛那句人话，不降级换别的模型（备选一次都没被调）', async () => {
    const account = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: failing(402),
      provider: 'deepseek-account',
    })
    let backupCalls = 0
    const backup: ModelProvider = {
      ref: { provider: 'backup', model: 'b', region: 'cn' },
      async complete() {
        backupCalls += 1
        return { text: 'x', usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 } }
      },
    }
    const events = recorder()
    const gateway = createModelGateway({
      providers: [account, backup],
      policy: policy({
        default: account.ref,
        fallbacks: { [`${account.ref.provider}/${account.ref.model}`]: [backup.ref] },
        prices: {
          [`${account.ref.provider}/${account.ref.model}`]: { in: 0, out: 0, cached: 0 },
          'backup/b': { in: 0, out: 0, cached: 0 },
        },
      }),
      clock: fixedClock(),
      eventSink: events.sink,
      env: {},
    })
    const err = await gateway
      .complete({ messages: [{ role: 'user', content: 'x' }], meta: meta() })
      .catch((e) => e)
    expect((err as GatewayError).message).toBe(DEEPSEEK_ACCOUNT_QUOTA_MESSAGE)
    expect(deepseekQuotaKindOf(err)).toBe('account')
    expect(backupCalls).toBe(0)
    expect(events.events.map((e) => e.type)).toContain('model.provider_down')
  })
})
