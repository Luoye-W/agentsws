/**
 * WP179：不经网关的那一次模型调用补记一笔（官方网页搜索：一次搜索 = 一次完整的 DeepSeek 回合）。
 * 记账口径与 `complete` 相同（进 `records()`、发 `model.usage`），但**不动预算**、`cost_base` 恒 0。
 */
import { describe, expect, it } from 'vitest'
import type { ModelUsagePayload } from '../src/index.js'
import { createModelGateway, stubProvider } from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

describe('WP179 recordExternal', () => {
  it('进账目、发 model.usage、用量按 purpose 看得到；预算一分不动', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 3 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const before = await gw.budget({ workspace_id: 'ws_1' })
    gw.recordExternal?.({
      meta: meta({ purpose: 'web_search', run_id: 'run_web' }),
      model: { provider: 'deepseek-account', model: 'deepseek-v4-flash' },
    })
    const events = rec.ofType('model.usage')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as ModelUsagePayload
    expect(payload).toMatchObject({
      purpose: 'web_search',
      model: { provider: 'deepseek-account', model: 'deepseek-v4-flash' },
      input_tokens: 0,
      output_tokens: 0,
      cost_base: 0,
    })
    expect(gw.records()).toHaveLength(1)
    expect(gw.records()[0]?.purpose).toBe('web_search')
    expect((await gw.usage({ workspace_id: 'ws_1', run_id: 'run_web' })).calls).toBe(1)
    expect(await gw.budget({ workspace_id: 'ws_1' })).toEqual(before)
  })

  it('token 拿得到就记（cost_base 仍是 0：工坊不收这笔钱）', () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 3 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    gw.recordExternal?.({
      meta: meta({ purpose: 'web_search' }),
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      usage: { input_tokens: 900, output_tokens: 120 },
    })
    expect(rec.ofType('model.usage')[0]?.payload).toMatchObject({
      input_tokens: 900,
      output_tokens: 120,
      cost_base: 0,
    })
  })
})
