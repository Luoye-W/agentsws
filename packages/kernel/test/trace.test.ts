import { describe, expect, it } from 'vitest'
import {
  collect,
  FixedClock,
  KernelTrace,
  rootOf,
  SqliteEventLog,
  sameTrace,
  seededRandom,
} from '../src/index.js'

function fixtures() {
  const eventLog = new SqliteEventLog({
    clock: new FixedClock('2026-09-08T09:00:00.000Z'),
    random: seededRandom(1),
  })
  return { eventLog, trace: new KernelTrace({ random: seededRandom(2), eventLog }) }
}

describe('KernelTrace（28 §1 trace_id 贯穿）', () => {
  it('newTraceId 是 32 位 hex，注入随机 → 确定性', () => {
    const a = fixtures().trace.newTraceId()
    const b = fixtures().trace.newTraceId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).toBe(b)
  })

  it('child 保留 root 段，多层派生不丢 root', () => {
    const { trace } = fixtures()
    const root = trace.newTraceId()
    const child = trace.child(root)
    const grandchild = trace.child(child)
    expect(child).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/)
    expect(rootOf(grandchild)).toBe(root)
    expect(sameTrace(root, grandchild)).toBe(true)
    expect(sameTrace(root, trace.newTraceId())).toBe(false)
    expect(trace.child(root)).not.toBe(child)
  })

  it('child 拒绝空 parent', () => {
    const { trace } = fixtures()
    expect(() => trace.child('')).toThrow(/non-empty parent trace id/)
  })

  it('spanEvent 把一条 span 写进事件日志，缺省补 trace_id 与 system actor', async () => {
    const { eventLog, trace } = fixtures()
    const root = trace.newTraceId()
    const written = await trace.spanEvent({
      workspace_id: 'ws_1',
      type: 'tool.call',
      trace_id: trace.child(root),
      run_id: 'run_1',
      work_item_id: 'wi_1',
      change_id: 'ch_1',
      execution_id: 'ex_1',
      subject: { type: 'order', id: 'ord_1' },
      actor: { kind: 'agent', id: 'agent_1', run_id: 'run_1' },
      payload: { tool: 'shopify.refund' },
    })
    const auto = await trace.spanEvent({ workspace_id: 'ws_1', type: 'ui', payload: null })

    expect(rootOf(written.correlation.trace_id)).toBe(root)
    expect(written.correlation).toMatchObject({
      run_id: 'run_1',
      work_item_id: 'wi_1',
      change_id: 'ch_1',
      execution_id: 'ex_1',
    })
    expect(auto.actor).toEqual({ kind: 'system', id: 'kernel' })
    expect(auto.correlation.trace_id).toMatch(/^[0-9a-f]{32}$/)

    const stored = await collect(eventLog.read({ workspace_id: 'ws_1' }))
    expect(stored.map((e) => e.type)).toEqual(['tool.call', 'ui'])
    expect(stored[0]).toEqual(written)
  })

  it('越界随机源被拒', () => {
    const { eventLog } = fixtures()
    const trace = new KernelTrace({ random: () => -1, eventLog })
    expect(() => trace.newTraceId()).toThrow(/\[0, 1\)/)
  })
})
