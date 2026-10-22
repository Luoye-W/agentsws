/**
 * WP448（docs/109 §4.4）：技术体检交给建站的那件事（带改跳转清单），在三个运行时（stub / direct / dsh）下都能跑起来；
 * direct / dsh 的模型拿得到那份清单原文（「旧路径 → 新路径」那几行）。上游模型是替身，不联网、不花钱。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createSiteHealthService } from '../src/site-health.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-22T10:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const FX = join(import.meta.dirname, '../../../packages/site-core/test/fixtures/wp448')
const O = 'https://shop.example'

/** 跑一次录好的技术体检，拿到交给整站搭建的那份清单。 */
async function dispatchedText(): Promise<{ title: string; text: string }> {
  const pages: Record<string, string> = {
    [`${O}/robots.txt`]: readFileSync(join(FX, 'robots.txt'), 'utf8'),
    [`${O}/`]: readFileSync(join(FX, 'home.html'), 'utf8'),
  }
  const redirects: Record<string, { status: number; location?: string }> = {
    '/collections/old-sale': { status: 301, location: '/collections/sale-2024' },
    '/collections/sale-2024': { status: 301, location: '/collections/sale' },
    '/collections/sale': { status: 200 },
    '/pages/warranty-2023': { status: 404 },
  }
  let got: { title: string; text: string } | undefined
  const svc = createSiteHealthService({
    clock,
    newId: (p) => `${p}_1`,
    origin: async () => O,
    fetch: async (url) => ({
      ok: url in pages,
      status: url in pages ? 200 : 404,
      text: async () => pages[url] ?? '',
    }),
    probe: async (url) => redirects[new URL(url).pathname] ?? { status: 200 },
    shop: async () => undefined,
    handoff: async (input) => {
      if (input.owner === 'site.shopify-build') got = input
      return { matter_id: 'mat_tech' }
    },
  })
  await svc.run()
  if (got === undefined) throw new Error('没派')
  return got
}

const roles = {
  effectiveConfig: () => ({
    role_id: 'site.shopify-build',
    grounding: [],
    skills: [],
    browser_scope: [],
  }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

type Mode = 'stub' | 'direct' | 'dsh'

async function runOnce(mode: Mode, d: { title: string; text: string }): Promise<string[]> {
  const prompts: string[] = []
  const gateway = {
    async complete(req: { messages: { content: unknown }[] }) {
      prompts.push(JSON.stringify(req.messages))
      return {
        text: '好的，我先核对这几条再出改跳转卡。',
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
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: {
      create: async () => ({ id: 'apr_1', state: 'pending' }),
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => DEFAULT,
    hasModel: () => mode !== 'stub',
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as RuntimeOptions)
  const completed: unknown[] = []
  runtime.bind({
    appendEvent: () => undefined,
    onRunCompleted: (x: unknown) => completed.push(x),
    onCard: () => undefined,
  } as unknown as Work)
  const matter = {
    id: 'mat_tech',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: d.title,
    status: 'open',
    role_id: 'site.shopify-build',
    context: { summary: d.text, pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
  } as unknown as Matter
  await runtime.startRun({
    matter,
    brief: d.text,
    actor: { person_id: 'per_1', assignment_id: 'asg_site' },
  } as Parameters<typeof runtime.startRun>[0])
  return prompts
}

describe('WP448 技术体检交给建站的那件事：三个运行时', () => {
  it('stub：跑得完（不调模型）', async () => {
    const d = await dispatchedText()
    expect(d.text).toContain('/collections/old-sale → /collections/sale')
    expect(await runOnce('stub', d)).toEqual([])
  })
  for (const mode of ['direct', 'dsh'] as const)
    it(`${mode}：模型拿得到改跳转清单`, async () => {
      const d = await dispatchedText()
      const prompts = await runOnce(mode, d)
      expect(prompts.length).toBeGreaterThan(0)
      expect(prompts.some((p) => p.includes('/collections/old-sale → /collections/sale'))).toBe(
        true,
      )
    })
})
