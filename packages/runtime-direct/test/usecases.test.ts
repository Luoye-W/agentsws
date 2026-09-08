import type { ContextItem, RunEvent, RunRequest } from '@agentsws/contracts'
import { canonicalJson } from '@agentsws/core'
import { assemblePromptHash, contextItemHash } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import type { ScriptedTurn } from '../src/index.js'
import { eventsOf, harness, makeRequest, types } from './helpers.js'

/** 一条走完全程的脚本：查单 → 查政策 → 提退款 → 起草 → 收尾。 */
export const HAPPY: ScriptedTurn[] = [
  { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
  { tool_calls: [{ name: 'search_policies', input: { query: 'return window' } }] },
  {
    tool_calls: [
      { name: 'stage_refund', input: { order_id: 'ord_1001', amount: 129, currency: 'USD' } },
    ],
  },
  {
    tool_calls: [
      {
        name: 'draft_reply',
        input: {
          to: ['anna@example.com'],
          subject: 'Re: Return request for #1001',
          body: 'Returns are accepted within 14 days of delivery.',
          citations: [{ fact_card_id: 'fact_return_window', quote: 'within 14 days' }],
        },
      },
    ],
  },
  { text: 'Drafted a reply and staged the refund.' },
]

describe('17 §6 一致性用例', () => {
  it('1. 回放事件日志重组 prompt，与 prompt.assembled.hash 一致', async () => {
    const h = harness({ script: HAPPY })
    const req = makeRequest()
    await h.run(req)
    const assembled = eventsOf(h.events, 'prompt.assembled')[0]
    expect(assembled).toBeDefined()
    // 事件日志存的是规范化 JSON，回放拿到的键序与写入时不同
    const replayed = JSON.parse(canonicalJson(req)) as RunRequest
    expect(assemblePromptHash(replayed)).toBe(assembled?.hash)

    const injected = eventsOf(h.events, 'context.injected')
    expect(injected).toHaveLength(replayed.context.length)
    for (const [i, e] of injected.entries()) {
      const item = replayed.context[i] as ContextItem
      expect(e.item_id).toBe(item.id)
      expect(e.kind).toBe(item.kind)
      expect(e.hash).toBe(contextItemHash(item))
    }
  })

  it('2. 静态前缀两次装配逐字节相同（跑两次运行比对事件）', async () => {
    const h = harness({ script: HAPPY })
    await h.run(makeRequest({ id: 'run_a', idempotency_key: 'k_a' }))
    await h.run(makeRequest({ id: 'run_b', idempotency_key: 'k_b' }))
    const [a, b] = eventsOf(h.events, 'prompt.assembled')
    expect(a?.static_prefix_hash).toBe(b?.static_prefix_hash)
  })

  it('3. 不在 allow 的工具 → tool.result{blocked}，不到达工具', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'create_discount_code', input: { pct: 50 } }] },
        { text: 'stopped' },
      ],
    })
    // grounding 不命中，第一轮就是模型自己挑的工具
    await h.run(makeRequest({ grounding: [] }))
    const blocked = eventsOf(h.events, 'tool.result').filter((e) => e.status === 'blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.reason).toBe('not_in_allowlist: create_discount_code')
    expect(h.toolCalls).toEqual([])
  })

  it('4. max_tool_calls=3，第 4 次调用 → budget.exhausted，未闭合调用被补齐', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { tool_calls: [{ name: 'search_policies', input: {} }] },
        { tool_calls: [{ name: 'list_orders', input: {} }] },
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        { text: 'never reached' },
      ],
    })
    const result = await h.run(
      makeRequest({
        budget: { max_tokens: 60_000, max_tool_calls: 3, max_seconds: 120, max_cost_base: 5 },
      }),
    )
    const exhausted = eventsOf(h.events, 'budget.exhausted')
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0]?.which).toBe('max_tool_calls')
    expect(exhausted[0]?.cap).toBe(3)
    expect(eventsOf(h.events, 'budget.warning')[0]?.which).toBe('max_tool_calls')

    // close_open_tool_uses：每条 tool.call 都有对应的 tool.result
    const calls = eventsOf(h.events, 'tool.call').map((e) => e.call_id)
    const results = eventsOf(h.events, 'tool.result').map((e) => e.call_id)
    expect(calls).toHaveLength(4)
    expect(new Set(results)).toEqual(new Set(calls))
    const last = eventsOf(h.events, 'tool.result').at(-1)
    expect(last?.status).toBe('blocked')
    expect(last?.reason).toBe('budget_exhausted')
    expect(result.status).toBe('budget_exhausted')
    expect(result.usage.tool_calls).toBe(3)
    expect(types(h.events).at(-1)).toBe('run.completed')
  })

  it('5. grounding 命中 + 运行时无 tool_choice → 第一条 ContextItem 是 prefetch', async () => {
    const h = harness({ script: HAPPY, toolChoice: false })
    await h.run()
    const injected = eventsOf(h.events, 'context.injected')
    expect(injected[0]?.kind).toBe('prefetch')
    expect(injected[0]?.item_id).toBe('prefetch_order_status')
    // 预取真的调了 grounding 规则里的那个工具，参数从线程里推出来
    expect(h.toolCalls[0]).toEqual({ name: 'get_order', input: { order_id: 'ord_1001' } })
    expect(eventsOf(h.events, 'progress').some((e) => e.step === 'grounding')).toBe(true)
  })

  it('6. must_stage_if_change_requested 且模型没 stage → RunResult 带 no_stage', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
        {
          tool_calls: [
            {
              name: 'draft_reply',
              input: { to: ['anna@example.com'], subject: 'Re: #1001', body: 'No refund staged.' },
            },
          ],
        },
        { text: 'done' },
      ],
    })
    const result = await h.run()
    expect(result.no_stage).toBe(true)
    expect(result.outputs.map((o) => o.kind)).toEqual(['draft'])

    // 对照：真的 stage 了就没有这个标记
    const ok = harness({ script: HAPPY })
    const good = await ok.run()
    expect(good.no_stage).toBeUndefined()
    expect(good.outputs.map((o) => o.kind)).toEqual(['staged_change', 'draft'])
  })

  it('7. 同 seed 两次运行返回相同的事件序列', async () => {
    const fingerprint = (events: readonly RunEvent[]): string => canonicalJson(events)
    const a = harness({ script: HAPPY })
    await a.run()
    const b = harness({ script: HAPPY })
    await b.run()
    expect(fingerprint(a.events)).toBe(fingerprint(b.events))
  })

  it('8. 高于 actor 可见级的上下文项：Agent 读得到、日志有，宿主预检把草稿拦下', async () => {
    const req = makeRequest()
    const restricted: ContextItem = {
      id: 'cost_price',
      kind: 'fact_card',
      source_ref: { type: 'fact_card', id: 'cost_price' },
      sensitivity: 'restricted',
      content: 'The unit cost price is 41 USD.',
      bytes: 30,
    }
    const h = harness({
      script: [
        {
          tool_calls: [
            {
              name: 'draft_reply',
              input: {
                to: ['anna@example.com'],
                subject: 'Re: #1001',
                body: 'The unit cost price is 41 USD.',
              },
            },
          ],
        },
        { text: 'done' },
      ],
      // 14 §6 预检：草稿里出现了高敏内容 → 不进队列
      draftResult: (payload) =>
        payload.body.includes('cost price') ? undefined : { approval_item_id: 'appr_ok' },
    })
    const result = await h.run(
      makeRequest({ context: [...req.context, restricted], grounding: [] }),
    )
    const injected = eventsOf(h.events, 'context.injected')
    expect(injected.map((e) => e.item_id)).toContain('cost_price')
    const draftResult = eventsOf(h.events, 'tool.result').at(-1)
    expect(draftResult?.status).toBe('blocked')
    expect(draftResult?.reason).toBe('draft_rejected')
    expect(result.outputs).toEqual([])
    expect(types(h.events)).not.toContain('proposal.created')
  })
})
