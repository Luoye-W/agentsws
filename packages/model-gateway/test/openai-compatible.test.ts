import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import { createModelGateway, openaiCompatibleProvider, ProviderError } from '../src/index.js'
import { fixedClock, meta, policy, recorder, systemPrompt, userPrompt } from './helpers.js'

const KEY_ENV = 'AGENTSWS_TEST_DEEPSEEK_KEY'
const env = { [KEY_ENV]: 'test-value-not-a-real-credential' }

interface Call {
  url: string
  init: Parameters<FetchLike>[1]
}

const mockFetch = (
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: Call[] } => {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return { fetch, calls }
}

const chatBody = {
  choices: [
    {
      message: {
        content: 'here is the draft',
        tool_calls: [
          { id: 'call_1', function: { name: 'orders.get', arguments: '{"id":"ord_1042"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 },
}

describe('openaiCompatibleProvider（DeepSeek 形态，注入 fetch，不联网）', () => {
  it('按 OpenAI 兼容格式发请求；凭据来自环境变量名', async () => {
    const { fetch, calls } = mockFetch(chatBody)
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch,
    })
    await provider.complete({
      messages: [systemPrompt('persona'), userPrompt('where is my order')],
      tools: [
        { name: 'orders.get', description: 'read one order', input_schema: { type: 'object' } },
      ],
      seed: 42,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${env[KEY_ENV]}`)
    const sent = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'deepseek-chat', stream: false, seed: 42 })
    expect(sent.messages).toEqual([
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'where is my order' },
    ])
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'orders.get',
          description: 'read one order',
          parameters: { type: 'object' },
        },
      },
    ])
  })

  it('解析 usage 与 tool_calls', async () => {
    const { fetch } = mockFetch(chatBody)
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch,
    })
    const out = await provider.complete({ messages: [userPrompt('q')] })
    expect(out.text).toBe('here is the draft')
    expect(out.tool_calls).toEqual([
      { id: 'call_1', name: 'orders.get', input: { id: 'ord_1042' } },
    ])
    expect(out.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 60,
      cost_base: 0,
    })
  })

  it('也认 OpenAI 的 prompt_tokens_details.cached_tokens；无 usage 时归零', async () => {
    const { fetch } = mockFetch({
      choices: [{ message: { content: null } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch,
    })
    const out = await provider.complete({ messages: [userPrompt('q')] })
    expect(out.text).toBe('')
    expect(out.tool_calls).toBeUndefined()
    expect(out.usage.cached_tokens).toBe(4)

    const bare = mockFetch({ choices: [{ message: { content: 'x' } }] })
    const p2 = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: bare.fetch,
    })
    expect((await p2.complete({ messages: [] })).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost_base: 0,
    })
  })

  it('5xx → 可降级的 ProviderError；超时同样', async () => {
    const { fetch } = mockFetch({ error: 'upstream' }, { ok: false, status: 503 })
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch,
    })
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({ status: 503 })

    const timeoutFetch: FetchLike = async () => {
      const e = new Error('aborted')
      e.name = 'TimeoutError'
      throw e
    }
    const slow = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: timeoutFetch,
      timeoutMs: 50,
    })
    const err = await slow.complete({ messages: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).timeout).toBe(true)
  })

  it('坏响应：没有 choices → ProviderError；tool_call 参数不是 JSON → invalid_input', async () => {
    const noChoices = mockFetch({ choices: [] })
    const p1 = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: noChoices.fetch,
    })
    await expect(p1.complete({ messages: [] })).rejects.toBeInstanceOf(ProviderError)

    const badArgs = mockFetch({
      choices: [
        { message: { content: '', tool_calls: [{ function: { name: 'x', arguments: '{' } }] } },
      ],
    })
    const p2 = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: badArgs.fetch,
    })
    await expect(p2.complete({ messages: [] })).rejects.toMatchObject({ code: 'invalid_input' })

    const noName = mockFetch({
      choices: [{ message: { content: '', tool_calls: [{ function: {} }] } }],
    })
    const p3 = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: noName.fetch,
    })
    await expect(p3.complete({ messages: [] })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('给了 embeddingModel 才有 embed，走 /embeddings', async () => {
    const plain = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      env,
      fetch: mockFetch({}).fetch,
    })
    expect(plain.embed).toBeUndefined()

    const { fetch, calls } = mockFetch({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      usage: { prompt_tokens: 8 },
    })
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/',
      embeddingModel: 'bge-m3',
      env,
      fetch,
    })
    const out = await provider.embed?.(['a', 'b'])
    expect(calls[0]?.url).toBe('https://api.deepseek.com/embeddings')
    expect(out?.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    expect(out?.usage.input_tokens).toBe(8)

    const short = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      model: 'deepseek-chat',
      embeddingModel: 'bge-m3',
      env,
      fetch: mockFetch({ data: [{ embedding: [1] }] }).fetch,
    })
    await expect(short.embed?.(['a', 'b'])).rejects.toBeInstanceOf(ProviderError)
  })

  it('经网关调用：cost_base 按价格表算，tool_calls 透传，事件落账', async () => {
    const rec = recorder()
    const { fetch } = mockFetch(chatBody)
    const gw = createModelGateway({
      providers: [
        openaiCompatibleProvider({
          apiKeyEnv: KEY_ENV,
          model: 'deepseek-chat',
          region: 'cn',
          env,
          fetch,
        }),
      ],
      policy: policy({ default: { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const out = await gw.complete({ messages: [userPrompt('q')], meta: meta() })
    expect(out.tool_calls?.[0]?.name).toBe('orders.get')
    // 40 未命中 × 1000 + 60 命中 × 100 + 20 输出 × 2000 每 1M
    expect(out.usage.cost_base).toBeCloseTo((40 * 1_000 + 60 * 100 + 20 * 2_000) / 1_000_000, 12)
    expect(rec.ofType('model.usage')[0]?.payload).toMatchObject({ cost_base: out.usage.cost_base })
  })
})
