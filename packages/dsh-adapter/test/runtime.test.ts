/**
 * 事件映射（17 §2）、预算（17 §5.3）、无状态（17 §5.1）。
 */
import { assemblePromptHash, contextItemHash } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { createDshRuntime } from '../src/index.js'
import { baseOptions, collect, makeRequest, recorder, typesOf } from './helpers.js'

const NO_ABORT = (): AbortSignal => new AbortController().signal

describe('dsh 运行时：事件映射', () => {
  it('发全套 17 §2 事件，顺序是 started → context.injected* → prompt.assembled → …', async () => {
    const rec = recorder()
    const runtime = createDshRuntime(
      baseOptions({ stage: rec.stage, createDraft: rec.createDraft }),
    )
    const { sink, events } = collect()
    const req = makeRequest()
    const result = await runtime.run(req, sink, NO_ABORT())

    const types = typesOf(events)
    expect(types[0]).toBe('run.started')
    const injected = events.filter((e) => e.type === 'context.injected')
    expect(injected).toHaveLength(req.context.length)
    expect(types.indexOf('prompt.assembled')).toBeGreaterThan(types.lastIndexOf('context.injected'))
    expect(types).toContain('text.delta')
    expect(types).toContain('tool.call')
    expect(types).toContain('tool.result')
    expect(types).toContain('change.staged')
    expect(types).toContain('proposal.created')
    expect(types.at(-1)).toBe('run.completed')
    expect(result.status).toBe('completed')
    expect(result.session_ref.runtime).toBe('dsh')
  })

  it('prompt.assembled 的哈希与回放重组一致（17 §6.1 铁律）', async () => {
    const runtime = createDshRuntime(baseOptions())
    const { sink, events } = collect()
    const req = makeRequest()
    await runtime.run(req, sink, NO_ABORT())

    const assembled = events.find((e) => e.type === 'prompt.assembled')
    expect(assembled?.type === 'prompt.assembled' && assembled.hash).toBe(assemblePromptHash(req))

    const injected = events.filter((e) => e.type === 'context.injected')
    injected.forEach((e, i) => {
      const contextItem = req.context[i]
      expect(contextItem).toBeDefined()
      if (contextItem === undefined || e.type !== 'context.injected') return
      expect(e.item_id).toBe(contextItem.id)
      expect(e.hash).toBe(contextItemHash(contextItem))
    })
  })

  it('每一次工具调用都恰好闭合一条 tool.result', async () => {
    const runtime = createDshRuntime(baseOptions())
    const { sink, events } = collect()
    await runtime.run(makeRequest(), sink, NO_ABORT())
    const calls = events.filter((e) => e.type === 'tool.call')
    const results = events.filter((e) => e.type === 'tool.result')
    expect(results).toHaveLength(calls.length)
    const callIds = calls.flatMap((e) => (e.type === 'tool.call' ? [e.call_id] : []))
    const resultIds = results.flatMap((e) => (e.type === 'tool.result' ? [e.call_id] : []))
    expect(new Set(resultIds)).toEqual(new Set(callIds))
  })

  it('产物进 RunResult，provenance 含读过的订单', async () => {
    const rec = recorder()
    const runtime = createDshRuntime(
      baseOptions({ stage: rec.stage, createDraft: rec.createDraft }),
    )
    const { sink } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())
    expect(result.outputs.map((o) => o.kind).sort()).toEqual(['draft', 'staged_change'])
    expect(result.provenance.seen.order).toContain('ord_1001')
    expect(rec.staged).toHaveLength(1)
    expect(rec.staged[0]?.kind).toBe('refund')
    expect(rec.drafts[0]?.body).toContain('14 days')
    expect(rec.drafts[0]?.child_change_ids).toEqual(['chg_1'])
  })
})

describe('dsh 运行时：预算是硬的', () => {
  it('max_tool_calls 用尽 → budget.exhausted 并补齐未闭合的调用（17 §6.4）', async () => {
    const runtime = createDshRuntime(baseOptions())
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest({ max_tool_calls: 1 }), sink, NO_ABORT())

    const exhausted = events.find((e) => e.type === 'budget.exhausted')
    expect(exhausted?.type === 'budget.exhausted' && exhausted.which).toBe('max_tool_calls')
    const calls = events.filter((e) => e.type === 'tool.call')
    const results = events.filter((e) => e.type === 'tool.result')
    expect(results).toHaveLength(calls.length)
    const last = results.at(-1)
    expect(last?.type === 'tool.result' && last.status).toBe('blocked')
    expect(last?.type === 'tool.result' && last.reason).toBe('budget_exhausted')
    expect(result.status).toBe('budget_exhausted')
    // 预算耗尽后不再起草、不再 stage
    expect(result.outputs).toHaveLength(0)
  })

  it('max_tokens 超了就在装配后立刻停', async () => {
    const runtime = createDshRuntime(baseOptions())
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest({ max_tokens: 1 }), sink, NO_ABORT())
    const exhausted = events.find((e) => e.type === 'budget.exhausted')
    expect(exhausted?.type === 'budget.exhausted' && exhausted.which).toBe('max_tokens')
    expect(result.status).toBe('budget_exhausted')
    expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(0)
  })

  it('AbortSignal 已中断 → run.cancelled', async () => {
    const runtime = createDshRuntime(baseOptions())
    const { sink, events } = collect()
    const ac = new AbortController()
    ac.abort()
    const result = await runtime.run(makeRequest(), sink, ac.signal)
    expect(typesOf(events)).toContain('run.cancelled')
    expect(result.status).toBe('cancelled')
  })
})

describe('dsh 运行时：无状态（17 §5.1）', () => {
  it('两次运行互不可见：会话不同、上下文事件只属于自己那次', async () => {
    const runtime = createDshRuntime(baseOptions())
    const first = collect()
    const second = collect()
    const a = makeRequest({ id: 'run_a' })
    const b = makeRequest({ id: 'run_b' })
    const ra = await runtime.run(a, first.sink, NO_ABORT())
    const rb = await runtime.run(b, second.sink, NO_ABORT())

    expect(ra.session_ref.session_id).not.toBe(rb.session_ref.session_id)
    const idsOf = (events: typeof first.events): string[] =>
      events.flatMap((e) => (e.type === 'context.injected' ? [e.item_id] : []))
    expect(idsOf(second.events)).toEqual(b.context.map((c) => c.id))
    expect(idsOf(second.events)).toHaveLength(b.context.length)
    // 第二次运行的 provenance 里没有第一次的痕迹之外的东西
    expect(rb.provenance.run_id).toBe('run_b')
  })

  it('capabilities 是实测值', () => {
    const runtime = createDshRuntime(baseOptions())
    expect(runtime.capabilities()).toEqual({
      tool_choice: false,
      streaming: true,
      followup: false,
      seedable: true,
    })
  })

  it('health 报告 dsh SDK 可解析', async () => {
    const runtime = createDshRuntime(baseOptions())
    const health = await runtime.health()
    expect(health.ok).toBe(true)
  })
})
