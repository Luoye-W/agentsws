/**
 * WP242：上游打不通时，`provider_down` 那一行带上**真原因**（cause.code），不只是 `fetch failed`；
 * 连接被掐（`ECONNRESET` / 陈旧长连接）马上重发一次。
 */
import { describe, expect, it } from 'vitest'
import {
  createModelGateway,
  describeFetchError,
  isTransientNetError,
  netCauseOf,
  openaiCompatibleProvider,
} from '../src/index.js'
import { fixedClock, meta, policy, prices, recorder, userPrompt } from './helpers.js'

/** Node `fetch` 打不通时抛的那个形状：`TypeError('fetch failed')`，真原因挂在 cause 上。 */
const fetchFailed = (code: string, message: string): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })

const completion = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: '好' } }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
})

function cloud(fail: (n: number) => Error | undefined, apiKey = 'wst_test_not_real') {
  let n = 0
  return openaiCompatibleProvider({
    baseUrl: 'https://cloud.test.invalid/v1/ai',
    apiKey: () => apiKey,
    model: 'deepseek-flash',
    provider: 'agentsws',
    region: 'cn',
    cloudErrors: true,
    fetch: async () => {
      n += 1
      const err = fail(n)
      if (err !== undefined) throw err
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(completion) as unknown,
        text: async () => completion,
      }
    },
  })
}

describe('WP242 网络层失败的真原因', () => {
  it('挖 cause 链：错误码与那一句；AggregateError（连两个地址都失败）也挖得到', () => {
    expect(netCauseOf(fetchFailed('ECONNRESET', 'read ECONNRESET'))).toEqual({
      code: 'ECONNRESET',
      detail: 'ECONNRESET read ECONNRESET',
    })
    const agg = new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('connect ETIMEDOUT 198.18.0.7:443'), { code: 'ETIMEDOUT' }),
      ]),
    })
    expect(describeFetchError(agg)).toContain('ETIMEDOUT')
    expect(describeFetchError(new Error('plain'))).toBe('plain')
    expect(isTransientNetError(fetchFailed('ECONNRESET', 'x'))).toBe(true)
    expect(isTransientNetError(fetchFailed('ECONNREFUSED', 'x'))).toBe(false)
  })

  it('连接被掐一次：马上重发，这一次照常成', async () => {
    const p = cloud((n) =>
      n === 1 ? fetchFailed('UND_ERR_SOCKET', 'other side closed') : undefined,
    )
    const out = await p.complete({ messages: [userPrompt('hi')] })
    expect(out.text).toBe('好')
  })

  it('一直打不通：provider_down 里带 cause.code，不只是 fetch failed', async () => {
    const events = recorder()
    const gw = createModelGateway({
      providers: [
        cloud(() =>
          fetchFailed(
            'UND_ERR_CONNECT_TIMEOUT',
            'Connect Timeout Error (attempted address: x:443)',
          ),
        ),
      ],
      policy: policy({
        default: { provider: 'agentsws', model: 'deepseek-flash', region: 'cn' },
        prices: { ...prices, 'agentsws/deepseek-flash': { in: 1_000, out: 2_000, cached: 100 } },
      }),
      clock: fixedClock(),
      eventSink: events.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('hi')], meta: meta() })).rejects.toMatchObject(
      { code: 'provider_unavailable' },
    )
    const down = events.events.find((e) => e.type === 'model.provider_down')
    const payload = down?.payload as { attempts: { message: string }[] } | undefined
    const message = payload?.attempts[0]?.message
    expect(message).toContain('fetch failed')
    expect(message).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('官方接口那一条没有令牌：说的是「这个品牌没有关联」，不是 missing api key', async () => {
    const p = cloud(() => undefined, '')
    await expect(p.complete({ messages: [userPrompt('hi')] })).rejects.toThrow(
      /no Agents Workshop link/,
    )
  })
})
