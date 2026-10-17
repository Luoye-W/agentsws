/**
 * WP377（决策 1051）：「Agents 工坊官方接口」那一条把思考档原样写进请求体 `reasoning_effort`（我们自己的 id），
 * 云端按上游那家的写法转。别家不发；调用方硬要「别想」时也不发。不联网（fetch 是替身）。
 */
import { describe, expect, it } from 'vitest'
import { createModelGateway, type FetchLike, openaiCompatibleProvider } from '../src/index.js'
import { fixedClock, meta, policy, prices, recorder } from './helpers.js'

function fakeFetch(): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const json = {
      choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { fetch, bodies }
}

const REF = { provider: 'agentsws', model: 'deepseek-v4-pro', region: 'cn' as const }

function gatewayOf(fetch: FetchLike, sendReasoningEffort: boolean | undefined) {
  return createModelGateway({
    providers: [
      openaiCompatibleProvider({
        baseUrl: 'https://cloud.example.test/v1/ai',
        apiKey: () => 'wst_test_not_real',
        model: REF.model,
        provider: REF.provider,
        region: 'cn',
        fetch,
        ...(sendReasoningEffort === undefined ? {} : { sendReasoningEffort }),
      }),
    ],
    policy: policy({
      default: REF,
      prices: { ...prices, 'agentsws/deepseek-v4-pro': { in: 1_000, out: 2_000, cached: 100 } },
    }),
    clock: fixedClock(),
    eventSink: recorder().sink,
    env: {},
  })
}

const ask = { messages: [{ role: 'user' as const, content: '在吗' }], meta: meta() }

describe('WP377 官方接口那一条发思考档', () => {
  it('选了「深度」（max）：请求体带 reasoning_effort = max，别的不多写', async () => {
    const { fetch, bodies } = fakeFetch()
    await gatewayOf(fetch, true).complete({ ...ask, reasoning_effort: 'max' })
    expect(bodies[0]?.reasoning_effort).toBe('max')
    expect(bodies[0]).not.toHaveProperty('thinking')
  })

  it('关掉（off）也原样发 off，由云端翻成上游的「关思考」', async () => {
    const { fetch, bodies } = fakeFetch()
    await gatewayOf(fetch, true).complete({ ...ask, reasoning_effort: 'off' })
    expect(bodies[0]?.reasoning_effort).toBe('off')
  })

  it('没选档：一格不多（请求字节和以前一样）', async () => {
    const { fetch, bodies } = fakeFetch()
    await gatewayOf(fetch, true).complete(ask)
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('调用方硬要「别想」（WP243）：只发关思考那一格，不叠 reasoning_effort', async () => {
    const { fetch, bodies } = fakeFetch()
    await gatewayOf(fetch, true).complete({ ...ask, thinking: 'off', reasoning_effort: 'max' })
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('别家（没开 sendReasoningEffort）：选了档也不发', async () => {
    const { fetch, bodies } = fakeFetch()
    await gatewayOf(fetch, undefined).complete({ ...ask, reasoning_effort: 'max' })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })
})
