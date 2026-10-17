/**
 * WP376（决策 1027）：自己接的 OpenAI 兼容口——地址是官方目录认识的那家时走官方 pi-ai，档位与传法照目录；
 * 认不得的原样走原来的通道。上游是本机假服务（官方地址的请求原样改投过去），不联网、不花钱。
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | 认 | 地址逐字比（主机名大小写、结尾 `/` 不算差别；路径差一截就不认）；模型名要在那一家的目录里 |
 * | 档 | OpenRouter `openai/gpt-5` 发 `reasoning.effort`、百炼 Token Plan Qwen 发 `enable_thinking`、OpenAI 本家走 Responses 口；没选按默认档；`thinking: off` 照官方发「不想」 |
 * | 回放 | 思考块按协议记下、下一轮同一个模型原样带回 |
 * | 工具 | 工具名出线换合规名、回来换回原名；强制工具按协议写 |
 * | 认不得 | 中转站地址 / 目录外的型号：交回原来的通道（非流式、不发思考字段） |
 * | 报错 | key 不对 → 401；额度没了 → 402；没 key 不发请求 |
 */
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isOfficialRouteUrl,
  levelsSentApart,
  loadOfficialRoutes,
  officialRouteFacts,
  openaiCompatibleProvider,
  piRouteProvider,
  routeKey,
} from '../src/index.js'
import {
  BAD_KEY,
  BROKE_KEY,
  type FakeOpenAi,
  GOOD_KEY,
  redirectFetch,
  startFakeOpenAi,
} from './fixtures/fake-openai.js'

const OPENROUTER = 'https://openrouter.ai/api/v1'
const QWEN_PLAN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const OPENAI = 'https://api.openai.com/v1'

let fake: FakeOpenAi
beforeAll(async () => {
  fake = await startFakeOpenAi()
  await loadOfficialRoutes()
})
afterAll(async () => {
  await fake.close()
})

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const lastBody = () => fake.requests.at(-1)?.body ?? {}

function provider(
  baseUrl: string,
  model: string,
  opts: { key?: string; defaultEffort?: 'low' | 'medium' | 'high' } = {},
): ModelProvider {
  const key = opts.key ?? GOOD_KEY
  const host = new URL(baseUrl).origin
  const fetch = redirectFetch(host, fake.url)
  return piRouteProvider({
    baseUrl,
    model,
    provider: 'mine',
    apiKey: () => key,
    fetch,
    ...(opts.defaultEffort === undefined ? {} : { defaultEffort: () => opts.defaultEffort }),
    fallback: openaiCompatibleProvider({
      baseUrl,
      model,
      provider: 'mine',
      apiKey: () => key,
      fetch: fetch as never,
    }),
  })
}

describe('WP376 认：地址 + 模型照官方目录', () => {
  it('地址逐字比；模型要在那一家的目录里', () => {
    expect(routeKey('https://OpenRouter.ai/api/v1/')).toBe(OPENROUTER)
    expect(isOfficialRouteUrl(OPENROUTER)).toBe(true)
    expect(isOfficialRouteUrl('https://openrouter.ai/api')).toBe(false)
    expect(isOfficialRouteUrl('https://relay.example.com/v1')).toBe(false)
    expect(officialRouteFacts(OPENROUTER, 'openai/gpt-5')).toMatchObject({
      vendor: 'openrouter',
      api: 'openai-completions',
      vision: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    })
    expect(officialRouteFacts(OPENAI, 'gpt-5.5')).toMatchObject({ api: 'openai-responses' })
    expect(officialRouteFacts(OPENROUTER, 'relay-own-model')).toBeUndefined()
    expect(officialRouteFacts('https://relay.example.com/v1', 'openai/gpt-5')).toBeUndefined()
  })
})

