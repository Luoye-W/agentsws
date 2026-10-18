/**
 * WP423（10-19 Mac 自测）：查资料的运行撞上预算，产出只剩一句开场白。direct 这一档钉三件事：
 *
 * 1. 预算到了（token / 调用次数 / 回合）→ 再跑**一次**收尾：交出的是整理好的那一段，不是开场白；
 * 2. 收尾回来的还是开场白 / 只有工具调用 → 换成照实拼的那一段（为什么停 + 做了什么 + 接着做）；
 * 3. 普通运行只回一句「我接下来要…」→ 追一句「接着做」，最多 2 次，不死循环。
 */
import {
  budgetStopReason,
  GENERAL_UNFINISHED_NUDGE,
  UNFINISHED_STEP,
  WRAP_UP_MARK,
  WRAP_UP_STEP,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import type { ScriptFn } from '../src/index.js'
import { eventsOf, harness, makeRequest } from './helpers.js'

const OPENER = '我先上网查，把版面和数据核实清楚，再和你一起挑选。'
const SUMMARY =
  '查到的 5 个版面：r/IVRAfans、r/chargers、r/gadgets、r/UsbCHardware、r/BuyItForLife。还差：3 个值得回的帖没挑完——查的东西太多，这一轮先停在这里。\n<next>接着做</next>'

const lastUser = (messages: { role: string; content: unknown }[]): string => {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : ''
}

/** 开场白 → 一直查；看到收尾那句提示就交一段整理好的（`wrapText` 决定交什么）。 */
const researcher =
  (wrapText: string, wrapCalls = false): ScriptFn =>
  ({ messages, turn }) => {
    if (lastUser(messages).startsWith(WRAP_UP_MARK))
      return wrapCalls ? { tool_calls: [{ name: 'list_orders', input: {} }] } : { text: wrapText }
    return turn === 0
      ? { text: OPENER, tool_calls: [{ name: 'list_orders', input: {} }] }
      : { tool_calls: [{ name: 'list_orders', input: {} }] }
  }

const request = (budget: { max_tokens?: number; max_tool_calls?: number; max_turns?: number }) =>
  makeRequest({
    grounding: [],
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
    budget: {
      max_tokens: budget.max_tokens ?? 400_000,
      max_tool_calls: budget.max_tool_calls ?? 30,
      max_seconds: 120,
      max_cost_base: 5,
      ...(budget.max_turns === undefined ? {} : { max_turns: budget.max_turns }),
    },
  })

describe('WP423 direct：预算到了 → 收尾交东西', () => {
  it('max_tokens 到了：再跑一次收尾，交出整理好的那一段（不是开场白），状态仍是预算用完', async () => {
    const h = harness({ script: researcher(SUMMARY) })
    const result = await h.run(request({ max_tokens: 3_000 }))
    expect(result.status).toBe('budget_exhausted')
    expect(eventsOf(h.events, 'budget.exhausted')[0]?.which).toBe('max_tokens')
    expect(h.events.filter((e) => e.type === 'progress' && e.step === WRAP_UP_STEP)).toHaveLength(1)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' && answer.text).toBe(SUMMARY)
    expect(result.summary).toContain(budgetStopReason('max_tokens'))
    expect(result.summary).not.toContain('max_tokens')
  })

  it('收尾回来的还是开场白：换成照实拼的那一段（为什么停、做了什么、接着做）', async () => {
    const h = harness({ script: researcher(OPENER) })
    const result = await h.run(request({ max_tool_calls: 3 }))
    expect(result.status).toBe('budget_exhausted')
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text).not.toBe(OPENER)
    expect(text).toContain(budgetStopReason('max_tool_calls'))
    expect(text).toContain('已经做了')
    expect(text).toContain('接着做')
  })

  it('收尾时模型还想调工具：一个都不执行，照实拼的那一段兜住', async () => {
    const h = harness({ script: researcher('', true) })
    const result = await h.run(request({ max_turns: 2 }))
    expect(result.status).toBe('budget_exhausted')
    expect(eventsOf(h.events, 'budget.exhausted')[0]?.which).toBe('max_turns')
    // 两回合各调一次；收尾那一跳的调用没执行
    expect(h.toolCalls).toHaveLength(2)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' && answer.text).toContain(budgetStopReason('max_turns'))
  })
})

describe('WP423 direct：没交东西就催（普通运行，最多 2 次）', () => {
  it('一直只回「我先…」：催 2 次就停，不死循环', async () => {
    const h = harness({ script: () => ({ text: OPENER }) })
    const result = await h.run(request({}))
    const nudges = h.events.filter((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)
    expect(nudges).toHaveLength(2)
    expect(result.status).toBe('completed')
  })

  it('催一次就去做了：接着查、交出结果', async () => {
    const h = harness({
      script: ({ messages, turn }) => {
        if (turn === 0) return { text: OPENER }
        if (messages.at(-1)?.role === 'user' && lastUser(messages) === GENERAL_UNFINISHED_NUDGE)
          return { tool_calls: [{ name: 'list_orders', input: {} }] }
        return { text: '查好了：订单 #1001 已签收。' }
      },
    })
    const result = await h.run(request({}))
    expect(h.toolCalls.map((c) => c.name)).toEqual(['list_orders'])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' && answer.text).toBe('查好了：订单 #1001 已签收。')
  })

  it('正常的答复不催', async () => {
    const h = harness({ script: () => ({ text: '订单 #1001 已签收，还在退货窗口内。' }) })
    await h.run(request({}))
    expect(h.events.some((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)).toBe(false)
  })
})
