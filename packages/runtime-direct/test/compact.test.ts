import type { ChatMessage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { COMPACT_PLACEHOLDER, compactHistory, historyTokens } from '../src/index.js'
import { eventsOf, harness, makeRequest } from './helpers.js'

const big = (n: number): string => 'x'.repeat(n)

describe('compact_history（Commerce Agents A9）', () => {
  it('把最早的 tool 结果换成占位，直到回到阈值以下', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prefix' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'calling' },
      { role: 'tool', name: 'a', tool_call_id: 'c1', content: big(2000) },
      { role: 'assistant', content: 'calling' },
      { role: 'tool', name: 'b', tool_call_id: 'c2', content: big(2000) },
    ]
    const limit = 300
    expect(historyTokens(messages, [])).toBeGreaterThan(limit)
    const out = compactHistory(messages, [], limit)
    expect(out.compacted).toBe(2)
    expect(out.messages[3]?.content).toBe(COMPACT_PLACEHOLDER)
    expect(out.messages[5]?.content).toBe(COMPACT_PLACEHOLDER)
    // system / user / assistant 一个都没动
    expect(out.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role))
    expect(out.messages[0]?.content).toBe('prefix')
    expect(out.messages[1]?.content).toBe('question')
  })

  it('先换最早的那条：只需要压一条时后面的原样留着', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', name: 'a', tool_call_id: 'c1', content: big(4000) },
      { role: 'tool', name: 'b', tool_call_id: 'c2', content: 'small' },
    ]
    const out = compactHistory(messages, [], 100)
    expect(out.compacted).toBe(1)
    expect(out.messages[0]?.content).toBe(COMPACT_PLACEHOLDER)
    expect(out.messages[1]?.content).toBe('small')
  })

  it('没有可压的工具结果就停手，不进死循环', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: big(4000) }]
    const out = compactHistory(messages, [], 10)
    expect(out.compacted).toBe(0)
    expect(out.messages).toEqual(messages)
  })

  it('运行里：超阈值 → progress{step:"compact"}，占位进历史', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { tool_calls: [{ name: 'list_orders', input: {} }] },
        { text: 'done' },
      ],
      compactThresholdTokens: 200,
    })
    await h.run(makeRequest({ grounding: [] }))
    const compact = eventsOf(h.events, 'progress').filter((e) => e.step === 'compact')
    expect(compact.length).toBeGreaterThan(0)
    expect(compact[0]?.note).toContain('compact_history')
  })

  it('阈值够大就不压，也不发事件', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { text: 'done' },
      ],
      compactThresholdTokens: 100_000,
    })
    await h.run(makeRequest({ grounding: [] }))
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === 'compact')).toEqual([])
  })
})
