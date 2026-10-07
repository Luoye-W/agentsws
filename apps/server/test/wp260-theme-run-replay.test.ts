/**
 * WP260 回放：10-07 真机 ci.16（Rollout 建站「Shopify 网页模板」，搭英文首页、推未发布主题给预览）。
 *
 * 真装配线（`createRuntime` direct 档 + 真主题工具执行器 + 真主题工坊），只换掉三样：模型是下面这个**会看
 * 历史的假模型**、`shopify theme …` 是进程内替身、起底包是 `fixtures/wp260-theme.ts`（长短照真主题造的占位）。
 * 不联网、不调真模型、不碰真店。
 *
 * 假模型照真机那一轮的形状走：起底 → 一回合读三个文件 → 说一句「现在读…」（ci.16 收工的那句）→ 接着读 →
 * 都看清了就写 templates/index.json 与 settings_data → 检查 → 推未发布 → 交代结果。**它只认自己眼前看得见的**：
 * 一份文件的尾巴（`END-OF-…`）不在历史里（被截断、被压成占位），就再读一次——这正是 ci.16 反复读的原因。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ChatMessage,
  type Completion,
  type Matter,
  type MatterEvent,
  type ModelRef,
  platformKitOf,
  type RunEvent,
  type RunRequest,
  type ToolDef,
} from '@agentsws/contracts'
import { estimateInputTokens, type ModelGatewayApi } from '@agentsws/model-gateway'
import { loadBundledRole, type RoleStore } from '@agentsws/roles'
import { createDirectRuntime } from '@agentsws/runtime-direct'
import { THEME_TOOL_NAMES, UNFINISHED_STEP } from '@agentsws/stand-ins'
import type { Work } from '@agentsws/work'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRuntime, type RuntimeOptions, THEME_PRODUCE } from '../src/runtime.js'
import { createSiteTheme } from '../src/site-theme.js'
import { fakeThemeBase, themeCliStandIn } from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'
import { wp260ThemeFiles } from './fixtures/wp260-theme.js'

const SHOP = '6suegp-md.myshopify.com'
const MODEL: ModelRef = { provider: 'stub', model: 'replay-ci16', region: 'cn' }
const CI16 = '现在读首页模板、FAQ/容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

/** 模型要「看清」的东西：读什么、看见哪个记号才算看全了。 */
const NEEDS: { input: Record<string, unknown>; marker: string }[] = [
  { input: { path: 'AGENTS.md' }, marker: 'END-OF-AGENTS' },
  { input: { path: 'CATALOG.json' }, marker: '- section faq:' },
  { input: { path: 'recipes/compose-page.md' }, marker: 'END-OF-RECIPE' },
  {
    input: { path: 'CATALOG.json', ids: ['hero', 'faq', 'container', 'newsletter'] },
    marker: '"id":"newsletter"',
  },
  { input: { path: 'templates/index.json' }, marker: 'END-OF-INDEX' },
  { input: { path: 'config/settings_data.json' }, marker: 'END-OF-SETTINGS' },
  { input: { path: 'sections/hero.liquid' }, marker: 'END-OF-HERO' },
  { input: { path: 'sections/faq.liquid' }, marker: 'END-OF-FAQ' },
]

const NEW_INDEX = JSON.stringify({
  sections: {
    hero: { type: 'hero', settings: { heading: 'Ride further with Rollout' } },
    featured: { type: 'featured-product', settings: {} },
    story: { type: 'rich-text', settings: { heading: 'Our story' } },
    faq: { type: 'faq', settings: { heading: 'FAQ' } },
    newsletter: { type: 'newsletter', settings: { heading: 'Stay in the loop' } },
  },
  order: ['hero', 'featured', 'story', 'faq', 'newsletter'],
})

