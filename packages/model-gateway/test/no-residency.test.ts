/**
 * 决策 291（WP281）：「数据不出境」整套删了——网关不再按驻留拦任何一家。
 * 老策略里还带着 `data_residency` 的（存量工作区读出来的）也照常放行，不报错。
 */
import { describe, expect, it } from 'vitest'
import type { ModelGatewayPolicy } from '../src/index.js'
import { createModelGateway, stubProvider } from '../src/index.js'
import { fixedClock, fixedProvider, meta, policy, recorder, userPrompt } from './helpers.js'

const globalProvider = fixedProvider({
  ref: { provider: 'openai', model: 'gpt-x', region: 'global' },
  input: 10,
  output: 10,
})

describe('决策 291：不按驻留拦', () => {
  it('region=global 的 provider 照常调用、照常记账，没有拦截事件', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 }), globalProvider],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const out = await gw.complete({
      model: { provider: 'openai', model: 'gpt-x', region: 'global' },
      messages: [userPrompt('hi')],
      meta: meta(),
    })
    expect(out.model.provider).toBe('openai')
    expect(rec.ofType('model.usage')).toHaveLength(1)
    expect(rec.events.some((e) => e.type.includes('residency'))).toBe(false)
  })

  it('老策略里残留的 data_residency: cn 被忽略（不报错、不拦）', async () => {
    const rec = recorder()
    const legacy = {
      ...policy({ default: { provider: 'openai', model: 'gpt-x' } }),
      data_residency: 'cn',
    } as ModelGatewayPolicy
    const gw = createModelGateway({
      providers: [globalProvider],
      policy: legacy,
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('hi')], meta: meta() })).resolves.toMatchObject(
      { text: 'fixed' },
    )
  })
})
