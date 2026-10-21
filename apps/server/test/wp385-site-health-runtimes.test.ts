/**
 * WP385：`query_site_health` 在三个运行时（stub / direct / dsh）下都摆得出来、调得通，而且**只读**：
 * 不出审批卡、不产生 staged / applied。只给店铺管理、SEO 与 GEO；别的职责工具面里没有它。
 * 上游模型是替身（direct / dsh 第一轮回一个工具调用，第二轮回一段话），不联网、不花钱。
 */
import type { Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSiteHealthService } from '../src/site-health.js'
import { createSiteHealthToolExecutor } from '../src/site-health-tools.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-18T09:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const ORIGIN = 'https://nordvolt.example'

async function checkedService() {
  const svc = createSiteHealthService({
    clock,
    newId: (p) => `${p}_1`,
    origin: async () => ORIGIN,
    fetch: async (url) =>
      String(url) === `${ORIGIN}/robots.txt`
        ? { ok: true, status: 200, text: async () => 'User-agent: PerplexityBot\nDisallow: /\n' }
        : { ok: false, status: 404, text: async () => '' },
    shop: async () => undefined,
  })
  await svc.run()
  return svc
}

type Mode = 'stub' | 'direct' | 'dsh'

async function runOnce(mode: Mode, role_id: string) {
  const svc = await checkedService()
  const executor = createSiteHealthToolExecutor({ service: () => svc, waitMs: 1_000 })
  const executed = vi.fn(executor)
  const prompts: string[] = []
  let calls = 0
  const gateway = {
    async complete(req: { messages: unknown[]; tools?: { name: string }[] }) {
      const raw = JSON.stringify(req)
      prompts.push(raw)
      calls += 1
      const offered = raw.includes('query_site_health')
      return {
        text: calls === 1 && offered ? '' : '我看了体检：PerplexityBot 被挡了。',
        ...(calls === 1 && offered
          ? { tool_calls: [{ id: 'c1', name: 'query_site_health', input: { part: 'crawlers' } }] }
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
    siteHealthTools: executed,
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
    title: '我们站 AI 爬虫进得来吗？',
    status: 'open',
    role_id,
    context: {
      summary: '我们站 AI 爬虫进得来吗？',
      pinned: [],
      participants: [],
      last_activity: clock.now(),
    },
    created_at: clock.now(),
    updated_at: clock.now(),
  } as unknown as Matter
  await runtime.startRun({
    matter,
    brief: '我们站 AI 爬虫进得来吗？',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { prompts, executed, create, said }
}

describe('WP385 query_site_health：三个运行时', () => {
  it('stub：问「AI 爬虫进得来吗」→ 读体检结论、照实说；只读不出卡', async () => {
    const { prompts, executed, create, said } = await runOnce('stub', 'dtc.seo')
    expect(prompts).toEqual([])
    expect(executed).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(said.join('\n')).toContain('PerplexityBot')
  })
  for (const mode of ['direct', 'dsh'] as const)
    it(`${mode}：工具面里有它（参数只有可选的 part），模型调了拿到被挡的爬虫；只读不出卡`, async () => {
      const { prompts, executed, create } = await runOnce(mode, 'dtc.store')
      expect(prompts[0]).toContain('query_site_health')
      expect(prompts[0]).toContain('"part"')
      expect(executed).toHaveBeenCalledTimes(1)
      expect(executed.mock.calls[0]?.[0].input).toMatchObject({ part: 'crawlers' })
      expect(prompts.slice(1).some((p) => p.includes('PerplexityBot'))).toBe(true)
      expect(create).not.toHaveBeenCalled()
    })
  it('别的职责（客服）工具面里没有它', async () => {
    const { prompts, executed } = await runOnce('direct', 'support.inbox')
    expect(prompts[0]).not.toContain('query_site_health')
    expect(executed).not.toHaveBeenCalled()
  })
})
