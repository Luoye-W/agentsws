/**
 * WP374（决策 980）：Anthropic 兼容口（Claude 中转站等）。协议全走官方 pi-ai 的 `anthropic-messages`，
 * 上游是本机假服务（{@link startFakeAnthropic}，127.0.0.1 随机端口），不联网、不花钱。
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | 清单 | `GET {根}/v1/models` 带 `x-api-key` 与 `anthropic-version`；地址写不写 `/v1` 都对；两种回包形状都认 |
 * | 一轮 / 流式 | 正文、token（含缓存口径）；流式回调收到片段；工具调用来回一轮 |
 * | 思考 | 官方目录认得的模型：选了档就发 `thinking`、回的思考块带签名、下一轮原样带回；没选 / 认不出的模型不发 |
 * | 目录 | 名字、看图、上下文、思考档只取官方目录；中转站自己起名的一样不编 |
 * | 报错 | key 不对 → 401；Anthropic 余额不足（400）与中转站额度不足（403）→ 402；原文里没有 key |
 */
import type { ChatMessage } from '@agentsws/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anthropicCompatibleProvider,
  anthropicListingUrl,
  anthropicModelFacts,
  anthropicProviderError,
  loadAnthropicCatalog,
  readAnthropicListing,
} from '../src/index.js'
import {
  BAD_KEY,
  BROKE_KEY,
  type FakeAnthropic,
  GOOD_KEY,
  RELAY_QUOTA_KEY,
  startFakeAnthropic,
} from './fixtures/fake-anthropic.js'

let fake: FakeAnthropic
beforeAll(async () => {
  fake = await startFakeAnthropic()
  await loadAnthropicCatalog()
})
afterAll(async () => {
  await fake.close()
})

const provider = (model: string, key = GOOD_KEY, baseUrl = fake.url) =>
  anthropicCompatibleProvider({ baseUrl, apiKey: () => key, model, provider: 'my-relay' })

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const lastBody = () => fake.requests.at(-1)?.body ?? {}

describe('WP374 清单', () => {
  it('根地址带不带 /v1 都拉同一个地址；带 key 与 anthropic-version', async () => {
    expect(anthropicListingUrl('https://relay.example.com/')).toBe(
      'https://relay.example.com/v1/models?limit=1000',
    )
    expect(anthropicListingUrl('https://relay.example.com/v1')).toBe(
      'https://relay.example.com/v1/models?limit=1000',
    )
    for (const base of [fake.url, `${fake.url}/v1/`]) {
      const rows = await provider('claude-sonnet-4-5', GOOD_KEY, base).listModels?.()
      expect(rows?.map((r) => r.id)).toEqual([
        'claude-sonnet-4-5',
        'claude-haiku-4-5-20251001',
        'relay-claude-special',
      ])
      const req = fake.requests.at(-1)
      expect(req).toMatchObject({ method: 'GET', key: 'good', version: '2023-06-01' })
      expect(req?.path).toBe('/v1/models?limit=1000')
    }
  })

  it('`models` 对象那种形状也认；没 id 的行跳过；不是清单就说人话', () => {
    expect(readAnthropicListing({ models: { 'claude-x': { name: 'X' }, junk: 3 } })).toEqual([
      { id: 'claude-x', name: 'X' },
    ])
    expect(readAnthropicListing({ data: [{ display_name: '没 id' }, { id: 'a' }] })).toEqual([
      { id: 'a', name: 'a' },
    ])
    expect(() => readAnthropicListing({ hello: 1 })).toThrow(/不是模型清单/)
  })

  it('key 不对：拉清单报 401（人话那一层据此说「key 不对」）', async () => {
    await expect(provider('claude-sonnet-4-5', BAD_KEY).listModels?.()).rejects.toMatchObject({
      status: 401,
    })
  })
})

