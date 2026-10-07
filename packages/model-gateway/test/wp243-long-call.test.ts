/**
 * WP243：长一点的云模型调用在 Windows 真机上被中途掐断（`UND_ERR_SOCKET other side closed`）。
 *
 * 钉住：
 * 1. 「空闲就掐线」的那一跳：非流式会断（重发那一次也断，两次都记进 provider_down，带错误码与耗时）；
 *    官方接口那一条改成内部走流式（`streamAlways`）之后不断。
 * 2. 流式中途断了（连接被掐 / 干净地关了但没说完）：拿到的那一截不当成功，整体重发一次；
 *    成了之后 `model.usage` 里记着重发过的那一次（`net_retries`）。
 * 3. 调用方已经看到字了（随便聊）：不重来（重来会把两段拼在一起），照实报错。
 * 4. 输出上限 / 关思考：按各家线上的写法出线。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createModelGateway,
  type FetchLike,
  type ModelUsagePayload,
  openaiCompatibleProvider,
  type ProviderDownPayload,
  thinkingOffFields,
} from '../src/index.js'
import { fixedClock, meta, policy, prices, recorder, userPrompt } from './helpers.js'
import { type IdleCloud, type IdleCloudOptions, idleCloud } from './idle-cloud.js'

const realFetch = globalThis.fetch as unknown as FetchLike

const clouds: IdleCloud[] = []
afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close()
})

async function cloudOf(options: IdleCloudOptions = {}): Promise<IdleCloud> {
  const c = await idleCloud(options)
  clouds.push(c)
  return c
}

const REF = { provider: 'agentsws', model: 'deepseek-flash', region: 'cn' as const }

function gatewayOf(base: string, streamAlways: boolean) {
  const events = recorder()
  const gw = createModelGateway({
    providers: [
      openaiCompatibleProvider({
        baseUrl: base,
        apiKey: () => 'wst_test_not_real',
        model: 'deepseek-flash',
        provider: 'agentsws',
        region: 'cn',
        cloudErrors: true,
        streamAlways,
        fetch: realFetch,
      }),
    ],
    policy: policy({
      default: REF,
      prices: { ...prices, 'agentsws/deepseek-flash': { in: 1_000, out: 2_000, cached: 100 } },
    }),
    clock: fixedClock(),
    eventSink: events.sink,
    env: {},
  })
  return { gw, events }
}

const ANSWER = '{"roles":[["site.shopify-build","独立站要改主题","Shopify"]]}'

describe('WP243 空闲掐线：非流式会断，内部走流式不断', () => {
  it('非流式：几百毫秒没字节就被掐（缩小版的 45 秒）；重发那一次也被掐，两次都记在 provider_down', async () => {
    const cloud = await cloudOf({ idleMs: 250, answerMs: 800, text: () => ANSWER })
    const { gw, events } = gatewayOf(cloud.base, false)
    await expect(
      gw.complete({ messages: [userPrompt('推荐')], meta: meta({ purpose: 'extraction' }) }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(cloud.killed).toBe(2)
    const down = events.ofType('model.provider_down')[0]?.payload as ProviderDownPayload
    expect(down.attempts).toHaveLength(2)
    for (const a of down.attempts) {
      expect(a.code).toBe('UND_ERR_SOCKET')
      expect(a.message).toContain('other side closed')
      // 每一次都等到了被掐那一刻
      expect(a.duration_ms ?? 0).toBeGreaterThanOrEqual(200)
    }
    expect(cloud.bodies.every((b) => b.stream === false)).toBe(true)
  })

  it('官方接口那一条（streamAlways）：同样的长回答一路有字节，不被掐，拿到完整的一整段', async () => {
    const cloud = await cloudOf({ idleMs: 250, answerMs: 800, text: () => ANSWER })
    const { gw, events } = gatewayOf(cloud.base, true)
    const out = await gw.complete({
      messages: [userPrompt('推荐')],
      meta: meta({ purpose: 'extraction' }),
    })
    expect(out.text).toBe(ANSWER)
    expect(cloud.killed).toBe(0)
    expect(cloud.bodies).toHaveLength(1)
    expect(cloud.bodies[0]?.stream).toBe(true)
    expect(cloud.bodies[0]?.stream_options).toEqual({ include_usage: true })
    const usage = events.ofType('model.usage')[0]?.payload as ModelUsagePayload
    expect(usage.input_tokens).toBe(3126)
    expect(usage.net_retries).toBeUndefined()
    expect(events.ofType('model.provider_down')).toHaveLength(0)
  })
})

describe('WP243 流式中途断了：不当成功，整体重发一次', () => {
  it('第一次流到一半连接被掐（UND_ERR_SOCKET）：重发一次成功；拿的是第二次的完整答案；usage 记着重发', async () => {
    const cloud = await cloudOf({
      text: (n) => (n === 1 ? `${ANSWER}  ` : ANSWER),
      breakAt: (n) => (n === 1 ? 'reset' : undefined),
    })
    const { gw, events } = gatewayOf(cloud.base, true)
    const out = await gw.complete({ messages: [userPrompt('推荐')], meta: meta() })
    expect(out.text).toBe(ANSWER)
    expect(cloud.bodies).toHaveLength(2)
    const usage = events.ofType('model.usage')[0]?.payload as ModelUsagePayload
    expect(usage.net_retries).toHaveLength(1)
    expect(usage.net_retries?.[0]?.code).toBe('UND_ERR_SOCKET')
    expect(usage.net_retries?.[0]?.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('流干净地关了却没说「完了」：那一截不当成功（STREAM_INCOMPLETE），重发一次成功', async () => {
    const cloud = await cloudOf({ breakAt: (n) => (n === 1 ? 'close' : undefined) })
    const { gw, events } = gatewayOf(cloud.base, true)
    const out = await gw.complete({ messages: [userPrompt('推荐')], meta: meta() })
    expect(out.text).toBe('{"roles":[{"role_id":"site.shopify-build"}]}')
    const usage = events.ofType('model.usage')[0]?.payload as ModelUsagePayload
    expect(usage.net_retries?.map((t) => t.code)).toEqual(['STREAM_INCOMPLETE'])
  })

  it('两次都断：provider_down 两条（第一次 + 重发那一次），各带错误码', async () => {
    const cloud = await cloudOf({ breakAt: () => 'reset' })
    const { gw, events } = gatewayOf(cloud.base, true)
    await expect(
      gw.complete({ messages: [userPrompt('推荐')], meta: meta() }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    const down = events.ofType('model.provider_down')[0]?.payload as ProviderDownPayload
    expect(down.attempts.map((a) => a.code)).toEqual(['UND_ERR_SOCKET', 'UND_ERR_SOCKET'])
    expect(down.attempts.every((a) => typeof a.duration_ms === 'number')).toBe(true)
  })

  it('随便聊已经给人看到字了：不重来（两段会拼在一起），照实报错', async () => {
    const cloud = await cloudOf({ breakAt: () => 'reset' })
    const { gw, events } = gatewayOf(cloud.base, true)
    const shown: string[] = []
    await expect(
      gw.complete({
        messages: [userPrompt('在吗')],
        meta: meta({ purpose: 'free_chat' }),
        on_delta: (t) => shown.push(t),
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(shown.join('')).not.toBe('')
    expect(cloud.bodies).toHaveLength(1)
    const down = events.ofType('model.provider_down')[0]?.payload as ProviderDownPayload
    expect(down.attempts).toHaveLength(1)
  })
})

describe('WP243 输出上限 / 关思考', () => {
  it('DeepSeek：max_tokens + thinking disabled 出线；网关按上限预留', async () => {
    const cloud = await cloudOf({ answerMs: 50 })
    const { gw } = gatewayOf(cloud.base, true)
    await gw.complete({
      messages: [userPrompt('推荐')],
      meta: meta({ purpose: 'extraction' }),
      max_output_tokens: 2048,
      thinking: 'off',
    })
    expect(cloud.bodies[0]).toMatchObject({ max_tokens: 2048, thinking: { type: 'disabled' } })
  })

  it('不给提示：请求体里没有这几格（照旧）', async () => {
    const cloud = await cloudOf({ answerMs: 50 })
    const { gw } = gatewayOf(cloud.base, true)
    await gw.complete({ messages: [userPrompt('推荐')], meta: meta() })
    expect(cloud.bodies[0]).not.toHaveProperty('max_tokens')
    expect(cloud.bodies[0]).not.toHaveProperty('thinking')
  })

  it('各家「关思考」的写法；认不出的不发', () => {
    expect(thinkingOffFields('deepseek-flash')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingOffFields('glm-5.3-flash')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingOffFields('qwen3.8-flash')).toEqual({ enable_thinking: false })
    expect(thinkingOffFields('gpt-4o')).toEqual({})
  })

  it('OpenAI 推理模型：上限写成 max_completion_tokens', async () => {
    let sent: Record<string, unknown> = {}
    const p = openaiCompatibleProvider({
      baseUrl: 'https://api.test.invalid/v1',
      apiKey: () => 'sk_test_not_real',
      model: 'o4-mini',
      provider: 'openai',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>
        const body = JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }
      },
    })
    await p.complete({ messages: [userPrompt('hi')], max_output_tokens: 1000, thinking: 'off' })
    expect(sent).toMatchObject({ max_completion_tokens: 1000 })
    expect(sent).not.toHaveProperty('max_tokens')
    expect(sent).not.toHaveProperty('thinking')
  })
})
