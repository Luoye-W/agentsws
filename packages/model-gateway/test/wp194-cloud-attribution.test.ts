/**
 * WP194：「Agents 工坊官方接口」那一条在请求头里带「谁 / 哪个岗位」，云上说
 * 「本月额度用完了」时那句人话原样端给用户（不被翻成泛泛的上游错误、也不去换一家）。
 */
import { describe, expect, it } from 'vitest'
import { cloudQuotaError, createModelGateway, openaiCompatibleProvider } from '../src/index.js'
import { fixedClock, meta, policy, recorder, userPrompt } from './helpers.js'

type Init = { method: string; headers: Record<string, string>; body?: unknown }

function provider(respond: (init: Init) => { status: number; body: string }) {
  const calls: Init[] = []
  const p = openaiCompatibleProvider({
    baseUrl: 'https://cloud.test.invalid/v1/ai',
    apiKey: () => 'wst_test_not_real',
    model: 'deepseek-chat',
    provider: 'agentsws_cloud',
    region: 'cn',
    cloudErrors: true,
    requestHeaders: (m) =>
      m === undefined
        ? {}
        : { 'X-Agentsws-Member': `p_${m.assignment_id}`, 'X-Agentsws-Position': 'cs' },
    fetch: async (_url, init) => {
      calls.push(init as Init)
      const r = respond(init as Init)
      return {
        ok: r.status < 400,
        status: r.status,
        json: async () => JSON.parse(r.body) as unknown,
        text: async () => r.body,
      }
    },
  })
  return { p, calls }
}

const completion = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: '好' } }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
})

describe('WP194 官方接口：带「谁」', () => {
  it('对话时按这一次的 meta 带归属头；没有 meta 就不带', async () => {
    const { p, calls } = provider(() => ({ status: 200, body: completion }))
    await p.complete({ messages: [userPrompt('hi')], meta: meta({ assignment_id: 'asg_9' }) })
    expect(calls[0]?.headers['X-Agentsws-Member']).toBe('p_asg_9')
    expect(calls[0]?.headers['X-Agentsws-Position']).toBe('cs')
    await p.complete({ messages: [userPrompt('hi')] })
    expect(calls[1]?.headers['X-Agentsws-Member']).toBeUndefined()
  })

  it('网关把 meta 递给 provider', async () => {
    const { p, calls } = provider(() => ({ status: 200, body: completion }))
    const gw = createModelGateway({
      providers: [p],
      policy: policy({
        default: { provider: 'agentsws_cloud', model: 'deepseek-chat', region: 'cn' },
        prices: { 'agentsws_cloud/deepseek-chat': { in: 0, out: 0, cached: 0 } },
      }),
      clock: fixedClock(),
      eventSink: recorder().sink,
      env: {},
    })
    await gw.complete({ messages: [userPrompt('hi')], meta: meta({ assignment_id: 'asg_7' }) })
    expect(calls[0]?.headers['X-Agentsws-Member']).toBe('p_asg_7')
  })
})

describe('WP194 官方接口：额度到了那句人话', () => {
  it('402 + 我们的信封 → budget_exhausted + 原话 + reason；网关原样往上抛，不说 all providers failed', async () => {
    const { p } = provider(() => ({
      status: 402,
      body: JSON.stringify({
        code: 'insufficient_credits',
        message: '本月额度用完了，找管理员加。',
        details: { reason: 'member_limit' },
      }),
    }))
    const gw = createModelGateway({
      providers: [p],
      policy: policy({
        default: { provider: 'agentsws_cloud', model: 'deepseek-chat', region: 'cn' },
        prices: { 'agentsws_cloud/deepseek-chat': { in: 0, out: 0, cached: 0 } },
      }),
      clock: fixedClock(),
      eventSink: recorder().sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('hi')], meta: meta() })).rejects.toMatchObject(
      {
        code: 'budget_exhausted',
        message: '本月额度用完了，找管理员加。',
        details: { reason: 'member_limit', status: 402 },
      },
    )
  })

  it('正文不是信封也不报 500：一句不分人的人话', () => {
    const e = cloudQuotaError('<html>bad gateway</html>')
    expect(e.code).toBe('budget_exhausted')
    expect(e.message).toContain('积分不够')
  })
})
