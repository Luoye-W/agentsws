/**
 * WP423（10-19 Mac 自测）：Reddit 运营岗查资料撞上预算，时间线上只剩一句开场白、写着「这次被停下了」。
 *
 * 端到端（真 `createRuntime` + 替身模型，direct 档，不联网）：模型一直在取数、回合用完——
 * - 运行时再跑一次收尾，时间线上 AI 那段话是**整理好的结果**，不是开场白；末尾的 `<next>接着做</next>` 变成下一步建议；
 * - 摘要那一行写人话原因（不是「这次被停下了」），带 `run_digest.budget`（界面据此出「接着做」）；
 * - 事项的「到哪了」也是人话原因，不露 `max_turns` 这类键名。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  Matter,
  MatterEvent,
  ModelRef,
  RunEvent,
} from '@agentsws/contracts'
import { chatContentText } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { budgetStopReason, type ToolExecutor, WRAP_UP_MARK } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => new Date().toISOString() }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const OPENER = '我先上网查，把版面和数据核实清楚，再和你一起挑选。'
const SUMMARY =
  '查到的 5 个版面：r/IVRAfans、r/smartglasses……还差 3 个值得回的帖没挑完。\n<next>接着做</next>'

const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
  text,
  ...(tool_calls === undefined ? {} : { tool_calls }),
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
  model: { provider: 'stub', model: 'stub-v1' },
  static_prefix_hash: 'p',
})

/** 一直调 read_reddit（第一跳带开场白）；看到收尾那句就交 `wrap`。 */
function researcher(wrap: string) {
  let n = 0
  return {
    async complete(req: { messages: ChatMessage[] }) {
      n += 1
      const last = req.messages.at(-1)
      if (last?.role === 'user' && chatContentText(last.content).startsWith(WRAP_UP_MARK))
        return done(wrap)
      return done(n === 1 ? OPENER : '', [
        { id: `call_${n}`, name: 'read_reddit', input: { query: `IVRA ${n}` } },
      ])
    },
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  } as unknown as ModelGatewayApi
}

const research: ToolExecutor = async (call) => ({
  status: 'ok',
  data: {
    rows: 1,
    items: [
      { kind: 'post', url: 'https://reddit.com/x', title: `IVRA ${String(call.input.query)}` },
    ],
  },
})

const roles = {
  effectiveConfig: () => ({
    role_id: 'social.reddit',
    grounding: [
      { name: 'reddit', intent_terms: [], cue_terms: [], tool: 'read_reddit', prefetch: false },
    ],
    skills: [],
    browser_scope: [],
  }),
  roles: { get: () => ({ thresholds: { run_idle_timeout_seconds: 60 } }) },
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: 'IVRA subreddit',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-19T09:00:00.000Z',
  updated_at: '2026-10-19T09:00:00.000Z',
} as unknown as Matter

async function runOnce(gateway: ModelGatewayApi) {
  const timeline: (Partial<MatterEvent> & { kind: string; text: string })[] = []
  const summaries: string[] = []
  const events: RunEvent[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: (e) => {
      events.push({ type: e.type, ...(e.payload as object) } as RunEvent)
    },
    prefer: 'direct',
    modelRef: () => MODEL,
    researchTools: research,
  })
  runtime.bind({
    appendEvent: (_id: string, e: { kind: string; text: string }) => {
      timeline.push(e)
    },
    onRunCompleted: (input: { summary: string }) => {
      summaries.push(input.summary)
    },
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '找 5 个适合 IVRA 的 subreddit + 3 个值得回的帖',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { timeline, summaries, events }
}

describe('WP423 预算到了：时间线上交的是结果，不是开场白', () => {
  it('收尾那段话进时间线 + 「接着做」建议；摘要一行写人话原因并带 budget', async () => {
    const { timeline, summaries, events } = await runOnce(researcher(SUMMARY))
    const hit = events.find((e) => e.type === 'budget.exhausted')
    expect(hit?.type === 'budget.exhausted' && hit.which).toBe('max_turns')
    const digest = timeline.find((e) => e.run_digest !== undefined)
    expect(digest?.run_digest?.outcome).toBe('stopped')
    expect(digest?.run_digest?.budget).toBe('max_turns')
    expect(digest?.text).toBe(budgetStopReason('max_turns'))
    const reply = timeline.find((e) => e.kind === 'agent_message')
    expect(reply?.text).toContain('查到的 5 个版面')
    expect(reply?.text).not.toContain('<next>')
    expect(reply?.next_suggestion).toBe('接着做')
    expect(summaries[0]).toContain(budgetStopReason('max_turns'))
    expect(summaries[0]).not.toContain('max_turns')
  }, 30_000)

  it('收尾回来的还是开场白：时间线上是照实拼的那一段（做了什么、接着做），不是那句开场白', async () => {
    const { timeline } = await runOnce(researcher(OPENER))
    const reply = timeline.find((e) => e.kind === 'agent_message')
    expect(reply?.text).not.toBe(OPENER)
    expect(reply?.text).toContain(budgetStopReason('max_turns'))
    expect(reply?.text).toContain('已经做了')
    expect(reply?.next_suggestion).toBe('接着做')
  }, 30_000)
})
