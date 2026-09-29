/**
 * WP188：流式与停止（随便聊要的两样）。全部替身，不联网。
 *
 * - 会流式的 provider（OpenAI 兼容口的 SSE、stub）一段一段交给 `on_delta`，拼起来与整段一样；
 * - 不会流式的 provider 网关补调一次 `on_delta`（调用方不用分两种写）；
 * - `signal` abort：不降级、不报 provider_down，回已经吐出的那部分（`stopped: true`），照样记一笔用量。
 */
import type { ModelProvider } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import { createModelGateway, openaiCompatibleProvider, stubProvider } from '../src/index.js'
import { fixedClock, fixedProvider, meta, policy, recorder, userPrompt } from './helpers.js'

const KEY_ENV = 'AGENTSWS_TEST_KEY'
const env = { [KEY_ENV]: 'test-value-not-a-real-credential' }

const sse = (chunks: unknown[]): string =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`

/** 一个会按块吐字节的 fetch 替身（真 `ReadableStream`），每块之间让出一拍。 */
const streamingFetch = (
  body: string,
  seen: { payload?: Record<string, unknown> } = {},
): FetchLike => {
  return async (_url, init) => {
    seen.payload = JSON.parse(String(init.body)) as Record<string, unknown>
    const bytes = new TextEncoder().encode(body)
    const signal = init.signal
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < bytes.length; i += 17) {
          if (signal?.aborted === true) {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            return
          }
          controller.enqueue(bytes.slice(i, i + 17))
          await new Promise((r) => setTimeout(r, 1))
        }
        controller.close()
      },
    })
    return {
      ok: true,
      status: 200,
      body: stream,
      json: async () => ({}),
      text: async () => body,
    }
  }
}

const gatewayWith = (providers: ModelProvider[], defaultRef = providers[0]?.ref) => {
  const rec = recorder()
  const gateway = createModelGateway({
    providers,
    policy: policy({
      ...(defaultRef === undefined ? {} : { default: defaultRef }),
      prices: {
        'test/m1': { in: 1_000_000, out: 2_000_000, cached: 0 },
        'stub/stub-v1': { in: 0, out: 0, cached: 0 },
      },
    }),
    clock: fixedClock(),
    eventSink: rec.sink,
    env: {},
  })
  return { gateway, rec }
}

describe('WP188 OpenAI 兼容口流式', () => {
  it('stream: true + include_usage；一段一段交给 on_delta，拼起来是整段，用量取最后一块', async () => {
    const seen: { payload?: Record<string, unknown> } = {}
    const body = sse([
      { choices: [{ delta: { content: '你好，' } }] },
      { choices: [{ delta: { content: '我是随便聊。' } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ])
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      env,
      model: 'm1',
      provider: 'test',
      fetch: streamingFetch(body, seen),
    })
    const { gateway, rec } = gatewayWith([provider])
    const deltas: string[] = []
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta({ purpose: 'free_chat' }),
      on_delta: (t) => deltas.push(t),
    })
    expect(seen.payload?.stream).toBe(true)
    expect(seen.payload?.stream_options).toEqual({ include_usage: true })
    expect(deltas.join('')).toBe('你好，我是随便聊。')
    expect(deltas.length).toBe(2)
    expect(out.text).toBe('你好，我是随便聊。')
    expect(out.usage.input_tokens).toBe(12)
    expect(out.usage.output_tokens).toBe(7)
    expect(out.stopped).toBeUndefined()
    const usage = rec.ofType('model.usage')
    expect(usage).toHaveLength(1)
    expect((usage[0]?.payload as { purpose: string }).purpose).toBe('free_chat')
  })

  it('流式里的工具调用按 index 拼回一整条（与非流式同形）', async () => {
    const body = sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"que' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"天气"}' } }] } },
        ],
      },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ])
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      env,
      model: 'm1',
      provider: 'test',
      fetch: streamingFetch(body),
    })
    const { gateway } = gatewayWith([provider])
    const out = await gateway.complete({
      messages: [userPrompt('今天天气')],
      tools: [{ name: 'web_search', description: 'search', input_schema: { type: 'object' } }],
      meta: meta(),
      on_delta: () => undefined,
    })
    expect(out.tool_calls).toEqual([{ id: 'call_1', name: 'web_search', input: { query: '天气' } }])
  })

  it('不给 on_delta 就照旧非流式（stream: false，一个字节不变）', async () => {
    const seen: { payload?: Record<string, unknown> } = {}
    const fetch: FetchLike = async (_url, init) => {
      seen.payload = JSON.parse(String(init.body)) as Record<string, unknown>
      const json = {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
      return {
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }
    }
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      env,
      model: 'm1',
      provider: 'test',
      fetch,
    })
    const { gateway } = gatewayWith([provider])
    await gateway.complete({ messages: [userPrompt('hi')], meta: meta() })
    expect(seen.payload?.stream).toBe(false)
    expect(seen.payload?.stream_options).toBeUndefined()
  })
})

describe('WP188 网关：补调、停止', () => {
  it('不会流式的 provider：拿到整段之后补调一次 on_delta', async () => {
    const provider = fixedProvider({ ref: { provider: 'test', model: 'm1' }, input: 3, output: 2 })
    const { gateway } = gatewayWith([provider])
    const deltas: string[] = []
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta(),
      on_delta: (t) => deltas.push(t),
    })
    expect(deltas).toEqual(['fixed'])
    expect(out.text).toBe('fixed')
  })

  it('stub 会流式：一个词一个词吐', async () => {
    const { gateway } = gatewayWith([stubProvider({ seed: 7 })])
    const deltas: string[] = []
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta(),
      on_delta: (t) => deltas.push(t),
    })
    expect(deltas.length).toBe(8)
    expect(deltas.join('')).toBe(out.text)
  })

  it('中途停：回已经吐出的那部分（stopped），不降级、不报 provider_down，照样记一笔用量', async () => {
    const controller = new AbortController()
    const backup = fixedProvider({ ref: { provider: 'backup', model: 'b1' } })
    const { gateway, rec } = gatewayWith([stubProvider({ seed: 7 }), backup])
    const deltas: string[] = []
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta({ purpose: 'free_chat' }),
      signal: controller.signal,
      on_delta: (t) => {
        deltas.push(t)
        if (deltas.length === 3) controller.abort()
      },
    })
    expect(out.stopped).toBe(true)
    expect(out.text).toBe(deltas.join(''))
    expect(deltas.length).toBe(3)
    expect(out.usage.output_tokens).toBeGreaterThan(0)
    expect(rec.ofType('model.provider_down')).toHaveLength(0)
    expect(rec.ofType('model.usage')).toHaveLength(1)
  })

  it('不会流式的 provider 也停得下来（网关不再等它）', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = fixedProvider({ ref: { provider: 'test', model: 'm1' }, gate })
    const { gateway } = gatewayWith([slow])
    const controller = new AbortController()
    const pending = gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta(),
      signal: controller.signal,
      on_delta: () => undefined,
    })
    controller.abort()
    const out = await pending
    release()
    expect(out.stopped).toBe(true)
    expect(out.text).toBe('')
  })

  it('还没发请求就停了：什么都不花、不记账', async () => {
    const controller = new AbortController()
    controller.abort()
    const { gateway, rec } = gatewayWith([stubProvider({ seed: 7 })])
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta(),
      signal: controller.signal,
    })
    expect(out.stopped).toBe(true)
    expect(out.usage.cost_base).toBe(0)
    expect(rec.ofType('model.usage')).toHaveLength(0)
  })

  it('OpenAI 兼容口流式中途停：真的断开读取，回已经收到的那部分', async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      choices: [{ delta: { content: `字${i}` } }],
    }))
    const provider = openaiCompatibleProvider({
      apiKeyEnv: KEY_ENV,
      env,
      model: 'm1',
      provider: 'test',
      fetch: streamingFetch(sse(chunks)),
    })
    const { gateway, rec } = gatewayWith([provider])
    const controller = new AbortController()
    const deltas: string[] = []
    const out = await gateway.complete({
      messages: [userPrompt('hi')],
      meta: meta(),
      signal: controller.signal,
      on_delta: (t) => {
        deltas.push(t)
        if (deltas.length === 5) controller.abort()
      },
    })
    expect(out.stopped).toBe(true)
    expect(out.text).toBe(deltas.join(''))
    expect(deltas.length).toBeLessThan(40)
    expect(rec.ofType('model.provider_down')).toHaveLength(0)
  })
})
