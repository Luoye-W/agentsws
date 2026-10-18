/**
 * WP423（10-19 Mac 自测走的就是这一档）：查资料的运行撞上预算，产出只剩一句开场白。dsh 两档（同进程 / 子进程）钉：
 *
 * 1. 预算到了（token / 调用次数）→ 在同一个 Agent 上再跑一次收尾：交出整理好的那一段，不是开场白；
 * 2. 收尾时模型还想调工具 → 一个都不执行；收回来的是开场白 → 换成照实拼的那一段；
 * 3. 普通运行只回一句「我接下来要…」→ 追一句「接着做」，最多 2 次。
 */
import type { ChatMessage, Completion, RunRequest } from '@agentsws/contracts'
import { chatContentText } from '@agentsws/contracts'
import {
  budgetStopReason,
  GENERAL_UNFINISHED_NUDGE,
  UNFINISHED_STEP,
  WRAP_UP_MARK,
  WRAP_UP_STEP,
} from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import { createDshRuntime, type DshRuntimeMode, type ModelGatewayLike } from '../src/index.js'
import { baseOptions, collect, MODEL, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const OPENER = '我先上网查，把版面和数据核实清楚，再和你一起挑选。'
const SUMMARY =
  '查到的 5 个版面：r/IVRAfans、r/chargers、r/gadgets、r/UsbCHardware、r/BuyItForLife。还差 3 个帖子没挑完。\n<next>接着做</next>'
const READ = (i: number) => ({ id: `c${i}`, name: 'list_orders', input: {} })

const lastUser = (messages: ChatMessage[]): string => {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  return m === undefined ? '' : chatContentText(m.content)
}

/** 每一步都花 `perStep` token；看到收尾那句就回 `wrap`，否则一直调工具（第一步带开场白）。 */
function researcher(
  wrap: Pick<Completion, 'text' | 'tool_calls'>,
  perStep = 10,
): ModelGatewayLike & { seen: ChatMessage[][]; tools: number[] } {
  const seen: ChatMessage[][] = []
  const tools: number[] = []
  return {
    seen,
    tools,
    async complete(req): Promise<Completion> {
      seen.push(req.messages)
      tools.push(req.tools?.length ?? 0)
      const turn: Pick<Completion, 'text' | 'tool_calls'> = lastUser(req.messages).startsWith(
        WRAP_UP_MARK,
      )
        ? wrap
        : seen.length === 1
          ? { text: OPENER, tool_calls: [READ(seen.length)] }
          : { text: '', tool_calls: [READ(seen.length)] }
      return {
        text: turn.text,
        ...(turn.tool_calls === undefined ? {} : { tool_calls: turn.tool_calls }),
        usage: { input_tokens: perStep, output_tokens: 0, cached_tokens: 0, cost_base: 0 },
        model: MODEL,
        static_prefix_hash: 'prefix',
      }
    },
  }
}

function talker(
  reply: (messages: ChatMessage[], n: number) => Pick<Completion, 'text' | 'tool_calls'>,
): ModelGatewayLike & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return {
    seen,
    async complete(req): Promise<Completion> {
      seen.push(req.messages)
      const turn = reply(req.messages, seen.length)
      return {
        text: turn.text,
        ...(turn.tool_calls === undefined ? {} : { tool_calls: turn.tool_calls }),
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: MODEL,
        static_prefix_hash: 'prefix',
      }
    },
  }
}

const research = (budget: Partial<RunRequest['budget']>): RunRequest => {
  const base = makeRequest({ role_id: 'dtc.content', threadText: '找 5 个 subreddit' })
  return {
    ...base,
    grounding: [],
    tools: { ...base.tools, allow: ['list_orders'] },
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
    budget: { ...base.budget, ...budget },
  }
}

const MODES: Exclude<DshRuntimeMode, 'auto'>[] = ['in-process', 'subprocess']

describe.each(MODES)('WP423 dsh（%s）：预算到了 → 收尾交东西', (mode) => {
  it('max_tokens 到了：同一个 Agent 再跑一次收尾，交出整理好的那一段（不是开场白）', async () => {
    const gateway = researcher({ text: SUMMARY }, 2_000)
    const runtime = createDshRuntime({ ...baseOptions({ gateway }), mode })
    const { sink, events } = collect()
    const result = await runtime.run(
      research({ max_tokens: 5_000, max_tool_calls: 30 }),
      sink,
      new AbortController().signal,
    )
    expect(result.status).toBe('budget_exhausted')
    const hit = events.find((e) => e.type === 'budget.exhausted')
    expect(hit?.type === 'budget.exhausted' && hit.which).toBe('max_tokens')
    expect(events.filter((e) => e.type === 'progress' && e.step === WRAP_UP_STEP)).toHaveLength(1)
    // 收尾那一跳的工具面照旧摆着（缓存不失效），但不执行
    expect(lastUser(gateway.seen.at(-1) ?? [])).toContain(WRAP_UP_MARK)
    expect(result.outputs).toContainEqual({ kind: 'answer', text: SUMMARY })
    expect(result.summary).toContain(budgetStopReason('max_tokens'))
  })

  it('收尾时还想调工具、或只回开场白：一个都不执行，照实拼的那一段兜住', async () => {
    for (const wrap of [{ text: '', tool_calls: [READ(99)] }, { text: OPENER }]) {
      const gateway = researcher(wrap)
      const calls: string[] = []
      const runtime = createDshRuntime({
        ...baseOptions({
          gateway,
          executeTool: async ({ name }) => {
            calls.push(name)
            return { status: 'ok', data: { orders: [] } }
          },
        }),
        mode,
      })
      const { sink } = collect()
      const result = await runtime.run(
        research({ max_tool_calls: 2 }),
        sink,
        new AbortController().signal,
      )
      expect(result.status).toBe('budget_exhausted')
      expect(calls).toHaveLength(2)
      const answer = result.outputs.find((o) => o.kind === 'answer')
      const text = answer?.kind === 'answer' ? answer.text : ''
      expect(text).not.toBe(OPENER)
      expect(text).toContain(budgetStopReason('max_tool_calls'))
      expect(text).toContain('接着做')
    }
  })
})

describe.each(MODES)('WP423 dsh（%s）：没交东西就催（普通运行，最多 2 次）', (mode) => {
  it('一直只回「我先…」：催 2 次就停', async () => {
    const gateway = talker(() => ({ text: OPENER }))
    const runtime = createDshRuntime({ ...baseOptions({ gateway }), mode })
    const { sink, events } = collect()
    await runtime.run(research({}), sink, new AbortController().signal)
    expect(gateway.seen).toHaveLength(3)
    expect(events.filter((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)).toHaveLength(
      2,
    )
  })

  it('催一次就去做了：接着查、交出结果', async () => {
    const gateway = talker((messages, n) =>
      n === 1
        ? { text: OPENER }
        : lastUser(messages) === GENERAL_UNFINISHED_NUDGE && messages.at(-1)?.role === 'user'
          ? { text: '', tool_calls: [READ(n)] }
          : { text: '查好了：5 个版面都在下面。' },
    )
    const runtime = createDshRuntime({ ...baseOptions({ gateway }), mode })
    const { sink } = collect()
    const result = await runtime.run(research({}), sink, new AbortController().signal)
    expect(result.outputs).toContainEqual({ kind: 'answer', text: '查好了：5 个版面都在下面。' })
  })
})
