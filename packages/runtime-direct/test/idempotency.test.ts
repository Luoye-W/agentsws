import type { RunResult } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { IDEMPOTENCY_WINDOW_MS, IdempotencyStore } from '../src/index.js'
import { clock, harness, makeRequest } from './helpers.js'

const SCRIPT = [
  { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
  {
    tool_calls: [
      {
        name: 'draft_reply',
        input: { to: ['anna@example.com'], subject: 'Re: #1001', body: 'ok' },
      },
    ],
  },
  { text: 'done' },
]

const fakeResult = (id: string): RunResult => ({
  request_id: id,
  status: 'completed',
  outputs: [],
  provenance: { run_id: id, seen: {}, read_full: [], recorded_at: '2026-09-07T09:00:00.000Z' },
  memory_candidates: [],
  lessons: [],
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    tool_calls: 0,
    seconds: 0,
    cost_base: 0,
  },
  session_ref: { runtime: 'direct-llm', session_id: 's' },
  summary: '',
})

describe('幂等（17 §5.7）', () => {
  it('内存表：窗口内命中，窗口外淘汰', () => {
    const c = clock()
    const store = new IdempotencyStore(c)
    store.put('k', fakeResult('run_1'))
    expect(store.get('k')?.request_id).toBe('run_1')
    expect(store.size).toBe(1)

    c.advance(IDEMPOTENCY_WINDOW_MS - 1)
    expect(store.get('k')?.request_id).toBe('run_1')

    c.advance(2)
    expect(store.get('k')).toBeUndefined()
    expect(store.size).toBe(0)
    expect(store.get('nope')).toBeUndefined()
  })

  it('同 idempotency_key 24h 内返回原 RunResult，不重跑不重发事件', async () => {
    const h = harness({ script: SCRIPT })
    const first = await h.run(makeRequest({ id: 'run_1' }))
    const eventsAfterFirst = h.events.length
    const drafts = h.drafts.length

    const again = await h.run(makeRequest({ id: 'run_2' }))
    expect(again).toBe(first)
    expect(again.request_id).toBe('run_1')
    expect(h.events).toHaveLength(eventsAfterFirst)
    expect(h.drafts).toHaveLength(drafts)
  })

  it('换一把钥匙就重新跑', async () => {
    const h = harness({ script: SCRIPT })
    await h.run(makeRequest({ id: 'run_1', idempotency_key: 'k1' }))
    const before = h.events.length
    const second = await h.run(makeRequest({ id: 'run_2', idempotency_key: 'k2' }))
    expect(second.request_id).toBe('run_2')
    expect(h.events.length).toBeGreaterThan(before)
  })

  it('过了 24h 同一把钥匙重新跑', async () => {
    const c = clock()
    const h = harness({ script: SCRIPT, clock: c, idempotencyWindowMs: 1000 })
    const first = await h.run(makeRequest({ id: 'run_1' }))
    c.advance(1001)
    const second = await h.run(makeRequest({ id: 'run_2' }))
    expect(second).not.toBe(first)
    expect(second.request_id).toBe('run_2')
  })
})
