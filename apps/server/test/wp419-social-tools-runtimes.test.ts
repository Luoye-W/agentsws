/**
 * WP419（自查 R10 / S3）：社媒发帖 / Reddit 起草四个工具在三个运行时（stub / direct / dsh）下都摆得出来、调得通；
 * 只按职责摆（Reddit 两条摆 Reddit 那两个、社媒内容账号摆发帖那两个、客服没有）。上游模型是替身，不联网、不花钱；
 * 执行器是替身（真执行器在 `wp419-social-tools-server.test.ts` 里接真服务测）。
 */
import type { Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { ToolExecutor } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-18T09:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }

const fakeTools: ToolExecutor = async (call) => {
  const name = call.name.includes('.') ? call.name.slice(call.name.lastIndexOf('.') + 1) : call.name
  if (name === 'list_reddit_pending')
    return {
      status: 'ok',
      data: {
        rows: [
          {
            item_id: 'rw_1',
            source: 'inbox',
            author: 'alice',
            subreddit: 'ivraxr',
            text: 'does it work with iPhone?',
            state: 'waiting',
          },
        ],
        counts: { waiting: 1, card_out: 0, conflict: 0 },
      },
    }
  if (name === 'list_social_posts')
    return {
      status: 'ok',
      data: {
        accounts: [{ account_id: 'sa_1', name: 'Nordvolt', channel: 'facebook' }],
        posts: [],
      },
    }
  return { status: 'ok', data: { staged: true, approval_item_id: 'apr_9' } }
}

type Mode = 'stub' | 'direct' | 'dsh'

async function runOnce(
  mode: Mode,
  role_id: string,
  brief: string,
  tool: string,
  toolInput: Record<string, unknown>,
) {
  const executed = vi.fn(fakeTools)
  const prompts: string[] = []
  let calls = 0
  const gateway = {
    async complete(req: { messages: unknown[]; tools?: { name: string }[] }) {
      const raw = JSON.stringify(req)
      prompts.push(raw)
      calls += 1
      const offered = raw.includes(tool)
      return {
        text: calls === 1 && offered ? '' : '出了卡，在「要你处理」里。',
        ...(calls === 1 && offered
          ? { tool_calls: [{ id: 'c1', name: tool, input: toolInput }] }
          : {}),
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: DEFAULT,
        static_prefix_hash: 'p',
      } satisfies Completion
    },
    async embed() {
      return { vectors: [], usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 } }
    },
    usage: () => ({}),
    budget: () => ({}),
  } as unknown as ModelGatewayApi
  const roles = {
    effectiveConfig: () => ({ role_id, grounding: [], skills: [], browser_scope: [] }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
  const create = vi.fn(async () => ({ id: 'apr_1', state: 'pending' }))
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => DEFAULT,
    hasModel: () => mode !== 'stub',
    socialWorkTools: executed,
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as RuntimeOptions)
  const said: string[] = []
  runtime.bind({
    appendEvent: (_m: string, e: { kind: string; text: string }) => {
      if (e.kind === 'agent_message') said.push(e.text)
    },
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  const matter = {
    id: 'mat_q',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: brief,
    status: 'open',
    role_id,
    context: {
      summary: brief,
      pinned: [],
      participants: [],
      last_activity: clock.now(),
    },
    created_at: clock.now(),
    updated_at: clock.now(),
  } as unknown as Matter
  await runtime.startRun({
    matter,
    brief,
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { prompts, executed, create, said }
}

describe('WP419 社媒 / Reddit 干活工具：三个运行时', () => {
  it('stub：Reddit「有哪些评论等着回」→ 列出来、给等着的那条出回复卡', async () => {
    const { prompts, executed, said } = await runOnce(
      'stub',
      'social.reddit',
      '有哪些评论等着回',
      'list_reddit_pending',
      {},
    )
    expect(prompts).toEqual([])
    expect(executed.mock.calls.map((c) => c[0].name)).toEqual([
      'list_reddit_pending',
      'stage_reddit_write',
    ])
    expect(executed.mock.calls[1]?.[0].input).toMatchObject({ mode: 'reply', item_id: 'rw_1' })
    expect(said.join('\n')).toContain('出了 1 张卡')
  })
  it('stub：外部版块「在这个版里发一条」→ 按原话当要点出一张发帖卡', async () => {
    const { executed } = await runOnce(
      'stub',
      'pr.reddit',
      '在 r/ivraxr 这个版里发一条：2.2 固件修好了续航',
      'stage_reddit_write',
      {},
    )
    expect(executed.mock.calls[0]?.[0]).toMatchObject({
      name: 'stage_reddit_write',
      input: { mode: 'post', subreddit: 'ivraxr' },
    })
    expect(String(executed.mock.calls[0]?.[0].input.points)).toContain('2.2 固件')
  })
  it('stub：FB「排下周的内容」→ 看一眼日历、排三条', async () => {
    const { executed, said } = await runOnce(
      'stub',
      'social.facebook',
      '排下周的内容',
      'list_social_posts',
      {},
    )
    expect(executed.mock.calls.map((c) => c[0].name)).toEqual([
      'list_social_posts',
      'stage_social_post',
      'stage_social_post',
      'stage_social_post',
    ])
    expect(said.join('\n')).toContain('出了 3 张卡')
  })
  for (const mode of ['direct', 'dsh'] as const) {
    it(`${mode}：Reddit 职责工具面里有 stage_reddit_write，模型调得通`, async () => {
      const { prompts, executed } = await runOnce(
        mode,
        'pr.reddit',
        '在这个版里发一条',
        'stage_reddit_write',
        {
          mode: 'post',
          points: '2.2 fixes battery drain',
        },
      )
      expect(prompts[0]).toContain('stage_reddit_write')
      expect(prompts[0]).toContain('list_reddit_pending')
      expect(prompts[0]).not.toContain('stage_social_post')
      expect(executed).toHaveBeenCalledTimes(1)
      expect(executed.mock.calls[0]?.[0].input).toMatchObject({ mode: 'post' })
    })
    it(`${mode}：FB 职责工具面里有 stage_social_post，模型调得通`, async () => {
      const { prompts, executed } = await runOnce(
        mode,
        'social.facebook',
        '起草一条',
        'stage_social_post',
        {
          body: 'Weekend checklist',
          scheduled_at: '2026-10-19T02:00:00.000Z',
        },
      )
      expect(prompts[0]).toContain('stage_social_post')
      expect(prompts[0]).not.toContain('stage_reddit_write')
      expect(executed).toHaveBeenCalledTimes(1)
    })
  }
  it('客服工具面里没有这几个', async () => {
    const { prompts, executed } = await runOnce(
      'direct',
      'support.inbox',
      '有哪些评论等着回',
      'list_reddit_pending',
      {},
    )
    expect(prompts[0]).not.toContain('list_reddit_pending')
    expect(prompts[0]).not.toContain('stage_social_post')
    expect(executed).not.toHaveBeenCalled()
  })
})
