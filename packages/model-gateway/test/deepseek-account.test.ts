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
  DEEPSEEK_ACCOUNT_MODELS,
  deepseekAccountProvider,
  GatewayError,
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
    await expect(p.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /not signed in/,
    )
    expect(seen).toEqual([])
  })

  it('上游报错：原样带状态码，错误信封里没有令牌', async () => {
    const { fetch } = fakeMessages({ status: 402 })
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect(String(err.message)).toContain('402')
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