describe('WP376 档：照官方各家的传法', () => {
  it('OpenRouter：选了档发 reasoning.effort，思考块记成 openai-completions 回放', async () => {
    const out = await provider(OPENROUTER, 'openai/gpt-5').complete({
      messages: [user('你好')],
      reasoning_effort: 'high',
    })
    expect(lastBody().reasoning).toEqual({ effort: 'high' })
    expect(fake.requests.at(-1)?.key).toBe('good')
    expect(out.text).toBe('你好，我是假的上游。')
    expect(out.reasoning).toBe('先想一想。')
    expect(out.reasoning_replay).toMatchObject({
      kind: 'openai-completions',
      model: 'openai/gpt-5',
    })
    expect(out.usage).toMatchObject({ input_tokens: 12, output_tokens: 7, cached_tokens: 2 })
  })

  it('没选按默认档发（显示什么就发什么）；thinking: off 照官方不开', async () => {
    await provider(OPENROUTER, 'openai/gpt-5', { defaultEffort: 'medium' }).complete({
      messages: [user('你好')],
    })
    expect(lastBody().reasoning).toEqual({ effort: 'medium' })
    await provider(OPENROUTER, 'openai/gpt-5', { defaultEffort: 'medium' }).complete({
      messages: [user('起个标题')],
      thinking: 'off',
    })
    expect((lastBody().reasoning as { effort?: string } | undefined)?.effort).not.toBe('medium')
  })

  it('百炼 Token Plan 的 Qwen：发 enable_thinking（官方 qwen 写法）', async () => {
    await provider(QWEN_PLAN, 'qwen3.6-plus', { defaultEffort: 'medium' }).complete({
      messages: [user('你好')],
    })
    expect(lastBody().enable_thinking).toBe(true)
    await provider(QWEN_PLAN, 'qwen3.6-plus').complete({
      messages: [user('你好')],
      thinking: 'off',
    })
    expect(lastBody().enable_thinking).toBe(false)
  })

  it('OpenAI 本家：走 Responses 口，档发在 reasoning.effort', async () => {
    const out = await provider(OPENAI, 'gpt-5.5').complete({
      messages: [user('你好')],
      reasoning_effort: 'low',
    })
    expect(fake.requests.at(-1)?.path).toBe('/v1/responses')
    expect(lastBody().reasoning).toMatchObject({ effort: 'low' })
    expect(out.text).toBe('你好，我是假的上游。')
    expect(out.reasoning_replay).toMatchObject({ kind: 'openai-responses', model: 'gpt-5.5' })
  })

  it('流式：片段一段段到', async () => {
    const parts: string[] = []
    await provider(OPENROUTER, 'openai/gpt-5').complete({
      messages: [user('你好')],
      on_delta: (d) => parts.push(d),
    })
    expect(parts.join('')).toBe('你好，我是假的上游。')
  })
})

describe('WP376 回放与工具', () => {
  it('上一轮的思考块同一个模型才带回；换了模型不带', async () => {
    const p = provider(OPENROUTER, 'openai/gpt-5')
    const first = await p.complete({ messages: [user('你好')], reasoning_effort: 'high' })
    const history: ChatMessage[] = [
      user('你好'),
      {
        role: 'assistant',
        content: first.text,
        ...(first.reasoning_replay === undefined
          ? {}
          : { reasoning_replay: first.reasoning_replay }),
      },
      user('再说一句'),
    ]
    await p.complete({ messages: history, reasoning_effort: 'high' })
    const sent = (lastBody().messages as Record<string, unknown>[]).find(
      (m) => m.role === 'assistant',
    )
    expect(sent?.reasoning_content).toBe('先想一想。')
    await provider(OPENROUTER, 'openai/gpt-5-mini').complete({ messages: history })
    const other = (lastBody().messages as Record<string, unknown>[]).find(
      (m) => m.role === 'assistant',
    )
    expect(other?.reasoning_content).toBeUndefined()
  })

  it('带点的工具名出线换合规名、回来换回原名；强制工具按 Chat Completions 写', async () => {
    const tools = [{ name: 'orders.get', description: '查订单', input_schema: { type: 'object' } }]
    const out = await provider(OPENROUTER, 'openai/gpt-5').complete({
      messages: [user('调用工具查一下 A1001')],
      tools,
      tool_choice: { type: 'tool', name: 'orders.get' },
    })
    const wire = (lastBody().tools as { function: { name: string } }[])[0]?.function.name
    expect(wire).toBe('orders__get')
    expect(lastBody().tool_choice).toEqual({ type: 'function', function: { name: 'orders__get' } })
    expect(out.tool_calls).toEqual([
      { id: 'call_fake_1', name: 'orders.get', input: { order: 'A1001' } },
    ])
  })
})

