/**
 * WP381：体检派给网站运营的那件事，在三个运行时（stub / direct / dsh）下都能跑起来；direct / dsh 的模型
 * 拿得到那份不一致清单（原文进上下文）。上游模型是替身，不联网、不花钱。
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

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const FX = join(import.meta.dirname, '../../../packages/site-core/test/fixtures/wp381')
const ORIGIN = 'https://nordvolt.example'

/** 跑一次录好的体检，拿到派给网站运营的那份清单。 */
async function dispatchedText(): Promise<{ title: string; text: string }> {
  const pages: Record<string, string> = {
    [`${ORIGIN}/robots.txt`]: readFileSync(join(FX, 'robots.txt'), 'utf8'),
    [`${ORIGIN}/products/power-bank-20000`]: readFileSync(join(FX, 'product-raw.html'), 'utf8'),
  }
  let got: { title: string; text: string } | undefined
  const svc = createSiteHealthService({
    clock,
    newId: (p) => `${p}_1`,
    origin: async () => ORIGIN,
    fetch: async (url) => ({
      ok: url in pages,
      status: url in pages ? 200 : 404,
      text: async () => pages[url] ?? '',
    }),
    shop: async () => ({
      via: 'stand_in',
      store: 'nordvolt.myshopify.com',
      query: async <T>() =>
        ({
          shop: { name: 'NordVolt', currencyCode: 'USD' },
          products: {
            nodes: [
              {
                id: 'gid://shopify/Product/1001',
                title: 'NordVolt Power Bank 20000',
                handle: 'power-bank-20000',
                variants: { nodes: [{ id: 'v1', price: '49.99', availableForSale: true }] },
              },
            ],
          },
        }) as T,
    }),
    dispatch: async (input) => {
      got = input
      return { matter_id: 'mat_shr' }
    },
  })
  await svc.run()
  if (got === undefined) throw new Error('没派')
  return got
}

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.store', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

type Mode = 'stub' | 'direct' | 'dsh'

async function runOnce(mode: Mode, d: { title: string; text: string }): Promise<string[]> {
  const prompts: string[] = []
  const gateway = {
    async complete(req: { messages: { content: unknown }[] }) {
      prompts.push(JSON.stringify(req.messages))
      return {
        text: '好的，我先读这件商品再出改动卡。',
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
    id: 'mat_shr',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: d.title,
    status: 'open',
    role_id: 'dtc.store',
    context: { summary: d.text, pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
  } as unknown as Matter
  await runtime.startRun({
    matter,
    brief: d.text,
    actor: { person_id: 'per_1', assignment_id: 'asg_store' },
  } as Parameters<typeof runtime.startRun>[0])
  return prompts
}

describe('WP381 派给网站运营的那件事：三个运行时', () => {
  it('stub：跑得完（不调模型）', async () => {
    const d = await dispatchedText()
    expect(d.text).toContain('结构化数据的价格写的是 44.99，后台是 49.99')
    expect(await runOnce('stub', d)).toEqual([])
  })
  for (const mode of ['direct', 'dsh'] as const)
    it(`${mode}：模型拿得到不一致清单`, async () => {
      const d = await dispatchedText()
      const prompts = await runOnce(mode, d)
      expect(prompts.length).toBeGreaterThan(0)
      expect(prompts.some((p) => p.includes('44.99'))).toBe(true)
    })
})
