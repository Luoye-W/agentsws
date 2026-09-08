import { describe, expect, it } from 'vitest'
import type { ProviderDownPayload } from '../src/index.js'
import {
  createModelGateway,
  isRetryableProviderError,
  ProviderError,
  stubProvider,
} from '../src/index.js'
import { fixedClock, fixedProvider, meta, policy, recorder, userPrompt } from './helpers.js'

const primaryRef = { provider: 'stub', model: 'stub-v1', region: 'cn' as const }
const backupRef = { provider: 'stub', model: 'stub-backup', region: 'cn' as const }
const down = (status: number) =>
  fixedProvider({
    ref: primaryRef,
    fail: () => {
      throw new ProviderError(`provider http ${status}`, { status })
    },
  })

describe('22 §2 路由与降级', () => {
  it('按 purpose 覆盖默认模型', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [
        stubProvider({ seed: 1 }),
        stubProvider({
          seed: 2,
          ref: { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' },
        }),
      ],
      policy: policy({
        by_purpose: { judge: { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' } },
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const run = await gw.complete({ messages: [userPrompt('q')], meta: meta() })
    const judge = await gw.complete({
      messages: [userPrompt('q')],
      meta: meta({ purpose: 'judge' }),
    })
    expect(run.model.model).toBe('stub-v1')
    expect(judge.model.model).toBe('deepseek-chat')
    // 显式 model 优先于策略
    const forced = await gw.complete({
      model: { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' },
      messages: [userPrompt('q')],
      meta: meta(),
    })
    expect(forced.model.model).toBe('deepseek-chat')
  })

  it('provider 5xx → 同档备选；usage 记在实际用的模型上', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [down(503), fixedProvider({ ref: backupRef, input: 10, output: 5 })],
      policy: policy({ fallbacks: { 'stub/stub-v1': [backupRef] } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const out = await gw.complete({ messages: [userPrompt('q')], meta: meta() })
    expect(out.model).toEqual(backupRef)
    expect(rec.ofType('model.provider_down')).toHaveLength(0)
    expect(rec.ofType('model.usage')[0]?.payload).toMatchObject({ model: backupRef })
  })

  it('超时同样降级；`*` 是兜底备选表', async () => {
    const rec = recorder()
    const timeout = fixedProvider({
      ref: primaryRef,
      fail: () => {
        throw new ProviderError('timed out', { timeout: true })
      },
    })
    const gw = createModelGateway({
      providers: [timeout, fixedProvider({ ref: backupRef, output: 1 })],
      policy: policy({ fallbacks: { '*': [backupRef] } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).resolves.toMatchObject(
      {
        model: backupRef,
      },
    )
    expect(isRetryableProviderError(new ProviderError('x', { status: 400 }))).toBe(false)
    expect(isRetryableProviderError(new ProviderError('x', { status: 500 }))).toBe(true)
    expect(isRetryableProviderError('nope')).toBe(false)
  })

  it('无备选 → model.provider_down 事件 + 抛错，且不记账', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [down(500)],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    const evt = rec.ofType('model.provider_down')
    expect(evt).toHaveLength(1)
    const payload = evt[0]?.payload as ProviderDownPayload
    expect(payload.attempts[0]).toMatchObject({ status: 500 })
    expect(rec.ofType('model.usage')).toHaveLength(0)
  })

  it('备选也要过驻留与价格表检查，越线的备选被跳过', async () => {
    const rec = recorder()
    const globalBackup = fixedProvider({
      ref: { provider: 'openai', model: 'gpt-x', region: 'global' },
      output: 1,
    })
    const gw = createModelGateway({
      providers: [down(502), globalBackup],
      policy: policy({
        data_residency: 'cn',
        fallbacks: { 'stub/stub-v1': [{ provider: 'openai', model: 'gpt-x', region: 'global' }] },
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(rec.ofType('model.blocked_residency')).toHaveLength(1)
    expect(rec.ofType('model.provider_down')).toHaveLength(1)
  })

  it('没有注册 provider 或没有价格表 → invalid_input，调用前就拒', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(
      gw.complete({
        model: { provider: 'qwen', model: 'qwen-max', region: 'cn' },
        messages: [userPrompt('q')],
        meta: meta(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const noPrice = createModelGateway({
      providers: [fixedProvider({ ref: { provider: 'stub', model: 'unpriced', region: 'cn' } })],
      policy: policy({ default: { provider: 'stub', model: 'unpriced', region: 'cn' } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(
      noPrice.complete({ messages: [userPrompt('q')], meta: meta() }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(rec.ofType('model.usage')).toHaveLength(0)
  })
})