describe('WP376 认不得：原样走原来的通道', () => {
  it('中转站地址、目录外的型号：非流式、不发思考字段', async () => {
    for (const [base, model] of [
      ['https://relay.example.com/v1', 'openai/gpt-5'],
      [OPENROUTER, 'relay-own-model'],
    ] as const) {
      const out = await provider(base, model, { defaultEffort: 'high' }).complete({
        messages: [user('你好')],
        reasoning_effort: 'high',
      })
      expect(out.text).toBe('非流式的回答')
      expect(lastBody().stream).toBe(false)
      expect(lastBody().reasoning).toBeUndefined()
    }
  })
})

describe('WP376 报错', () => {
  it('key 不对 → 401；额度没了 → 402；原文里没有 key', async () => {
    const bad = provider(OPENROUTER, 'openai/gpt-5', { key: BAD_KEY }).complete({
      messages: [user('你好')],
    })
    await expect(bad).rejects.toMatchObject({ status: 401 })
    await bad.catch((e: Error) => expect(e.message).not.toContain(BAD_KEY))
    const broke = provider(OPENROUTER, 'openai/gpt-5', { key: BROKE_KEY }).complete({
      messages: [user('你好')],
    })
    await expect(broke).rejects.toMatchObject({ status: 402 })
  })

  it('没 key 不发请求', async () => {
    const before = fake.requests.length
    await expect(
      provider(OPENROUTER, 'openai/gpt-5', { key: '' }).complete({ messages: [user('你好')] }),
    ).rejects.toThrow(/API key/)
    expect(fake.requests.length).toBe(before)
  })
})

describe('WP376 决策 1045：官方传法只分想 / 不想的型号收成开关', () => {
  const MOONSHOT = 'https://api.moonshot.cn/v1'

  it('判定照官方 buildParams：Responses 一律分档；Chat Completions 看 supportsReasoningEffort 与写法', () => {
    expect(levelsSentApart({ api: 'openai-responses', baseUrl: OPENAI })).toBe(true)
    expect(
      levelsSentApart({
        api: 'openai-completions',
        baseUrl: MOONSHOT,
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
      }),
    ).toBe(false)
    // 没写 compat：按地址认（Moonshot 官方不发档；OpenRouter 原样发档）
    expect(levelsSentApart({ api: 'openai-completions', baseUrl: MOONSHOT })).toBe(false)
    expect(levelsSentApart({ api: 'openai-completions', baseUrl: OPENROUTER })).toBe(true)
    expect(
      levelsSentApart({
        api: 'openai-completions',
        baseUrl: QWEN_PLAN,
        compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true },
      }),
    ).toBe(true)
    // 有思考预算格：预算按档算
    expect(
      levelsSentApart({
        api: 'openai-completions',
        baseUrl: MOONSHOT,
        compat: { supportsReasoningEffort: false, supportsThinkingTokenBudget: true },
      }),
    ).toBe(true)
  })

  it('Moonshot kimi-k2.6、百炼 Token Plan qwen3.6-plus：收成 off + 一档；关不掉的（kimi-k2.7-code）不出', () => {
    expect(officialRouteFacts(MOONSHOT, 'kimi-k2.6')?.efforts).toEqual(['off', 'medium'])
    expect(officialRouteFacts(QWEN_PLAN, 'qwen3.6-plus')?.efforts).toEqual(['off', 'medium'])
    expect(officialRouteFacts(MOONSHOT, 'kimi-k2.7-code')?.efforts).toBeUndefined()
    // 真分档的不动
    expect(officialRouteFacts(QWEN_PLAN, 'qwen3.8-max')?.efforts).toEqual([
      'low',
      'medium',
      'xhigh',
    ])
  })

  it('开 = 照官方发「想」（thinking.type enabled），关 = 发「不想」', async () => {
    await provider(MOONSHOT, 'kimi-k2.6').complete({
      messages: [user('你好')],
      reasoning_effort: 'medium',
    })
    expect(lastBody().thinking).toEqual({ type: 'enabled' })
    expect(lastBody().reasoning_effort).toBeUndefined()
    await provider(MOONSHOT, 'kimi-k2.6').complete({
      messages: [user('你好')],
      reasoning_effort: 'off',
    })
    expect(lastBody().thinking).toEqual({ type: 'disabled' })
  })
})
