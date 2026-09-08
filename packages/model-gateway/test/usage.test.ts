import { describe, expect, it } from 'vitest'
import type { ModelUsagePayload } from '../src/index.js'
import { costOf, createModelGateway, priceFor, stubProvider } from '../src/index.js'
import { fixedClock, meta, policy, prices, recorder, systemPrompt, userPrompt } from './helpers.js'

const roles = ['role_aftersales', 'role_marketing', 'role_ops']

describe('22 §5.5 usage 报表与事件求和一致', () => {
  it('按 role / assignment / run 汇总都等于 model.usage 事件求和', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 3 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    for (const [i, role_id] of roles.entries()) {
      for (let n = 0; n < 3; n += 1) {
        await gw.complete({
          messages: [systemPrompt(`persona ${role_id}`), userPrompt(`question ${n}`)],
          meta: meta({ role_id, assignment_id: `asg_${i}`, run_id: `run_${i}_${n}` }),
        })
      }
    }
    const events = rec.ofType('model.usage')
    expect(events).toHaveLength(9)
    const sum = (rows: ModelUsagePayload[]) =>
      rows.reduce(
        (a, p) => ({
          input_tokens: a.input_tokens + p.input_tokens,
          output_tokens: a.output_tokens + p.output_tokens,
          cached_tokens: a.cached_tokens + p.cached_tokens,
          cost_base: a.cost_base + p.cost_base,
          calls: a.calls + 1,
        }),
        { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0, calls: 0 },
      )
    const payloads = events.map((e) => e.payload as ModelUsagePayload)
    for (const role_id of roles) {
      const report = await gw.usage({ workspace_id: 'ws_1', role_id })
      expect(report).toEqual(sum(payloads.filter((p) => p.role_id === role_id)))
      expect(report.calls).toBe(3)
    }
    expect(await gw.usage({ workspace_id: 'ws_1' })).toEqual(sum(payloads))
    expect(await gw.usage({ workspace_id: 'ws_1', assignment_id: 'asg_1' })).toEqual(
      sum(payloads.filter((p) => p.assignment_id === 'asg_1')),
    )
    expect((await gw.usage({ workspace_id: 'ws_1', run_id: 'run_0_0' })).calls).toBe(1)
    expect((await gw.usage({ workspace_id: 'ws_other' })).calls).toBe(0)
    expect(gw.records()).toHaveLength(9)
  })

  it('cost_base 按价格表换算（未命中缓存按 in、命中按 cached、输出按 out）', () => {
    const price = priceFor(prices, { provider: 'stub', model: 'stub-v1' })
    expect(
      costOf(price, { input_tokens: 1_000, output_tokens: 500, cached_tokens: 400 }),
    ).toBeCloseTo((600 * 1_000 + 400 * 100 + 500 * 2_000) / 1_000_000, 12)
    expect(() => priceFor(prices, { provider: 'nope', model: 'x' })).toThrow(/price table/)
  })

  it('since 过滤按事件时间', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 3 })],
      policy: policy(),
      clock: fixedClock('2026-09-09T10:00:00Z'),
      eventSink: rec.sink,
      env: {},
    })
    await gw.complete({ messages: [userPrompt('q')], meta: meta() })
    expect((await gw.usage({ workspace_id: 'ws_1', since: '2026-09-09T09:00:00Z' })).calls).toBe(1)
    expect((await gw.usage({ workspace_id: 'ws_1', since: '2026-09-09T11:00:00Z' })).calls).toBe(0)
  })

  it('embed 走 provider.embed 并同样记账；provider 不支持则 invalid_input', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [
        stubProvider({ seed: 3, ref: { provider: 'stub', model: 'stub-v1', region: 'cn' } }),
      ],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    const out = await gw.embed(['hello', 'world'], meta({ purpose: 'embedding' }))
    expect(out.vectors).toHaveLength(2)
    expect(out.vectors[0]).toHaveLength(8)
    expect(out.usage.cost_base).toBeGreaterThan(0)
    expect(rec.ofType('model.usage')).toHaveLength(1)
    expect((await gw.usage({ workspace_id: 'ws_1' })).cost_base).toBeCloseTo(
      out.usage.cost_base,
      12,
    )

    const noEmbed = createModelGateway({
      providers: [
        {
          ref: { provider: 'stub', model: 'stub-v1', region: 'cn' },
          complete: async () => ({
            text: '',
            usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 },
          }),
        },
      ],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await expect(noEmbed.embed(['x'], meta({ purpose: 'embedding' }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})
