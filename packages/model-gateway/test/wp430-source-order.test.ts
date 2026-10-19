import type { Clock, ModelProvider, ModelRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { SourceFallbackPolicy } from '../src/index.js'
import {
  createModelGateway,
  GatewayError,
  ProviderError,
  sourceChainMessage,
  sourceFallbackOffOf,
} from '../src/index.js'
import { meta, policy, prices, recorder, userPrompt } from './helpers.js'

/**
 * WP430（决策 1288–1290）：AI 来源顺序补齐——这次选的 → 自己配的其它（按「AI 来源」排的顺序）→ 工坊积分；
 * 一轮里切过用到底、下一轮先试原选；同一来源连续失败 2 次后 10 分钟内直接跳过；登录类来源失效发「要重新登录」。
 */

const chatgpt: ModelRef = { provider: 'sub', model: 'gpt-5', region: 'global' }
const deepseek: ModelRef = { provider: 'ds', model: 'deepseek-chat', region: 'cn' }
const kimi: ModelRef = { provider: 'kimi', model: 'k2', region: 'cn' }
const cloud: ModelRef = { provider: 'cloud', model: 'deepseek-flash', region: 'cn' }

type Step = () => void
const ok: Step = () => {}
const http =
  (status: number): Step =>
  () => {
    throw new ProviderError(`provider http ${status}`, { status })
  }
const expired: Step = () => {
  throw new GatewayError('unauthenticated', 'ChatGPT 订阅登录过期了')
}

const scripted = (ref: ModelRef, script: Step[]): ModelProvider & { calls: number } => {
  const p = {
    ref,
    calls: 0,
    async complete() {
      const step = script[Math.min(p.calls, script.length - 1)]
      p.calls += 1
      step?.()
      return {
        text: `from ${ref.provider}`,
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
      }
    },
  }
  return p
}

/** 能往前拨的钟（冷却靠它）。 */
const movableClock = (): Clock & { advance(ms: number): void } => {
  let t = Date.parse('2026-10-19T08:00:00.000Z')
  return {
    now: () => new Date(t).toISOString(),
    advance(ms) {
      t += ms
    },
  }
}

const zero = { in: 0, out: 0, cached: 0 }

const setup = (
  scripts: { sub?: Step[]; ds?: Step[]; kimi?: Step[]; cloud?: Step[] },
  over: Partial<SourceFallbackPolicy> = {},
  primary: ModelRef = chatgpt,
) => {
  const rec = recorder()
  const clock = movableClock()
  const sub = scripted(chatgpt, scripts.sub ?? [ok])
  const ds = scripted(deepseek, scripts.ds ?? [ok])
  const km = scripted(kimi, scripts.kimi ?? [ok])
  const cl = scripted(cloud, scripts.cloud ?? [ok])
  const fb: SourceFallbackPolicy = {
    to: cloud,
    enabled: true,
    labels: { sub: 'ChatGPT', ds: 'DeepSeek', kimi: 'Kimi' },
    own: [chatgpt, deepseek],
    relogin: ['sub'],
    ...over,
  }
  const gw = createModelGateway({
    providers: [sub, ds, km, cl],
    policy: policy({
      default: primary,
      prices: {
        ...prices,
        'sub/gpt-5': zero,
        'ds/deepseek-chat': zero,
        'kimi/k2': zero,
        'cloud/deepseek-flash': { in: 1, out: 1, cached: 0 },
      },
      source_fallback: fb,
    }),
    clock,
    eventSink: rec.sink,
    env: {},
  })
  return { gw, rec, clock, sub, ds, km, cl }
}

const ask = (run_id = 'run_1') => ({ messages: [userPrompt('q')], meta: meta({ run_id }) })

describe('WP430 AI 来源顺序：这次选的 → 自己的其它 → 工坊积分', () => {
  it('原选 429 → 自己的第二条接上，照实说「这一轮用了你的 DeepSeek」，不花积分', async () => {
    const { gw, rec, ds, cl } = setup({ sub: [http(429)] })
    const out = await gw.complete(ask())
    expect(out.model).toEqual(deepseek)
    expect(out.source_switch).toEqual({
      from: chatgpt,
      to: deepseek,
      reason: 'quota',
      message: '你的 ChatGPT 额度用完了，这一轮用了你的 DeepSeek',
      target: 'own',
    })
    expect(ds.calls).toBe(1)
    expect(cl.calls).toBe(0)
    expect(rec.ofType('model.source_switched')).toHaveLength(1)
  })

  it('自己的两条都不行 → 工坊积分；那一句把两条各自怎么了都说上', async () => {
    const { gw, cl } = setup({ sub: [http(429)], ds: [http(503)] })
    const out = await gw.complete(ask())
    expect(out.model).toEqual(cloud)
    expect(out.source_switch?.target).toBe('workshop')
    expect(out.source_switch?.message).toBe(
      '你的 ChatGPT 额度用完了，你的 DeepSeek 连不上，这一轮用工坊积分',
    )
    expect(cl.calls).toBe(1)
  })

  it('按「AI 来源」里排的顺序接：排在前面的先试', async () => {
    const { gw, ds, km } = setup({ sub: [http(429)] }, { own: [kimi, deepseek] })
    const out = await gw.complete(ask())
    expect(out.model).toEqual(kimi)
    expect(km.calls).toBe(1)
    expect(ds.calls).toBe(0)
  })

  it('没挂在网关上的（没登录 / 没测过的不给）跳过；这次选的在清单里也只试一次', async () => {
    const ghost: ModelRef = { provider: 'ghost', model: 'x' }
    const { gw, sub, ds } = setup({ sub: [http(429)] }, { own: [ghost, chatgpt, deepseek] })
    const out = await gw.complete(ask())
    expect(out.model).toEqual(deepseek)
    expect(sub.calls).toBe(1)
  })

  it('一轮里切过就用到底；下一轮先试原选', async () => {
    const { gw, sub, ds } = setup({ sub: [http(429), ok] })
    const first = await gw.complete(ask('run_a'))
    expect(first.model).toEqual(deepseek)
    // 同一轮：直接走 DeepSeek，不再试 ChatGPT，也不再带切换
    const again = await gw.complete(ask('run_a'))
    expect(again.model).toEqual(deepseek)
    expect(again.source_switch).toBeUndefined()
    expect(sub.calls).toBe(1)
    expect(ds.calls).toBe(2)
    // 下一轮：先试原选（它已经好了）
    const next = await gw.complete(ask('run_b'))
    expect(next.model).toEqual(chatgpt)
    expect(next.source_switch).toBeUndefined()
    expect(sub.calls).toBe(2)
  })

  it('同一轮里切到的那条后来也不行了：接着往下走，不回头', async () => {
    const { gw, sub, cl } = setup({ sub: [http(429)], ds: [ok, http(503)] })
    await gw.complete(ask('run_a'))
    const second = await gw.complete(ask('run_a'))
    expect(second.model).toEqual(cloud)
    expect(second.source_switch?.message).toBe('你的 DeepSeek 连不上，这一轮用工坊积分')
    expect(sub.calls).toBe(1)
    expect(cl.calls).toBe(1)
  })

  it('同一来源连续失败 2 次 → 10 分钟内直接跳过它；10 分钟后再试；好了就清零', async () => {
    const { gw, clock, sub, ds } = setup({ sub: [http(429), http(429), ok] })
    await gw.complete(ask('r1'))
    await gw.complete(ask('r2'))
    expect(sub.calls).toBe(2)
    // 冷却中：第三轮不再碰 ChatGPT，直接 DeepSeek，那一句照实说
    clock.advance(5 * 60_000)
    const r3 = await gw.complete(ask('r3'))
    expect(sub.calls).toBe(2)
    expect(r3.model).toEqual(deepseek)
    expect(r3.source_switch?.message).toBe('你的 ChatGPT 额度用完了，这一轮用了你的 DeepSeek')
    // 10 分钟后再试（这一次它好了）
    clock.advance(6 * 60_000)
    const r4 = await gw.complete(ask('r4'))
    expect(sub.calls).toBe(3)
    expect(r4.model).toEqual(chatgpt)
    expect(r4.source_switch).toBeUndefined()
    expect(ds.calls).toBe(3)
  })

  it('只失败 1 次不冷却：下一轮照样先试原选', async () => {
    const { gw, sub } = setup({ sub: [http(503), ok] })
    await gw.complete(ask('r1'))
    const r2 = await gw.complete(ask('r2'))
    expect(sub.calls).toBe(2)
    expect(r2.model).toEqual(chatgpt)
  })

  it('冷却过了再试还不行：马上再冷却一轮（不用重新攒两次）', async () => {
    const { gw, clock, sub } = setup({ sub: [http(429)] })
    await gw.complete(ask('r1'))
    await gw.complete(ask('r2'))
    clock.advance(11 * 60_000)
    await gw.complete(ask('r3'))
    expect(sub.calls).toBe(3)
    await gw.complete(ask('r4'))
    expect(sub.calls).toBe(3)
  })

  it('全都在冷却：照顺序都试一遍（不至于一个都不试就停）', async () => {
    const { gw, sub, ds, cl } = setup({
      sub: [http(429), http(429), ok],
      ds: [http(503), http(503), ok],
      cloud: [http(503), http(503), ok],
    })
    await expect(gw.complete(ask('r1'))).rejects.toBeTruthy()
    await expect(gw.complete(ask('r2'))).rejects.toBeTruthy()
    const r3 = await gw.complete(ask('r3'))
    expect(r3.model).toEqual(chatgpt)
    expect([sub.calls, ds.calls, cl.calls]).toEqual([3, 2, 2])
  })

  it('改了模型设置（重新登录 / 换 key）→ 冷却清零，马上再试', async () => {
    const { gw, sub, ds, km, cl } = setup({ sub: [http(429), http(429), ok] })
    await gw.complete(ask('r1'))
    await gw.complete(ask('r2'))
    gw.reconfigure({ providers: [sub, ds, km, cl] })
    const r3 = await gw.complete(ask('r3'))
    expect(r3.model).toEqual(chatgpt)
  })

  it('开关关着：自己的几条照样互相接（开关只管工坊积分那一跳）', async () => {
    const { gw, cl } = setup({ sub: [http(429)] }, { enabled: false })
    const out = await gw.complete(ask())
    expect(out.model).toEqual(deepseek)
    expect(cl.calls).toBe(0)
  })

  it('开关关着、自己的都不行：照实停下，那一句把每一条都说上，错误码是原选的', async () => {
    const { gw, cl } = setup({ sub: [http(429)], ds: [http(401)] }, { enabled: false })
    const err = await gw.complete(ask()).catch((e: unknown) => e)
    expect(cl.calls).toBe(0)
    expect((err as GatewayError).message).toBe(
      '你的 ChatGPT 额度用完了，你的 DeepSeek 登录或 key 失效了。「自己的用不了时用工坊积分接着做」关着，这一轮先停下',
    )
    expect(sourceFallbackOffOf(err)).toMatchObject({
      state: 'off',
      reason: 'quota',
      from: 'sub/gpt-5',
    })
  })

  it('没登录工坊账号：自己的几条照样互相接；都不行就原样报原选的错', async () => {
    const { gw, cl } = setup({ sub: [http(429)], ds: [http(503)] }, { to: undefined })
    const err = await gw.complete(ask()).catch((e: unknown) => e)
    expect(cl.calls).toBe(0)
    // 原选那一家的错（429 → provider_unavailable，details 里最后一次是 429）
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('provider_unavailable')
    expect(JSON.stringify((err as GatewayError).details)).toContain('429')
    expect(sourceFallbackOffOf(err)).toBeUndefined()
  })

  it('这次选的是工坊积分、它连不上：接自己配的（同样的顺序）', async () => {
    const { gw } = setup({ cloud: [http(503)] }, {}, cloud)
    const out = await gw.complete(ask())
    expect(out.model).toEqual(chatgpt)
    expect(out.source_switch?.message).toBe('工坊积分连不上，这一轮用了你的 ChatGPT')
    expect(out.source_switch?.target).toBe('own')
  })

  it('换来的那一家不认这次请求（400）→ 再往下；本机预算用完 → 停（换谁都是同一本账）', async () => {
    const a = setup({ sub: [http(429)], ds: [http(400)] })
    expect((await a.gw.complete(ask())).model).toEqual(cloud)
    const b = setup({
      sub: [http(429)],
      ds: [
        () => {
          throw new GatewayError('budget_exhausted', 'run cap')
        },
      ],
    })
    await expect(b.gw.complete(ask())).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(b.cl.calls).toBe(0)
  })

  it('登录类来源失效（订阅过期）：不停下、不出卡，接着切；发一次「要重新登录」（带来源名）', async () => {
    const { gw, rec } = setup({ sub: [expired] })
    const out = await gw.complete(ask('r1'))
    expect(out.model).toEqual(deepseek)
    expect(out.source_switch?.reason).toBe('auth')
    const relogin = rec.ofType('model_source.relogin_needed')
    expect(relogin).toHaveLength(1)
    expect(relogin[0]?.payload).toEqual({ provider: 'sub', label: 'ChatGPT' })
    // 重新能用之前不重复发
    await gw.complete(ask('r2'))
    expect(rec.ofType('model_source.relogin_needed')).toHaveLength(1)
  })

  it('「要重新登录」只给登录类来源、只在登录失效时发（额度用完、API key 401 不发）', async () => {
    const quota = setup({ sub: [http(429)] })
    await quota.gw.complete(ask())
    expect(quota.rec.ofType('model_source.relogin_needed')).toHaveLength(0)
    const key = setup({ ds: [http(401)] }, {}, deepseek)
    await key.gw.complete(ask())
    expect(key.rec.ofType('model_source.relogin_needed')).toHaveLength(0)
  })

  it('这次选的那一家已经不在网关上了（账号登录失效被摘掉）：算登录失效，直接往下接', async () => {
    const gone: ModelRef = { provider: 'dsa', model: 'deepseek-v4' }
    const { gw, sub } = setup({}, { labels: { sub: 'ChatGPT', dsa: 'DeepSeek 账号' } }, gone)
    const out = await gw.complete(ask())
    expect(out.model).toEqual(chatgpt)
    expect(out.source_switch?.message).toBe(
      '你的 DeepSeek 账号登录或 key 失效了，这一轮用了你的 ChatGPT',
    )
    expect(sub.calls).toBe(1)
  })

  it('那一句：同一来源只说一次；来源名缺了说「你自己的 AI」', () => {
    expect(
      sourceChainMessage(
        [
          { label: 'ChatGPT', reason: 'quota' },
          { label: 'ChatGPT', reason: 'quota' },
        ],
        'DeepSeek',
      ),
    ).toBe('你的 ChatGPT 额度用完了，这一轮用了你的 DeepSeek')
    expect(sourceChainMessage([{ label: '你自己的 AI', reason: 'auth' }], undefined)).toBe(
      '你自己的 AI 登录或 key 失效了，这一轮用工坊积分',
    )
  })
})
