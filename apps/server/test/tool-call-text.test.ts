/**
 * WP230（10-05 真模型 deepseek-chat 实测）：事项时间线上出现过「[calling 「规矩与政策库」 …]」
 * ——那是模型把工具调用写成了文字、被当成回复贴上来（再过一遍 WP153 的工具名换人话）。
 *
 * 端到端（真 `createRuntime` + 替身模型，direct 档，不联网）：
 * - 假调用文字**不进**时间线；重试一次后正常的话照常进；
 * - 重试还是假的：时间线不贴假文字，事项摘要照实说「模型输出格式异常」。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { TOOL_CALL_TEXT_FAILURE } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => '2026-10-05T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const FAKE = '[calling search_policies {"query":"creator payment terms"}]'

/** 先调一次 search_policies，然后按次序回 `replies`（用完了就一直回最后一条）。 */
function scripted(replies: readonly string[]) {
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
      if (seen.length === 1) {
        return done('', [{ id: 'call_1', name: 'search_policies', input: { query: '付款' } }])
      }
      return done(replies[seen.length - 2] ?? replies.at(-1) ?? '')
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

const roles: RoleStore = {
  effectiveConfig: () => ({
    role_id: 'common.owner',
    grounding: [],
    skills: [],
    browser_scope: [],
  }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '英文来信起草回复',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-05T09:00:00.000Z',
  updated_at: '2026-10-05T09:00:00.000Z',
} as unknown as Matter

async function runOnce(replies: readonly string[]) {
  const gateway = scripted(replies)
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
    roles,
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
    brief: '帮我给这封英文来信起草回复',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { gateway, timeline, summaries }
}

describe('WP230：假调用文字不进事项时间线', () => {
  it('第一次吐假调用、重试后正常：时间线只有正常那句', async () => {
    const { gateway, timeline } = await runOnce([FAKE, 'Draft is ready for your review.'])
    expect(gateway.seen).toHaveLength(3)
    const said = timeline.filter((e) => e.kind === 'agent_message').map((e) => e.text)
    expect(said).toEqual(['Draft is ready for your review.'])
    expect(JSON.stringify(timeline)).not.toContain('calling')
    // 回放给模型的历史里也没有那行文字（调用只在 tool_calls 里）
    const first = gateway.seen[1]?.find((m) => m.role === 'assistant')
    expect(first?.content).toBe('')
    expect(first?.tool_calls?.[0]?.name).toBe('search_policies')
  })

  it('重试还是假的：时间线不贴假文字，摘要照实报格式异常', async () => {
    const { gateway, timeline, summaries } = await runOnce([FAKE])
    expect(gateway.seen).toHaveLength(3)
    expect(timeline.some((e) => e.kind === 'agent_message')).toBe(false)
    expect(JSON.stringify(timeline)).not.toContain('calling')
    expect(summaries).toEqual([`这次没跑完：${TOOL_CALL_TEXT_FAILURE}。`])
  })
})
