/**
 * WP180：每次运行的上下文里写一次「现在时间 + 公司时区」——照 WP148 的金样口径说清提示词变了什么。
 *
 * 金样用 WP179 **改前录下**的那一份（`fixtures/wp179-direct-events.json` 的 `no_web_tools`：一次 direct 运行，
 * 调一次普通读工具）。同一次运行接上公司时区之后，事件序列与金样的差别**只有两处**，其余逐字相同：
 *
 * 1. 多一条 `context.injected`（`item_id: 'now'`、`kind: 'time'`），排在事项材料那一条后面；
 * 2. `prompt.assembled` 的 `hash` / `total_tokens` 跟着变（多了这一段字）；**`static_prefix_hash` 不变**——
 *    这一段排在最后、按 user 消息发（同官方 `dsh-time-context`），落在缓存前缀之外。
 *
 * 没接公司时区的运行（`timeZone` 不给）与金样逐字相同——那两条老金样测试照旧过，就是这一半的证明。
 * dsh 那一档拿到的是同一段字（同一个 ContextItem，经 `systemPrompt.context`）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
} from '@agentsws/contracts'
import { timeContextText } from '@agentsws/core'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000 })

const GOLDEN = join(dirname(new URL(import.meta.url).pathname), 'fixtures/wp179-direct-events.json')
const clock: Clock = { now: () => '2026-09-29T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const TEXT = timeContextText({ now: clock.now(), zone: 'Asia/Shanghai' })

function scripted() {
  const seen: ChatMessage[][] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    async complete(req: { messages: ChatMessage[] }) {
      seen.push(req.messages)
      return seen.length === 1
        ? done('', [{ id: 'call_1', name: 'search_policies', input: { query: '退货' } }])
        : done('查完了。')
    },
    recordExternal() {},
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  }
}

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.content', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '查一下 65W 氮化镓充电器的新品',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-29T09:00:00.000Z',
  updated_at: '2026-09-29T09:00:00.000Z',
} as unknown as Matter

async function runOnce(extra: Partial<RuntimeOptions>) {
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const gateway = scripted()
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway as unknown as ModelGatewayApi,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => MODEL,
    modelVision: () => 'ok',
    dshMode: 'in-process',
    ...extra,
  } as RuntimeOptions)
  await runtime.startRun({
    matter,
    brief: '查一下 65W 氮化镓充电器 2026 年的新品和价格',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { events, gateway }
}

type Ev = Omit<EventEnvelope, 'id' | 'at'>
const PROMPT_FIELDS = ['hash', 'total_tokens'] as const

describe('WP180 现在时间 + 公司时区（金样口径）', () => {
  it('与改前金样只差两处：多一条 time 的 context.injected、prompt.assembled 的哈希与字数（缓存前缀不变）', async () => {
    const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { no_web_tools: Ev[] }).no_web_tools
    const { events, gateway } = await runOnce({ timeZone: () => 'Asia/Shanghai' })

    // ① 多出来的那一条
    const injected = events.filter((e) => e.type === 'context.injected')
    expect(injected.map((e) => (e.payload as { kind: string }).kind)).toEqual(['thread', 'time'])
    const time = injected[1]?.payload as Record<string, unknown>
    expect(time).toMatchObject({ item_id: 'now', kind: 'time', source: 'request' })
    expect(time.bytes).toBe(new TextEncoder().encode(TEXT).byteLength)

    // ② prompt.assembled 变的只有哈希与字数
    const before = golden.find((e) => e.type === 'prompt.assembled')?.payload as Record<
      string,
      unknown
    >
    const after = events.find((e) => e.type === 'prompt.assembled')?.payload as Record<
      string,
      unknown
    >
    for (const k of Object.keys(before)) {
      if ((PROMPT_FIELDS as readonly string[]).includes(k)) continue
      expect(after[k], `prompt.assembled.${k}`).toEqual(before[k])
    }
    expect(after.hash).not.toBe(before.hash)
    expect(Number(after.total_tokens)).toBeGreaterThan(Number(before.total_tokens))

    // 其余逐字相同：去掉那一条、把那三个字段换回金样的值，整串相等
    const normalized = events
      .filter(
        (e) => !(e.type === 'context.injected' && (e.payload as { kind: string }).kind === 'time'),
      )
      .map((e) =>
        e.type === 'prompt.assembled'
          ? {
              ...e,
              payload: {
                ...(e.payload as object),
                ...Object.fromEntries(PROMPT_FIELDS.map((k) => [k, before[k]])),
              },
            }
          : e,
      )
    expect(normalized).toEqual(golden)

    // 模型真的看到了这一段（按小时取整、公司时区）
    const text = gateway.seen[0]?.map((m) => m.content).join('\n') ?? ''
    expect(text).toContain('[time:now]')
    expect(text).toContain(
      '现在是 2026-09-29（周二）18:00 前后，公司时区 Asia/Shanghai（UTC+08:00）',
    )
  })

  it('没接公司时区（timeZone 不给）：与金样逐字相同', async () => {
    const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { no_web_tools: Ev[] }).no_web_tools
    const { events } = await runOnce({})
    expect(events).toEqual(golden)
  })

  it('公司档案里的时区认不出：退回本机时区（不是乱写一个）', async () => {
    const { gateway } = await runOnce({ timeZone: () => 'Not/AZone' })
    const text = gateway.seen[0]?.map((m) => m.content).join('\n') ?? ''
    expect(text).toContain('[time:now]')
    expect(text).not.toContain('Not/AZone')
  })
})
