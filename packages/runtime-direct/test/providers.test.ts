import type { ChatMessage } from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import {
  aftersalesBrain,
  aftersalesBrainProvider,
  groundingInputFor,
  orderFromToolMessage,
  scriptedProvider,
  turnOf,
} from '../src/index.js'
import { clock, eventsOf, harness, ORDER } from './helpers.js'

describe('确定性 provider（22 的 stub 不返 tool_calls）', () => {
  it('scriptedProvider 按轮次出招，同输入同输出', async () => {
    const p = scriptedProvider({
      script: [
        { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1' } }] },
        { text: 'ok' },
      ],
      seed: 3,
    })
    const first = await p.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(first.tool_calls?.[0]).toEqual({
      id: 'call_1_1',
      name: 'get_order',
      input: { order_id: 'ord_1' },
    })
    const again = await p.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(again).toEqual(first)

    const second = await p.complete({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'calling' },
      ],
    })
    expect(second.text).toBe('ok')
    expect(second.tool_calls).toBeUndefined()
  })

  it('脚本用完了就闭嘴（空文本、无工具调用）', async () => {
    const p = scriptedProvider({ script: [{ text: 'only one' }] })
    const out = await p.complete({
      messages: [
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    })
    expect(out.text).toBe('')
    expect(out.tool_calls).toBeUndefined()
  })

  it('turnOf 数的是 assistant 消息', () => {
    expect(turnOf([])).toBe(0)
    expect(
      turnOf([
        { role: 'system', content: 's' },
        { role: 'assistant', content: 'a' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' },
      ]),
    ).toBe(2)
  })
})

describe('售后规则脑', () => {
  const tools = [
    { name: 'get_order', description: '', input_schema: {} },
    { name: 'search_policies', description: '', input_schema: {} },
    { name: 'stage_refund', description: '', input_schema: {} },
    { name: 'draft_reply', description: '', input_schema: {} },
  ]
  const threadMsg: ChatMessage = {
    role: 'user',
    content: `[thread:thr_1]\n${EXTERNAL_FENCE.fencePayload('I want to return it and get a refund. Order #1001.')}\nReturn request for #1001`,
  }
  const factMsg: ChatMessage = {
    role: 'system',
    content: '[fact_card:fact_return_window]\nReturns are accepted within 14 days of delivery.',
  }
  const orderMsg: ChatMessage = {
    role: 'tool',
    name: 'get_order',
    tool_call_id: 'c1',
    content: EXTERNAL_FENCE.fencePayload(ORDER),
  }
  const policyMsg: ChatMessage = {
    role: 'tool',
    name: 'search_policies',
    tool_call_id: 'c2',
    content: EXTERNAL_FENCE.fencePayload({ hits: [] }),
  }

  const brain = aftersalesBrain({ clock: clock() })

  it('先查单', () => {
    const step = brain({ messages: [factMsg, threadMsg], tools, turn: 0 })
    expect(step.tool_calls?.[0]).toEqual({ name: 'get_order', input: { order_id: 'ord_1001' } })
  })

  it('再查政策', () => {
    const step = brain({ messages: [factMsg, threadMsg, orderMsg], tools, turn: 1 })
    expect(step.tool_calls?.[0]?.name).toBe('search_policies')
  })

  it('窗口内的变更请求 → 提退款', () => {
    const step = brain({ messages: [factMsg, threadMsg, orderMsg, policyMsg], tools, turn: 2 })
    expect(step.tool_calls?.[0]?.name).toBe('stage_refund')
    expect(step.tool_calls?.[0]?.input).toMatchObject({
      order_id: 'ord_1001',
      amount: 129,
      currency: 'USD',
    })
  })

  it('已经退过就不再提，直接起草；正文引用窗口天数', () => {
    const refunded: ChatMessage = {
      ...orderMsg,
      content: EXTERNAL_FENCE.fencePayload({ ...ORDER, refunded_amount: 129 }),
    }
    const step = brain({ messages: [factMsg, threadMsg, refunded, policyMsg], tools, turn: 2 })
    expect(step.tool_calls?.[0]?.name).toBe('draft_reply')
    const input = step.tool_calls?.[0]?.input as {
      to: string[]
      subject: string
      body: string
      citations: { fact_card_id: string }[]
    }
    expect(input.to).toEqual(['anna@example.com'])
    expect(input.subject).toBe('Re: Return request for #1001')
    expect(input.body).toContain('within 14 days of delivery')
    expect(input.citations[0]?.fact_card_id).toBe('fact_return_window')
  })

  it('窗口外：正文说清楚不在窗口内，不提退款', () => {
    const late = aftersalesBrain({ clock: clock('2026-11-01T09:00:00.000Z') })
    const step = late({ messages: [factMsg, threadMsg, orderMsg, policyMsg], tools, turn: 2 })
    expect(step.tool_calls?.[0]?.name).toBe('draft_reply')
    const draft = step.tool_calls?.[0]?.input as { body: string } | undefined
    expect(draft?.body).toContain('outside the 14-day window')
  })

  it('都干完了就收尾', () => {
    const draftMsg: ChatMessage = {
      role: 'tool',
      name: 'draft_reply',
      tool_call_id: 'c3',
      content: EXTERNAL_FENCE.fencePayload({ approval_item_id: 'appr_1' }),
    }
    const stageMsg: ChatMessage = {
      role: 'tool',
      name: 'stage_refund',
      tool_call_id: 'c4',
      content: EXTERNAL_FENCE.fencePayload({ change_id: 'chg_1' }),
    }
    const step = brain({
      messages: [factMsg, threadMsg, orderMsg, policyMsg, stageMsg, draftMsg],
      tools,
      turn: 4,
    })
    expect(step.tool_calls).toBeUndefined()
    expect(step.text).toContain('#1001')
  })

  it('groundingInputFor / orderFromToolMessage', () => {
    expect(groundingInputFor('shopify_admin.get_order', [threadMsg])).toEqual({
      order_id: 'ord_1001',
    })
    expect(groundingInputFor('search_policies', [threadMsg])).toEqual({ query: 'return window' })
    expect(groundingInputFor('list_orders', [threadMsg])).toEqual({})
    expect(orderFromToolMessage(orderMsg)?.id).toBe('ord_1001')
    expect(orderFromToolMessage({ role: 'tool', content: 'not fenced' })).toBeUndefined()
  })

  it('挂进 direct-llm 跑一遍：先查单 → 查政策 → 提退款 → 起草 → 收尾', async () => {
    const c = clock()
    const h = harness({ script: aftersalesBrain({ clock: c }), clock: c })
    const result = await h.run()
    expect(eventsOf(h.events, 'tool.call').map((e) => e.tool)).toEqual([
      'get_order',
      'search_policies',
      'stage_refund',
      'draft_reply',
    ])
    expect(result.status).toBe('completed')
    expect(result.outputs.map((o) => o.kind)).toEqual(['staged_change', 'draft'])
    expect(h.drafts[0]?.body).toContain('within 14 days of delivery')
    expect(h.drafts[0]?.body).toContain('prepared a refund of 129 USD')
    expect(result.no_stage).toBeUndefined()
  })

  it('aftersalesBrainProvider 直接可用', async () => {
    const p = aftersalesBrainProvider({ clock: clock(), seed: 1 })
    expect(p.ref.provider).toBe('stub')
    const out = await p.complete({ messages: [factMsg, threadMsg], tools })
    expect(out.tool_calls?.[0]?.name).toBe('get_order')
    expect(out.usage.input_tokens).toBeGreaterThan(0)
  })
})
