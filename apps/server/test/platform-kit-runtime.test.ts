/**
 * WP216（Luoye 10-05「不要搞成不管什么建站的都默认安装那个 skill」）：
 * 平台专属的官方技能与 Dev MCP 工具**只给平台对得上的品牌**——在真运行时装配线上看。
 *
 * 真装配线（`createRuntime` + 真技能库 + `seedDefaultSkill` 种好的自带技能），职责清单取自内置的
 * `site.shopify-theme`（`shopify` 按需），模型那一跳是脚本化的替身上游（direct，不联网）。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  SkillRef,
  StorefrontPlatform,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { loadBundledRole, type RoleStore } from '@agentsws/roles'
import { createSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import { seedDefaultSkill } from '../src/learning.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => '2026-10-05T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }
const THEME = loadBundledRole('site.shopify-theme')
const DOCS_TOOL = 'shopify.docs.search'

type Seen = { messages: ChatMessage[]; tools: string[] }

function scripted(
  calls: { name: string; input?: Record<string, unknown> }[],
): ModelGatewayApi & { seen: Seen[] } {
  const seen: Seen[] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    async complete(req: { messages: ChatMessage[]; tools?: { name: string }[] }) {
      seen.push({ messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) })
      const call = calls[seen.length - 1]
      return call === undefined
        ? done('看过了。')
        : done('', [{ id: `call_${seen.length}`, name: call.name, input: call.input ?? {} }])
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
  } as unknown as ModelGatewayApi & { seen: Seen[] }
}

function fakeRoles(role_id: string, skills: readonly SkillRef[]): RoleStore {
  return {
    effectiveConfig: () => ({ role_id, grounding: [], skills: [...skills], browser_scope: [] }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
}

const matter = (ws: string): Matter =>
  ({
    id: 'mat_1',
    schema_version: 1,
    workspace_id: ws,
    kind: 'task',
    title: '首页加一个耳机的卖点分区',
    status: 'open',
    context: { summary: '', pinned: [] },
    created_at: '2026-10-05T09:00:00.000Z',
    updated_at: '2026-10-05T09:00:00.000Z',
  }) as unknown as Matter

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => ('text' in p ? String(p.text) : '')).join('')

/** 一个品牌的运行时（平台每次现取 `platform()`）。 */
async function brandRuntime(ws: string, platform: () => StorefrontPlatform | undefined) {
  const skills = createSkills({ clock, random: () => 0.5 })
  await seedDefaultSkill(skills, ws)
  return async (calls: { name: string; input?: Record<string, unknown> }[]) => {
    const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
    const gateway = scripted(calls)
    const options: RuntimeOptions = {
      workspace_id: ws,
      clock,
      random: () => 0.5,
      seed: 42,
      env: {},
      models: gateway,
      approvals: {
        create: async () => ({ id: 'apv_1' }),
      } as unknown as RuntimeOptions['approvals'],
      roles: fakeRoles(THEME.id, THEME.skills),
      appendEvent: (e) => events.push(e),
      prefer: 'direct',
      modelRef: () => MODEL,
      skills: skills.registry,
      storefrontPlatform: platform,
      devTools: {
        toolNames: () => [DOCS_TOOL],
        call: async () => ({ text: 'Liquid 文档一段' }),
      },
    }
    const runtime = createRuntime(options)
    await runtime.startRun({
      matter: matter(ws),
      brief: '首页加一个耳机的卖点分区',
      actor: { person_id: 'per_1', assignment_id: 'asg_1' },
    } as Parameters<typeof runtime.startRun>[0])
    const results = events
      .filter((e) => e.type === 'tool.result')
      .map((e) => e.payload as { status: string; reason?: string })
    const persona = textOf(gateway.seen[0]?.messages[0] as ChatMessage)
    return { gateway, results, persona, tools: gateway.seen[0]?.tools ?? [] }
  }
}

describe('WP216 平台专属：网页模板这条职责', () => {
  it('职责清单里挂的是官方 `shopify`，按需', () => {
    expect(THEME.skills).toContainEqual({ name: 'shopify', tier: 'open', load: 'on_demand' })
  })

  it('Shopify 品牌：索引里有它、read_skill 读得到、Dev MCP 的工具在工具面', async () => {
    const run = await brandRuntime('ws_shop', () => 'shopify')
    const { persona, tools, results, gateway } = await run([
      { name: 'read_skill', input: { name: 'shopify' } },
    ])
    expect(persona).toMatch(/- shopify：Build anything on Shopify/)
    expect(tools).toContain('read_skill')
    expect(tools).toContain(DOCS_TOOL)
    expect(results.map((r) => r.status)).toEqual(['ok'])
    expect(gateway.seen[1]?.messages.map(textOf).join('\n')).toContain('## 官方参考：liquid')
  })

  it('Fable 10-05：没设平台（也推断不出）= 一样都没有，不按 Shopify 兜底', async () => {
    const run = await brandRuntime('ws_old', () => undefined)
    const { persona, tools } = await run([])
    expect(persona).not.toMatch(/- shopify：/)
    expect(tools).not.toContain(DOCS_TOOL)
  })

  for (const platform of ['woocommerce', 'other', 'none'] as const) {
    it(`${platform} 品牌：技能不进索引、读不到，Dev MCP 工具不在工具面`, async () => {
      const run = await brandRuntime('ws_woo', () => platform)
      const { persona, tools, results, gateway } = await run([
        { name: 'read_skill', input: { name: 'shopify' } },
      ])
      expect(persona).not.toMatch(/- shopify：/)
      expect(tools).not.toContain('read_skill')
      expect(tools).not.toContain(DOCS_TOOL)
      expect(results[0]?.status).not.toBe('ok')
      expect(gateway.seen.map((s) => s.messages.map(textOf).join('\n')).join('\n')).not.toContain(
        '## 官方参考：liquid',
      )
    })
  }

  it('改了平台即时生效：同一个运行时，下一次运行就跟着变（来回各一次）', async () => {
    let platform: StorefrontPlatform = 'shopify'
    const run = await brandRuntime('ws_switch', () => platform)
    expect((await run([])).tools).toContain(DOCS_TOOL)
    platform = 'woocommerce'
    const off = await run([])
    expect(off.tools).not.toContain(DOCS_TOOL)
    expect(off.persona).not.toMatch(/- shopify：/)
    platform = 'shopify'
    const on = await run([])
    expect(on.tools).toContain(DOCS_TOOL)
    expect(on.persona).toMatch(/- shopify：/)
  })

  it('两个品牌并存互不影响：A 是 Shopify、B 是 WooCommerce，各按各的档案', async () => {
    const a = await brandRuntime('ws_a', () => 'shopify')
    const b = await brandRuntime('ws_b', () => 'woocommerce')
    const [ra, rb] = await Promise.all([a([]), b([])])
    expect(ra.persona).toMatch(/- shopify：/)
    expect(rb.persona).not.toMatch(/- shopify：/)
    expect(ra.tools).toContain(DOCS_TOOL)
    expect(rb.tools).not.toContain(DOCS_TOOL)
  })
})
