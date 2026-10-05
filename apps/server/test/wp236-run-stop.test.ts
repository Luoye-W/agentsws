/**
 * WP236：宿主看门狗（三个运行时档同一套口径）+ 停下来让人看见、已经干的不丢。
 *
 * 端到端（真 `createRuntime` + 替身模型，direct 档，不联网）。时长线经职责阈值缩成 1 秒：
 * - 一直有动静（每 0.6 秒一次工具调用、总长 > 1 秒）→ 不停，照常出答复；
 * - 模型那一跳卡住超过空闲线 → `run.cancelled{reason:'idle_timeout'}`；时间线一句人话 +
 *   部分结果（模型说过的话 + 已取回的 Reddit 标题），带 `stopped`（界面据此出「接着跑」）；
 *   事项摘要里也有已经查到的东西（下一次接着跑的上下文）。
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
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { ToolExecutor } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { PartialRunLog, stoppedLine } from '../src/run-stop.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => new Date().toISOString() }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
  text,
  ...(tool_calls === undefined ? {} : { tool_calls }),
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
  model: { provider: 'stub', model: 'stub-v1' },
  static_prefix_hash: 'p',
})

/** 前 `calls` 次各调一次 read_reddit（每次先等 `stepMs`），之后等 `finalMs` 再回一句话。 */
function scripted(calls: number, stepMs: number, finalMs: number) {
  let n = 0
  return {
    async complete(_req: { messages: ChatMessage[] }) {
      n += 1
      if (n <= calls) {
        await sleep(stepMs)
        return done(n === 1 ? '我先去 Reddit 上搜一下 INMO 最近的讨论。' : '', [
          { id: `call_${n}`, name: 'read_reddit', input: { query: `INMO ${n}` } },
        ])
      }
      await sleep(finalMs)
      return done('挑出了最值得关注的 5 条。')
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
      {
        kind: 'post',
        url: 'https://reddit.com/x',
        title: `INMO Air3 review ${String(call.input.query)}`,
        text: '…',
      },
    ],
  },
})

const roles = (thresholds: Record<string, number>): RoleStore =>
  ({
    effectiveConfig: () => ({
      role_id: 'social.reddit',
      grounding: [
        { name: 'reddit', intent_terms: [], cue_terms: [], tool: 'read_reddit', prefetch: false },
      ],
      skills: [],
      browser_scope: [],
    }),
    roles: { get: () => ({ thresholds }) },
    assignments: { get: () => undefined },
  }) as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: 'INMO Reddit 研究',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-06T09:00:00.000Z',
  updated_at: '2026-10-06T09:00:00.000Z',
} as unknown as Matter

async function runOnce(gateway: ModelGatewayApi, thresholds: Record<string, number>) {
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
    roles: roles(thresholds),
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
    brief: '看看 Reddit 上最近一周大家在聊 INMO 智能眼镜的什么',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { timeline, summaries, events }
}

describe('WP236 宿主看门狗：没动静才停', () => {
  it('一直有动静（每 0.6 秒一次取数，总长超过空闲线）→ 不停，照常答复', async () => {
    const { timeline, events } = await runOnce(scripted(3, 600, 100), {
      run_idle_timeout_seconds: 1,
      run_max_duration_seconds: 60,
    })
    expect(events.some((e) => e.type === 'run.cancelled')).toBe(false)
    expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(3)
    expect(timeline.some((e) => e.stopped !== undefined)).toBe(false)
    expect(timeline.find((e) => e.kind === 'agent_message')?.text).toContain('最值得关注的 5 条')
  }, 30_000)

  it('模型卡住超过空闲线 → idle_timeout；时间线一句人话 + 部分结果 + 接着跑', async () => {
    const { timeline, summaries, events } = await runOnce(scripted(2, 50, 2_000), {
      run_idle_timeout_seconds: 1,
      run_max_duration_seconds: 60,
    })
    const cancelled = events.find((e) => e.type === 'run.cancelled')
    expect(cancelled).toEqual({ type: 'run.cancelled', reason: 'idle_timeout' })
    const status = timeline.find((e) => e.kind === 'status')
    expect(status?.text).toContain('太久没有动静')
    expect(status?.text).toContain('已经查到的部分在下面')
    const partial = timeline.find((e) => e.kind === 'agent_message')
    expect(partial?.stopped).toEqual({ reason: 'idle_timeout' })
    expect(partial?.text).toContain('我先去 Reddit 上搜一下')
    expect(partial?.text).toContain('INMO Air3 review INMO 1')
    expect(partial?.text).toContain('INMO Air3 review INMO 2')
    // 工具名不露（换成人话）
    expect(partial?.text).not.toContain('read_reddit')
    expect(summaries[0]).toContain('INMO Air3 review')
  }, 30_000)

  it('一直忙但跑满总时长 → max_duration', async () => {
    const { timeline, events } = await runOnce(scripted(10, 400, 100), {
      run_idle_timeout_seconds: 1,
      run_max_duration_seconds: 1,
    })
    expect(events.find((e) => e.type === 'run.cancelled')).toEqual({
      type: 'run.cancelled',
      reason: 'max_duration',
    })
    expect(timeline.find((e) => e.kind === 'status')?.text).toContain('跑太久被停了')
  }, 30_000)
})

describe('WP236 部分结果与停的那句话', () => {
  it('什么都还没有 → 没有部分结果，那句话照实说', () => {
    const log = new PartialRunLog()
    expect(log.digest()).toBeUndefined()
    expect(
      stoppedLine('max_duration', { idle_timeout_seconds: 180, max_duration_seconds: 1200 }, false),
    ).toBe('这次跑太久被停了（超过 20 分钟上限），还没拿到可用的结果；点「接着跑」可以再来一次。')
  })

  it('没取到的照实写「没取到」、出错的不列', () => {
    const log = new PartialRunLog()
    log.hostTool({
      tool: 'read_reddit',
      input: { query: 'INMO' },
      status: 'ok',
      data: { rows: 0, items: [], missing: '两路都没取到' },
    })
    log.hostTool({ tool: 'read_reddit', input: { query: 'x' }, status: 'error' })
    expect(log.fetched()).toHaveLength(1)
    expect(log.fetched()[0]).toContain('没取到')
  })
})
