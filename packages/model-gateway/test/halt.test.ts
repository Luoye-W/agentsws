import type { Halt, HaltScope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createModelGateway, stubProvider } from '../src/index.js'
import { fixedClock, meta, policy, recorder, userPrompt } from './helpers.js'

const makeHalt = (): Halt => {
  const state: Record<HaltScope, { on: boolean; reason?: string }> = {
    all: { on: false },
    model: { on: false },
    outbound: { on: false },
    learning: { on: false },
  }
  return {
    isHalted: (scope) => state[scope].on,
    set: (scope, on, reason) => {
      state[scope] = reason === undefined ? { on } : { on, reason }
    },
    state: () => state,
  }
}

describe('22 §3 急停', () => {
  it('AGENTSWS_MODEL_HALT=1 时所有调用抛 halted', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: { AGENTSWS_MODEL_HALT: '1' },
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).rejects.toMatchObject({
      code: 'halted',
      details: { by: 'env', scope: 'model' },
    })
    await expect(gw.embed(['q'], meta({ purpose: 'embedding' }))).rejects.toMatchObject({
      code: 'halted',
    })
    expect(rec.events).toHaveLength(0)
  })

  it('注入的 halt.isHalted("model") 同样生效，且可解除', async () => {
    const rec = recorder()
    const halt = makeHalt()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      halt,
      env: {},
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).resolves.toBeTruthy()
    halt.set('model', true, 'incident')
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).rejects.toMatchObject({
      code: 'halted',
      details: { by: 'halt' },
    })
    halt.set('model', false)
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).resolves.toBeTruthy()
    expect(rec.ofType('model.usage')).toHaveLength(2)
  })

  it('其他 scope 的急停不拦模型调用', async () => {
    const rec = recorder()
    const halt = makeHalt()
    halt.set('outbound', true)
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      halt,
      env: { AGENTSWS_MODEL_HALT: '0' },
    })
    await expect(gw.complete({ messages: [userPrompt('q')], meta: meta() })).resolves.toBeTruthy()
  })
})
