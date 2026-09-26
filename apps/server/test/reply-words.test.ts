/**
 * WP153（09-26 真账号冒烟 §1）：**给人看的回复不露工具名**。
 *
 * 两道：① 提示词公共段（每条职责都带）叫模型别提工具名、函数名、内部 id；② 万一还是说了，
 * 进时间线之前按统一的「工具名 → 人话」表换掉。事项摘要也是这件事本身，不是「查了退货政策」。
 *
 * 真 `createRuntime` + 替身模型（direct 档），不联网。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => '2026-09-26T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

/** 先调一次 search_policies，然后回冒烟里那句原话。 */
function scripted(reply: string) {
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
        ? done('', [{ id: 'call_1', name: 'search_policies', input: { query: '岗位' } }])
        : done(reply)
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

const roles = (role_id: string): RoleStore =>
  ({
    effectiveConfig: () => ({ role_id, grounding: [], skills: [], browser_scope: [] }),
    assignments: { get: () => undefined },
  }) as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '有哪些岗位和连接',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-26T09:00:00.000Z',
  updated_at: '2026-09-26T09:00:00.000Z',
} as unknown as Matter

async function runOnce(role_id: string, reply: string) {
  const gateway = scripted(reply)
  const timeline: { kind: string; text: string }[] = []
  const summaries: string[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles: roles(role_id),
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
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
    brief: '帮我看看有哪些岗位和连接，最该先处理哪三件事',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { gateway, timeline, summaries }
}

const SMOKE = '我用 `search_policies` 查了三轮，**没找到**岗位清单。\n- 建议先连 GA4'

describe('WP153：回复不露工具名', () => {
  it('提示词公共段：每条职责都带「不提工具名」那一句', async () => {
    for (const role of ['common.owner', 'dtc.support', 'kol.youtube']) {
      const { gateway } = await runOnce(role, '好的。')
      const system = (gateway.seen[0] ?? [])
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n')
      expect(system).toContain('不提工具名、函数名、内部 id')
    }
  })

  it('兜底：模型还是说了工具名，时间线上换成人话；markdown 原样留给界面渲染', async () => {
    const { timeline } = await runOnce('common.owner', SMOKE)
    const reply = timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toBe('我用「规矩与政策库」查了三轮，**没找到**岗位清单。\n- 建议先连 GA4')
    expect(reply).not.toContain('search_policies')
  })

  it('摘要是这件事本身（回复第一句，去 markdown），不是「查了退货政策」', async () => {
    const { summaries } = await runOnce('common.owner', SMOKE)
    expect(summaries).toEqual(['我用「规矩与政策库」查了三轮，没找到岗位清单。'])
  })
})
