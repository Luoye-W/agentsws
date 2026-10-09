import { describe, expect, it } from 'vitest'
import { createModelGateway, stubProvider } from '../src/index.js'
import { fixedClock, fixedProvider, meta, policy, recorder, userPrompt } from './helpers.js'

const globalProvider = fixedProvider({
  ref: { provider: 'openai', model: 'gpt-x', region: 'global' },
  input: 10,
  output: 10,
})
const cloudBrain = fixedProvider({
  ref: { provider: 'cloud_brain', model: 'stub-v1', region: 'cn' },
  input: 10,
  output: 10,
})

describe('22 §5.3 data_residency: cn 拦截 global provider', () => {
  it('请求 region=global 的 provider → 拒绝、发事件、不产生 usage', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 }), globalProvider],
      policy: policy({ data_residency: 'cn' }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(
      gw.complete({
        model: { provider: 'openai', model: 'gpt-x', region: 'global' },
        messages: [userPrompt('hi')],
        meta: meta(),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    const blocked = rec.ofType('model.blocked_residency')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.payload).toMatchObject({
      reason: 'region_global',
      data_residency: 'cn',
      model: { provider: 'openai', model: 'gpt-x', region: 'global' },
    })
    expect(rec.ofType('model.usage')).toHaveLength(0)
    expect((await gw.usage({ workspace_id: 'ws_1' })).calls).toBe(0)
  })

  it('provider 自身 region=global 也算出境（ModelRef 没写 region 时看 provider）', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [globalProvider],
      policy: policy({ data_residency: 'cn', default: { provider: 'openai', model: 'gpt-x' } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('hi')], meta: meta() })).rejects.toMatchObject(
      {
        code: 'forbidden',
      },
    )
    expect(rec.ofType('model.blocked_residency')).toHaveLength(1)
  })

  it('data_residency: any 放行 global', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [globalProvider],
      policy: policy({ data_residency: 'any', default: { provider: 'openai', model: 'gpt-x' } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const out = await gw.complete({ messages: [userPrompt('hi')], meta: meta() })
    expect(out.model.provider).toBe('openai')
    expect(rec.ofType('model.blocked_residency')).toHaveLength(0)
  })

  it('eu_customer_to_cloud_brain: deny 拦截欧洲客户数据发往 cloud_brain（默认即 deny）', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [cloudBrain],
      policy: policy({ default: { provider: 'cloud_brain', model: 'stub-v1', region: 'cn' } }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(
      gw.complete({ messages: [userPrompt('hi')], meta: meta(), eu_customer: true }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(rec.ofType('model.blocked_residency')[0]?.payload).toMatchObject({
      reason: 'eu_customer_to_cloud_brain',
    })
    const allowed = createModelGateway({
      providers: [cloudBrain],
      policy: policy({
        default: { provider: 'cloud_brain', model: 'stub-v1', region: 'cn' },
        eu_customer_to_cloud_brain: 'allow',
      }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(
      allowed.complete({ messages: [userPrompt('hi')], meta: meta(), eu_customer: true }),
    ).resolves.toMatchObject({ text: 'fixed' })
  })
})
