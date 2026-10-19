import type { ModelProvider, ModelRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { SourceFallbackPolicy } from '../src/index.js'
import {
  createModelGateway,
  GatewayError,
  ProviderError,
  sourceFallbackOffOf,
  sourceSwitchReasonOf,
} from '../src/index.js'
import { fixedClock, meta, policy, prices, recorder, userPrompt } from './helpers.js'

const own: ModelRef = { provider: 'own', model: 'gpt-5', region: 'global' }
const cloud: ModelRef = { provider: 'cloud', model: 'deepseek-v4-flash', region: 'cn' }

/** 主用那一条：按剧本一次一次地回（`ok` 成功、别的抛对应的错）。 */
const scripted = (ref: ModelRef, script: (() => void)[]): ModelProvider & { calls: number } => {
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

const ok = (): void => {}
const http = (status: number) => (): void => {
  throw new ProviderError(`provider http ${status}`, { status })
}
const rateLimited = (): void => {
  throw new GatewayError('rate_limited', 'ChatGPT 订阅这一阵的额度用满了', {
    subscription: 'rate_limited',
  })
}
const netDown = (): void => {
  throw new ProviderError('request failed: ECONNREFUSED', { code: 'ECONNREFUSED' })
}

const fallback = (over: Partial<SourceFallbackPolicy> = {}): SourceFallbackPolicy => ({
  to: cloud,
  enabled: true,
  labels: { own: 'ChatGPT' },
  ...over,
})

const gatewayWith = (primary: ModelProvider, fb: SourceFallbackPolicy | undefined) => {
  const rec = recorder()
  const cloudProvider = scripted(cloud, [ok])
  const gw = createModelGateway({
    providers: [primary, cloudProvider],
    policy: policy({
      default: own,
      prices: {
        ...prices,
        'own/gpt-5': { in: 0, out: 0, cached: 0 },
        'cloud/deepseek-v4-flash': { in: 1, out: 1, cached: 0 },
      },
      ...(fb === undefined ? {} : { source_fallback: fb }),
    }),
    clock: fixedClock(),
    eventSink: rec.sink,
    env: {},
  })
  return { gw, rec, cloudProvider }
}

const ask = (run_id = 'run_1') => ({ messages: [userPrompt('q')], meta: meta({ run_id }) })

describe('WP425 自己的 AI 优先，用不了再用工坊积分', () => {
  it.each([
    ['额度用完（订阅限额）', rateLimited, 'quota', '你的 ChatGPT 额度用完了，这一轮用工坊积分'],
    ['额度用完（429）', http(429), 'quota', '你的 ChatGPT 额度用完了，这一轮用工坊积分'],
    ['连不上（5xx）', http(503), 'unreachable', '你的 ChatGPT 连不上，这一轮用工坊积分'],
    ['连不上（网络）', netDown, 'unreachable', '你的 ChatGPT 连不上，这一轮用工坊积分'],
    ['key 失效（401）', http(401), 'auth', '你的 ChatGPT 登录或 key 失效了，这一轮用工坊积分'],
    ['key 失效（403）', http(403), 'auth', '你的 ChatGPT 登录或 key 失效了，这一轮用工坊积分'],
  ])('%s → 这一轮切到工坊积分，照实说原因', async (_name, fail, reason, message) => {
    const { gw, rec } = gatewayWith(scripted(own, [fail]), fallback())
    const out = await gw.complete(ask())
    expect(out.model).toEqual(cloud)
    expect(out.text).toBe('from cloud')
    expect(out.source_switch).toEqual({ from: own, to: cloud, reason, message, target: 'workshop' })
    // 运行记录里那一条（只有模型、原因与那句话）
    const switched = rec.ofType('model.source_switched')
    expect(switched).toHaveLength(1)
    expect(switched[0]?.payload).toEqual({
      from: own,
      to: cloud,
      reason,
      message,
      target: 'workshop',
    })
    expect(switched[0]?.correlation.run_id).toBe('run_1')
    // 用量记在实际用的那一条上
    expect(rec.ofType('model.usage').at(-1)?.payload).toMatchObject({ model: cloud })
  })

  it('一轮里切过一次就用到底：同一轮后面的补全直接走工坊积分、不再试主用、不再带切换', async () => {
    const primary = scripted(own, [http(429), ok])
    const { gw, rec, cloudProvider } = gatewayWith(primary, fallback())
    const first = await gw.complete(ask('run_a'))
    expect(first.source_switch?.reason).toBe('quota')
    // 主用其实已经恢复了，但同一轮不来回切
    const second = await gw.complete(ask('run_a'))
    expect(second.model).toEqual(cloud)
    expect(second.source_switch).toBeUndefined()
    expect(primary.calls).toBe(1)
    expect(cloudProvider.calls).toBe(2)
    expect(rec.ofType('model.source_switched')).toHaveLength(1)
  })

  it('下一轮自动回到主用（不用人点）', async () => {
    const primary = scripted(own, [http(429), ok])
    const { gw } = gatewayWith(primary, fallback())
    const first = await gw.complete(ask('run_a'))
    expect(first.model).toEqual(cloud)
    const next = await gw.complete(ask('run_b'))
    expect(next.model).toEqual(own)
    expect(next.source_switch).toBeUndefined()
    expect(primary.calls).toBe(2)
  })

  it('开关关着：不切、照实停下，错误带上「关着」那一格（界面据此出一键卡）', async () => {
    const primary = scripted(own, [rateLimited])
    const { gw, rec, cloudProvider } = gatewayWith(primary, fallback({ enabled: false }))
    const err = await gw.complete(ask()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    // 原来的错码照旧（老的「重新登录 / 额度用满」卡片逻辑照认）
    expect((err as GatewayError).code).toBe('rate_limited')
    expect((err as GatewayError).message).toBe(
      '你的 ChatGPT 额度用完了。「自己的用不了时用工坊积分接着做」关着，这一轮先停下',
    )
    expect(sourceFallbackOffOf(err)).toEqual({
      state: 'off',
      reason: 'quota',
      from: 'own/gpt-5',
      label: 'ChatGPT',
    })
    expect(((err as GatewayError).details as { subscription?: string }).subscription).toBe(
      'rate_limited',
    )
    expect(cloudProvider.calls).toBe(0)
    expect(rec.ofType('model.source_switched')).toHaveLength(0)
  })

  it('没登录工坊账号（没有备用）：老样子，原样报错', async () => {
    const { gw } = gatewayWith(scripted(own, [http(429)]), undefined)
    const err = await gw.complete(ask()).catch((e: unknown) => e)
    expect((err as GatewayError).code).toBe('provider_unavailable')
    expect(sourceFallbackOffOf(err)).toBeUndefined()
  })

  it('不该切的：请求本身不对（400）、主用就是工坊积分、设置页「测试」那一次', async () => {
    const bad = gatewayWith(scripted(own, [http(400)]), fallback())
    await expect(bad.gw.complete(ask())).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(bad.cloudProvider.calls).toBe(0)

    const probe = gatewayWith(scripted(own, [http(429)]), fallback())
    await expect(probe.gw.complete({ ...ask(), capability_probe: true })).rejects.toBeTruthy()
    expect(probe.cloudProvider.calls).toBe(0)

    const rec = recorder()
    const cloudDown = scripted(cloud, [http(503)])
    const gw = createModelGateway({
      providers: [scripted(own, [ok]), cloudDown],
      policy: policy({
        default: cloud,
        prices: { ...prices, 'cloud/deepseek-v4-flash': { in: 1, out: 1, cached: 0 } },
        source_fallback: fallback(),
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete(ask())).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(rec.ofType('model.source_switched')).toHaveLength(0)
  })

  it('已经往外吐过字的不切（换一家从头说会把两段拼在一起）', async () => {
    const streaming: ModelProvider = {
      ref: own,
      async complete(req) {
        req.on_delta?.('前半段')
        throw new ProviderError('stream cut', { status: 502 })
      },
    }
    const { gw, cloudProvider } = gatewayWith(streaming, fallback())
    await expect(gw.complete({ ...ask(), on_delta: () => {} })).rejects.toBeTruthy()
    expect(cloudProvider.calls).toBe(0)
  })

  it('原因归类：三种原因之外的一律不算', () => {
    expect(sourceSwitchReasonOf(new GatewayError('unauthenticated', 'x'))).toBe('auth')
    expect(
      sourceSwitchReasonOf(
        new GatewayError('provider_error', 'DeepSeek 余额不足', { reason: 'quota' }),
      ),
    ).toBe('quota')
    expect(sourceSwitchReasonOf(new GatewayError('budget_exhausted', 'x'))).toBeUndefined()
    expect(sourceSwitchReasonOf(new GatewayError('invalid_input', 'x'))).toBeUndefined()
    expect(sourceSwitchReasonOf(new GatewayError('halted', 'x'))).toBeUndefined()
    expect(sourceSwitchReasonOf(new ProviderError('timed out', { timeout: true }))).toBe(
      'unreachable',
    )
  })

  it('没给来源名：说「你自己的 AI」', async () => {
    const { gw } = gatewayWith(scripted(own, [http(429)]), fallback({ labels: {} }))
    const out = await gw.complete(ask())
    expect(out.source_switch?.message).toBe('你自己的 AI 额度用完了，这一轮用工坊积分')
  })
})
