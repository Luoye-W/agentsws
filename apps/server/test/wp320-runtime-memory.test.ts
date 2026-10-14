/**
 * WP320 运行时那一侧：提示词里有「记忆」那一段；答复里的 `<remember>` 进时间线之前拿掉、
 * 跑完交给自动记忆；没装配记忆时一个字节不变。
 *
 * 真 `createRuntime` + 替身模型（direct 档），不联网、不花钱。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { RememberItem } from '../src/auto-memory.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

let tick = Date.parse('2026-10-14T06:00:00.000Z')
const clock: Clock = {
  now: () => {
    tick += 1000
    return new Date(tick).toISOString()
  },
}
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

function scripted(reply: string) {
  const seen: ChatMessage[][] = []
  return {
    seen,
    async complete(req: { messages: ChatMessage[] }): Promise<Completion> {
      seen.push(req.messages)
      return {
        text: reply,
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'p',
      }
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
  } as unknown as ModelGatewayApi & { seen: ChatMessage[][] }
}

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '回客户',
  status: 'open',
  position_template_id: 'support',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-14T05:00:00.000Z',
  updated_at: '2026-10-14T05:00:00.000Z',
} as unknown as Matter

async function runOnce(reply: string, withMemory: boolean) {
  const gateway = scripted(reply)
  const timeline: Record<string, unknown>[] = []
  const summaries: string[] = []
  const after: { items: readonly RememberItem[]; brief: string; position_id?: string }[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
    ...(withMemory
      ? {
          memory: {
            section: () => ({
              id: 'memory',
              name: '记忆',
              order: 26,
              text: '- [岗位] 回客户一律先道歉',
            }),
            afterRun: async (input) => {
              after.push({
                items: input.items,
                brief: input.brief,
                ...(input.actor.position_id === undefined
                  ? {}
                  : { position_id: input.actor.position_id }),
              })
            },
          },
        }
      : {}),
  })
  runtime.bind({
    appendEvent: (_id: string, e: Record<string, unknown>) => {
      timeline.push(e)
    },
    onRunCompleted: (input: { summary: string }) => {
      summaries.push(input.summary)
    },
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '帮我回这位客户',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const system = (gateway.seen[0] ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
  return { timeline, summaries, after, system }
}

describe('WP320 运行时里的记忆', () => {
  it('提示词带「记忆」那一段；<remember> 不进时间线、交给自动记忆', async () => {
    const { timeline, summaries, after, system } = await runOnce(
      '已经回了，先道了歉。\n<remember>回复美国客户一律用英文</remember>',
      true,
    )
    expect(system).toContain('回客户一律先道歉')
    const reply = timeline.find((e) => e.kind === 'agent_message')
    expect(reply?.text).toBe('已经回了，先道了歉。')
    expect(summaries.join('\n')).not.toContain('<remember>')
    expect(after).toEqual([
      {
        items: [{ text: '回复美国客户一律用英文' }],
        brief: '帮我回这位客户',
        position_id: 'support',
      },
    ])
  })

  it('没装配记忆：提示词里没有那一段，正文原样（与 WP320 之前一样）', async () => {
    const { system, timeline } = await runOnce('好的。', false)
    expect(system).not.toContain('回客户一律先道歉')
    expect(timeline.find((e) => e.kind === 'agent_message')?.text).toBe('好的。')
  })
})
