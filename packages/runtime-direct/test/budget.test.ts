import { describe, expect, it } from 'vitest'
import { CLOSED_TOOL_RESULT } from '../src/index.js'
import { clock, downGateway, eventsOf, harness, makeRequest, types } from './helpers.js'

const LOOP = [
  { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
  { tool_calls: [{ name: 'search_policies', input: {} }] },
  { tool_calls: [{ name: 'list_orders', input: {} }] },
  { text: 'done' },
]

describe('预算是硬的（17 §5.3 §5.6）', () => {
  it('prompt 本身超 max_tokens → 立刻 budget.exhausted，一次模型都不调', async () => {
    const h = harness({ script: LOOP })
    const result = await h.run(
      makeRequest({
        budget: { max_tokens: 10, max_tool_calls: 8, max_seconds: 120, max_cost_base: 5 },
      }),
    )
    expect(result.status).toBe('budget_exhausted')
    expect(eventsOf(h.events, 'budget.exhausted')[0]?.which).toBe('max_tokens')
    expect(types(h.events)).not.toContain('tool.call')
    expect(result.usage.input_tokens).toBe(0)
  })

  it('累计 token 超 max_tokens → 下一轮开始前中断', async () => {
    const h = harness({ script: LOOP })
    const result = await h.run(
      makeRequest({
        budget: { max_tokens: 400, max_tool_calls: 8, max_seconds: 120, max_cost_base: 5 },
      }),
    )
    expect(result.status).toBe('budget_exhausted')
    const exhausted = eventsOf(h.events, 'budget.exhausted')[0]
    expect(exhausted?.which).toBe('max_tokens')
    expect(exhausted?.used).toBeGreaterThan(400)
  })

  it('max_seconds：时钟走过上限 → budget.exhausted{max_seconds}', async () => {
    const c = clock()
    const h = harness({
      clock: c,
      // 每轮让合成时钟走 40 秒
      script: ({ turn }) => {
        c.advance(40_000)
        return turn < 3
          ? { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] }
          : { text: 'done' }
      },
    })
    const result = await h.run(
      makeRequest({
        budget: { max_tokens: 60_000, max_tool_calls: 8, max_seconds: 60, max_cost_base: 5 },
      }),
    )
    expect(result.status).toBe('budget_exhausted')
    expect(eventsOf(h.events, 'budget.exhausted')[0]?.which).toBe('max_seconds')
    expect(result.usage.seconds).toBeGreaterThanOrEqual(60)
  })

  it('AbortSignal → run.cancelled，未闭合调用补齐，产物已 stage 的保留', async () => {
    const controller = new AbortController()
    const h = harness({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { tool_calls: [{ name: 'stage_refund', input: { order_id: 'ord_1001' } }] },
        { tool_calls: [{ name: 'search_policies', input: {} }] },
        { text: 'never' },
      ],
      stageResult: () => {
        controller.abort()
        return { change_id: 'chg_1' }
      },
    })
    const result = await h.run(makeRequest({ grounding: [] }), controller.signal)
    expect(result.status).toBe('cancelled')
    expect(types(h.events)).toContain('run.cancelled')
    expect(types(h.events)).not.toContain('run.completed')
    // 已经 stage 的保留（17 §5.3）
    expect(result.outputs).toEqual([{ kind: 'staged_change', change_id: 'chg_1' }])
    const calls = eventsOf(h.events, 'tool.call').map((e) => e.call_id)
    const results = eventsOf(h.events, 'tool.result').map((e) => e.call_id)
    expect(new Set(results)).toEqual(new Set(calls))
  })

  it('开跑前就被中断 → run.cancelled，什么都不做', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness({ script: LOOP })
    const result = await h.run(makeRequest(), controller.signal)
    expect(result.status).toBe('cancelled')
    expect(types(h.events)).toEqual(['run.started', 'run.cancelled'])
  })

  it('模型挂了 → run.failed{provider_unavailable}，没有任何产物', async () => {
    const c = clock()
    const h = harness({ script: LOOP, clock: c, gateway: downGateway(c) })
    const result = await h.run()
    expect(result.status).toBe('failed')
    const failed = eventsOf(h.events, 'run.failed')[0]
    expect(failed?.error.code).toBe('provider_unavailable')
    expect(failed?.error.retryable).toBe(true)
    expect(result.outputs).toEqual([])
    expect(h.drafts).toEqual([])
    expect(types(h.events)).not.toContain('run.completed')
  })

  it('turn 上限：到顶就收尾，未闭合调用补齐', async () => {
    const h = harness({
      script: () => ({ tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] }),
      maxTurns: 2,
    })
    const result = await h.run(makeRequest({ grounding: [] }))
    expect(result.status).toBe('completed')
    expect(eventsOf(h.events, 'tool.call')).toHaveLength(2)
    expect(eventsOf(h.events, 'tool.result')).toHaveLength(2)
  })

  it('close_open_tool_uses 的占位文本自带原因', () => {
    expect(CLOSED_TOOL_RESULT('budget_exhausted')).toContain('budget_exhausted')
  })
})