/** 照 ci.16 的形状走、只认眼前看得见的假模型；记下每一次送进来的历史有多大。 */
function ci16Model() {
  const stats = { calls: 0, inputTokens: 0, peakHistory: 0 }
  let seq = 0
  const reply = (text: string, calls: { name: string; input: Record<string, unknown> }[] = []) => {
    const tool_calls = calls.map((c) => ({ id: `call_${++seq}`, name: c.name, input: c.input }))
    return { text, ...(tool_calls.length === 0 ? {} : { tool_calls }) }
  }
  const decide = (messages: ChatMessage[], tools: ToolDef[]) => {
    const seen = messages
      .filter((m) => m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const called = messages.flatMap((m) => m.tool_calls ?? [])
    const did = (name: string) => called.some((c) => c.name === name)
    if (!did('theme_init_from_base'))
      return reply('我先从 agentsws-theme 起底，再读它给 AI 的规矩与目录。', [
        { name: 'theme_init_from_base', input: {} },
      ])
    const pending = NEEDS.filter((n) => !seen.includes(n.marker)).map((n) => {
      // 长文件看到了前一段：接着读下一段（抬头里写着 offset；围栏做过 NFKC，全角括号会变半角）
      const path = String(n.input.path)
      const next = new RegExp(
        `主题文件 ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[（(]第[^）)]*offset=(\\d+)`,
      ).exec(seen)?.[1]
      return next === undefined ? n.input : { ...n.input, offset: Number(next) }
    })
    if (pending.length > 0) {
      const reads = called.filter((c) => c.name === 'theme_read_file').length
      // 读过七八个文件之后说一句「现在读…」、不带工具调用（ci.16 收工的那一句）
      if (reads >= 8 && !messages.some((m) => m.role === 'assistant' && m.content === CI16))
        return reply(CI16)
      // 真机那一轮还去查了店里的商品（店铺没连）：摆着就会去调
      const product = tools.some((t) => t.name === 'get_product') && !did('get_product')
      return reply('', [
        ...pending.slice(0, 3).map((input) => ({ name: 'theme_read_file', input })),
        ...(product ? [{ name: 'get_product', input: { query: 'featured' } }] : []),
      ])
    }
    if (!did('theme_write_file'))
      return reply('', [
        { name: 'theme_write_file', input: { path: 'templates/index.json', content: NEW_INDEX } },
        {
          name: 'theme_write_file',
          input: {
            path: 'config/settings_data.json',
            content: JSON.stringify({ current: { color_scheme: 'scheme-2' } }),
          },
        },
      ])
    if (!did('theme_check')) return reply('', [{ name: 'theme_check', input: {} }])
    if (!did('theme_push_unpublished'))
      return reply('', [{ name: 'theme_push_unpublished', input: { name: 'Rollout 首页 v1' } }])
    return reply(
      '预览好了：首页换成横幅、主推（占位，等你在编辑器里挑商品）、品牌故事、FAQ、订阅五块，推成了一份未发布主题「Rollout 首页 v1」，线上没动。不满意就不发布，原来的首页一个字没变。',
    )
  }
  const gateway = {
    async complete(req: { messages: ChatMessage[]; tools?: ToolDef[] }): Promise<Completion> {
      const tools = req.tools ?? []
      const tokens = estimateInputTokens(req.messages, tools, 4)
      stats.calls += 1
      stats.inputTokens += tokens
      stats.peakHistory = Math.max(stats.peakHistory, tokens)
      return {
        ...decide(req.messages, tools),
        usage: { input_tokens: tokens, output_tokens: 200, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'replay-ci16' },
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
  } as unknown as ModelGatewayApi
  return { gateway, stats }
}

let dir: string
let previews: { matter: string; url: string }[]
let cli: ReturnType<typeof themeCliStandIn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp260-replay-'))
  previews = []
  cli = themeCliStandIn({ shop: SHOP })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function themeExecutor() {
  const base = fakeThemeBase(wp260ThemeFiles())
  const module = createSiteTheme({
    workspace_id: 'ws_rollout',
    clock: { now: () => new Date().toISOString() },
    dataDir: join(dir, 'data'),
    cliSpec: () => spec,
    probe: async () => ({
      installed: true,
      node_ok: true,
      min_node_major: 20,
      checked_at: new Date().toISOString(),
      source: 'app' as const,
      version: '4.8.5',
    }),
    loggedIn: () => true,
    invocation: () => ({ command: 'shopify', prefix: [] }),
    connectedShops: () => [SHOP],
    run: cli.run,
    fetch: base.fetch,
    base: base.pin,
    ledger: { stage: async () => ({ ok: false }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    notePreview: (matter, input) => previews.push({ matter, url: input.url }),
  })
  return createThemeToolExecutor({ module: async () => module })
}

const role = loadBundledRole('site.shopify-theme')
const roles = {
  effectiveConfig: () => ({
    role_id: role.id,
    grounding: role.grounding,
    skills: [],
    browser_scope: [],
    persona: role.persona,
  }),
  roles: { get: () => ({ thresholds: {} }) },
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_01M4AYRX8G7V90KDZ3R41',
  schema_version: 1,
  workspace_id: 'ws_rollout',
  kind: 'task',
  title: '用 agentsws-theme 搭英文首页，推未发布主题给预览',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-07T09:00:00.000Z',
  updated_at: '2026-10-07T09:00:00.000Z',
} as unknown as Matter
const BRIEF =
  '用 agentsws-theme 搭英文首页（横幅 / 主推占位 / 品牌故事 / FAQ / 订阅），推未发布主题给预览'

const readKey = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  return `${String(i.path)}|${String(i.offset ?? 0)}|${Array.isArray(i.ids) ? i.ids.join(',') : ''}`
}

describe('WP260 回放 ci.16：网页模板的运行真把活干完', () => {
  it('起底 → 每个文件只读一次 → 「现在读…」被续跑 → 写模板与设置 → 检查 → 推未发布 → 预览好了', async () => {
    const { gateway, stats } = ci16Model()
    const events: RunEvent[] = []
    const timeline: (Partial<MatterEvent> & { kind: string; text: string })[] = []
    let request: RunRequest | undefined
    const runtime = createRuntime({
      workspace_id: 'ws_rollout',
      clock: { now: () => new Date().toISOString() },
      random: () => 0.5,
      seed: 42,
      env: {},
      models: gateway,
      approvals: {
        create: async () => ({ id: 'apv_1' }),
      } as unknown as RuntimeOptions['approvals'],
      roles,
      appendEvent: (e) => {
        events.push({ type: e.type, ...(e.payload as object) } as RunEvent)
      },
      prefer: 'direct',
      modelRef: () => MODEL,
      // 生产里记录源只执行它真接上的工具：订单 / 商品那几个店铺没连就不摆
      source: { executes: () => false },
      themeTools: themeExecutor(),
      aroundRun: async (_actor, fn) => fn(),
    })
    runtime.bind({
      appendEvent: (_id: string, e: { kind: string; text: string }) => {
        timeline.push(e)
      },
      onRunCompleted: () => undefined,
    } as unknown as Work)
    const realRun = runtime.adapter.run.bind(runtime.adapter)
    runtime.adapter.run = (req, sink, signal) => {
      request = req
      return realRun(req, sink, signal)
    }
    await runtime.startRun({
      matter,
      brief: BRIEF,
      actor: { person_id: 'per_owner', assignment_id: 'asg_theme' },
    } as Parameters<typeof runtime.startRun>[0])

    const calls = events.flatMap((e) => (e.type === 'tool.call' ? [e] : []))
    const names = calls.map((c) => c.tool)
    // 店铺没连：商品那几个工具压根不摆，也就不会被调
    expect(names).not.toContain('get_product')
    // 每个文件（同一段）只读一次
    const reads = calls.filter((c) => c.tool === 'theme_read_file').map((c) => readKey(c.input))
    expect(reads.length).toBeGreaterThanOrEqual(NEEDS.length)
    expect(new Set(reads).size).toBe(reads.length)
    // 「现在读…」那一句被续跑了一次（不是收工）
    expect(events.filter((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)).toHaveLength(
      1,
    )
    // 顺序：起底在前；写 → 检查 → 推，最后一个工具是推未发布
    expect(names[0]).toBe('theme_init_from_base')
    expect(names.slice(-4)).toEqual([
      'theme_write_file',
      'theme_write_file',
      'theme_check',
      'theme_push_unpublished',
    ])
    expect(cli.calls.some((c) => c[1] === 'push' && c.includes('--unpublished'))).toBe(true)
    expect(cli.calls.some((c) => c[1] === 'publish')).toBe(false)
    // 「预览好了」：时间线上那一条（主题工坊记的）+ 模型的交代
    expect(previews).toHaveLength(1)
    expect(previews[0]?.url).toContain('preview_theme_id=')
    const said = timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(said).toContain('预览好了')
    expect(said).not.toContain('现在读')
    // 没有预算事件、不压历史（4.8 万阈值一轮用不到）、正常收尾
    expect(events.some((e) => e.type === 'budget.exhausted')).toBe(false)
    expect(events.some((e) => e.type === 'progress' && e.step === 'compact')).toBe(false)
    expect(events.some((e) => e.type === 'run.completed')).toBe(true)
    // 这次运行带的是网页模板那一套（produce / 回合 40），工具面只有主题工具
    expect(request?.produce).toEqual(THEME_PRODUCE)
    expect(request?.budget.max_turns).toBe(40)
    expect(request?.tools.allow).toEqual([...THEME_TOOL_NAMES].sort())
    expect(request?.persona.sections.some((s) => s.id === 'theme_work')).toBe(true)
    // 一轮下来的用量（约 16 万 / 峰值 2.2 万）：峰值远低于压缩阈值，累计在预算的一半以内
    expect(stats.peakHistory).toBeLessThan(THEME_PRODUCE.compact_at_tokens)
    expect(stats.inputTokens).toBeLessThan((request?.budget.max_tokens ?? 0) / 2)
  }, 60_000)

  it('对照：照 ci.16 当时的跑法（没有 produce：1.2 万 token 就压成空占位、摆着商品工具、只说不做就收工）——反复读、一个字没改', async () => {
    const { gateway } = ci16Model()
    const tools = themeExecutor()
    const events: RunEvent[] = []
    const direct = createDirectRuntime({
      gateway,
      clock: { now: () => new Date().toISOString() },
      seed: 42,
      executeTool: async (call) =>
        THEME_TOOL_NAMES.includes(call.name)
          ? tools(call)
          : { status: 'error', reason: 'not_connected：Shopify 店铺还没连上。' },
    })
    const allow = [
      ...THEME_TOOL_NAMES,
      'get_order',
      'get_product',
      'list_orders',
      'search_policies',
    ]
    const req = {
      id: 'run_ci16',
      schema_version: 1,
      workspace_id: 'ws_rollout',
      kind: 'work_item',
      actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id: 'site.shopify-theme' },
      work_item: { id: matter.id, conversation_id: matter.id, role_id: 'site.shopify-theme' },
      trigger: { event_id: 'run_ci16', source: 'manual' },
      context: [],
      grounding: [],
      tools: { allow: allow.sort(), connect_token: '', side_effect_policy: 'executor' },
      skills: [],
      persona: { sections: [{ id: 'role', name: 'role', order: 20, text: BRIEF }] },
      // ci.16 当时：Fable 放宽过的 40 万 token / 60 次，但回合与压缩都是缺省
      budget: { max_tokens: 400_000, max_tool_calls: 60, max_seconds: 1200, max_cost_base: 5 },
      expectations: { outputs: ['draft', 'answer'], must_stage_if_change_requested: false },
      runtime: { preset: 'site.shopify-theme', profile: 'server', plugins: [], model: MODEL },
      idempotency_key: 'idem_ci16',
    } as RunRequest
    const result = await direct.run(req, (e) => events.push(e), new AbortController().signal)
    const calls = events.flatMap((e) => (e.type === 'tool.call' ? [e] : []))
    const reads = calls.filter((c) => c.tool === 'theme_read_file').map((c) => readKey(c.input))
    // 同一份文件读了不止一次（压成空占位之后它看不见了），也去查了商品（店铺没连）
    expect(new Set(reads).size).toBeLessThan(reads.length)
    expect(calls.some((c) => c.tool === 'get_product')).toBe(true)
    expect(
      events.filter((e) => e.type === 'progress' && e.step === 'compact').length,
    ).toBeGreaterThanOrEqual(2)
    // 一个字没写、没推；那一句「现在读…」被当成答复、照「做完了」收——就是 ci.16
    expect(calls.some((c) => c.tool === 'theme_write_file')).toBe(false)
    expect(calls.some((c) => c.tool === 'theme_push_unpublished')).toBe(false)
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual([{ kind: 'answer', text: CI16 }])
  }, 60_000)
})