describe('WP374 一轮 / 流式 / 工具', () => {
  it('一轮：正文、token（输入含缓存）、发到 /v1/messages、带 key；没选思考就不发思考', async () => {
    const out = await provider('relay-claude-special').complete({
      messages: [{ role: 'system', content: '你是售后。' }, user('客户要退货')],
    })
    expect(out.text).toBe('好的，我在。退货已经登记了。')
    expect(out.usage).toEqual({ input_tokens: 25, output_tokens: 9, cached_tokens: 4 })
    const req = fake.requests.at(-1)
    expect(req).toMatchObject({ method: 'POST', key: 'good' })
    // 官方 SDK 走 beta 那条口（`/v1/messages?beta=true`），中转站照常收
    expect(req?.path.split('?')[0]).toBe('/v1/messages')
    const body = lastBody()
    expect(body.model).toBe('relay-claude-special')
    expect(body.stream).toBe(true)
    expect(body.thinking).toBeUndefined()
    expect(JSON.stringify(body.system)).toContain('你是售后。')
  })

  it('流式：on_delta 收到不止一段，拼起来就是全文', async () => {
    const parts: string[] = []
    const out = await provider('relay-claude-special').complete({
      messages: [user('客户要退货')],
      on_delta: (t) => parts.push(t),
    })
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(out.text)
  })

  it('工具调用：回一次调用；把结果带回去再问一轮能接上', async () => {
    const tools = [
      {
        name: 'lookup_order',
        description: '查订单',
        input_schema: { type: 'object', properties: { order: { type: 'string' } } },
      },
    ]
    const p = provider('relay-claude-special')
    const first = await p.complete({ messages: [user('调用工具查一下 A1001')], tools })
    expect(first.tool_calls).toEqual([
      { id: 'toolu_fake_1', name: 'lookup_order', input: { order: 'A1001' } },
    ])
    const second = await p.complete({
      messages: [
        user('调用工具查一下 A1001'),
        { role: 'assistant', content: '', tool_calls: first.tool_calls ?? [] },
        { role: 'tool', tool_call_id: 'toolu_fake_1', content: '已发货' },
      ],
      tools,
    })
    expect(second.text).toContain('退货')
    const sent = JSON.stringify(lastBody().messages)
    expect(sent).toContain('tool_result')
    expect(sent).toContain('toolu_fake_1')
  })

  it('强制某个工具：发 tool_choice = {type: tool, name}', async () => {
    await provider('relay-claude-special').complete({
      messages: [user('查一下')],
      tools: [{ name: 'lookup_order', description: '查订单', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'lookup_order' },
    })
    expect(lastBody().tool_choice).toEqual({ type: 'tool', name: 'lookup_order' })
  })
})

describe('WP374 思考程度（只照官方目录）', () => {
  it('目录认得的模型：选了档就开思考；思考块带签名回来，下一轮原样带回', async () => {
    const p = provider('claude-sonnet-4-5')
    const first = await p.complete({ messages: [user('客户要退货')], reasoning_effort: 'high' })
    const body = lastBody()
    expect((body.thinking as { type?: string }).type).toBe('enabled')
    expect(first.reasoning).toBe('先想一想退货流程。')
    expect(first.reasoning_replay).toEqual({
      kind: 'anthropic-messages',
      model: 'claude-sonnet-4-5',
      blocks: [{ thinking: '先想一想退货流程。', signature: 'sig-fake-001' }],
    })
    await p.complete({
      messages: [
        user('客户要退货'),
        {
          role: 'assistant',
          content: first.text,
          ...(first.reasoning_replay === undefined
            ? {}
            : { reasoning_replay: first.reasoning_replay }),
        },
        user('那运费呢'),
      ],
      reasoning_effort: 'high',
    })
    const replayed = JSON.stringify(lastBody().messages)
    expect(replayed).toContain('sig-fake-001')
  })

  it('不选档：照官方不开（能关的模型发 disabled）；thinking=off 同样；认不出的模型选了也不发', async () => {
    await provider('claude-sonnet-4-5').complete({ messages: [user('在吗')] })
    expect(lastBody().thinking).toEqual({ type: 'disabled' })
    await provider('claude-sonnet-4-5').complete({
      messages: [user('在吗')],
      thinking: 'off',
      reasoning_effort: 'high',
    })
    expect(lastBody().thinking).toEqual({ type: 'disabled' })
    await provider('relay-claude-special').complete({
      messages: [user('在吗')],
      reasoning_effort: 'high',
    })
    expect(lastBody().thinking).toBeUndefined()
  })

  it('装配方给了默认档（决策 1032 显示什么就发什么）：没选就按它发；thinking=off 照旧不开', async () => {
    const p = anthropicCompatibleProvider({
      baseUrl: fake.url,
      apiKey: () => GOOD_KEY,
      model: 'claude-sonnet-4-5',
      provider: 'my-relay',
      defaultEffort: () => 'medium',
    })
    await p.complete({ messages: [user('在吗')] })
    expect(lastBody().thinking).toMatchObject({ type: 'enabled', budget_tokens: 8192 })
    await p.complete({ messages: [user('在吗')], thinking: 'off' })
    expect(lastBody().thinking).toEqual({ type: 'disabled' })
  })

  it('目录：名字、看图、上下文、档位照官方；带日期的型号认得；中转站自己的名字一样不编', () => {
    const sonnet = anthropicModelFacts('claude-sonnet-4-5')
    expect(sonnet).toMatchObject({ vision: true, context_window: 1_000_000 })
    expect(sonnet?.name).toContain('Sonnet 4.5')
    expect(sonnet?.efforts).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(anthropicModelFacts('claude-sonnet-4-5-20990101')?.id).toBe('claude-sonnet-4-5')
    expect(anthropicModelFacts('relay-claude-special')).toBeUndefined()
  })
})

describe('WP374 报错', () => {
  it('key 不对 → 401；Anthropic 余额不足 / 中转站额度不足 → 402；原文里没有 key', async () => {
    const run = (key: string) =>
      provider('relay-claude-special', key)
        .complete({ messages: [user('在吗')] })
        .then(
          () => undefined,
          (e: unknown) => e as { status?: number; message: string },
        )
    const bad = await run(BAD_KEY)
    expect(bad?.status).toBe(401)
    expect(bad?.message).toContain('invalid x-api-key')
    const broke = await run(BROKE_KEY)
    expect(broke?.status).toBe(402)
    expect(broke?.message).toContain('credit balance')
    const quota = await run(RELAY_QUOTA_KEY)
    expect(quota?.status).toBe(402)
    expect(quota?.message).toContain('额度不足')
    for (const e of [bad, broke, quota])
      for (const k of [BAD_KEY, BROKE_KEY, RELAY_QUOTA_KEY]) expect(e?.message).not.toContain(k)
  })

  it('别的状态照原样（5xx 网关照常降级）；没填 key 直接拒、不发请求', async () => {
    expect(anthropicProviderError('529 {"error":{"type":"overloaded_error"}}').status).toBe(529)
    expect(anthropicProviderError('429 rate_limit_error').status).toBe(429)
    const before = fake.requests.length
    await expect(
      provider('relay-claude-special', '').complete({ messages: [user('在吗')] }),
    ).rejects.toThrow(/API key/)
    expect(fake.requests.length).toBe(before)
  })
})
