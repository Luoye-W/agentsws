/**
 * WP179（Luoye 09-29「官方功能优先」）：服务端**挂了网页工具的运行改走 dsh 运行时**
 * （照 WP148 浏览器那条分流的写法——官方 `web_search` / `web_fetch` 只在 dsh 那棵树上挂）。
 *
 * | 场景 | 钉什么 |
 * |---|---|
 * | 没挂网页工具（职责 YAML 没有 `web_tools` / 服务端没接网页那一层） | 仍走 direct，事件序列与改前**逐字相同**（改前录的金样） |
 * | 挂了 | 走到 dsh；官方两个工具在模型面前；搜索凭据照"账号优先、其次 key"现取；审计 `web.searched` / `web.fetched`、用量 `model.usage{purpose:web_search}` |
 * | 设置里把「用你的 DeepSeek 账号搜索」关了 / 没有凭据 | 不给搜索（抓网页照旧给） |
 *
 * **不联网、不花钱**：搜索口指向本机替身；抓网页只打本机地址（官方抓取在连接之前就拒）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
} from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const GOLDEN = join(dirname(new URL(import.meta.url).pathname), 'fixtures/wp179-direct-events.json')

const clock: Clock = { now: () => '2026-09-29T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

/** 按脚本出工具调用的替身模型；每一次收到的请求都记下来。 */
function scripted(calls: { name: string; input?: Record<string, unknown> }[]): ModelGatewayApi & {
  seen: { messages: ChatMessage[]; tools: string[] }[]
  external: unknown[]
} {
  const seen: { messages: ChatMessage[]; tools: string[] }[] = []
  const external: unknown[] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    external,
    async complete(req: { messages: ChatMessage[]; tools?: { name: string }[] }) {
      seen.push({ messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) })
      const call = calls[seen.length - 1]
      return call === undefined
        ? done('查完了。')
        : done('', [{ id: `call_${seen.length}`, name: call.name, input: call.input ?? {} }])
    },
    recordExternal(input: unknown) {
      external.push(input)
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
  } as unknown as ModelGatewayApi & {
    seen: { messages: ChatMessage[]; tools: string[] }[]
    external: unknown[]
  }
}

/** 一条职责；`web` 就是职责 YAML 的 `web_tools` 算出来的那一格（不给 = 没挂）。 */
function fakeRoles(
  web?: { tools: ('web_search' | 'web_fetch')[] },
  role_id = 'dtc.content',
): RoleStore {
  return {
    effectiveConfig: () => ({
      role_id,
      grounding: [],
      skills: [],
      browser_scope: [],
      ...(web === undefined ? {} : { web: { ...web, ...DEFAULT_WEB_LIMITS } }),
    }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
}

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

// ── 本机替身 DeepSeek（官方搜索提供方打的就是它）──────────────────────────
let server: Server
let base = ''
const seenSearch: { headers: Record<string, unknown> }[] = []
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seenSearch.push({ headers: req.headers })
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                { type: 'web_search_result', url: 'https://example.com/a', title: 'A' },
                { type: 'web_search_result', url: 'https://example.com/b', title: 'B' },
              ],
            },
          ],
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic/v1`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

type WebOpt = NonNullable<RuntimeOptions['web']>

/** 网页那一层（服务端装配给的）：账号登录了就用账号，否则用 key。 */
function webOption(over: Partial<WebOpt> = {}): WebOpt {
  return {
    searchEnabled: () => true,
    credentialKind: () => 'deepseek_account',
    credential: async () => ({ kind: 'account', token: 'acct-srv-test' }),
    searchBaseUrl: base,
    ...over,
  }
}

async function runOnce(input: {
  web?: { tools: ('web_search' | 'web_fetch')[] }
  role_id?: string
  calls?: { name: string; input?: Record<string, unknown> }[]
  extra?: Partial<RuntimeOptions>
}) {
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const gateway = scripted(input.calls ?? [])
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles: fakeRoles(input.web, input.role_id),
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => MODEL,
    modelVision: () => 'ok',
    dshMode: 'in-process',
    ...input.extra,
  } as RuntimeOptions)
  const { run_id } = await runtime.startRun({
    matter,
    brief: '查一下 65W 氮化镓充电器 2026 年的新品和价格',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { run_id, events, gateway }
}

const payloadsOf = (events: Omit<EventEnvelope, 'id' | 'at'>[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>)
/** 金样那两次运行都调一次普通读工具（没接执行器 → 一条 error 结果），序列才不止五条。 */
const READ_ONCE = [{ name: 'search_policies', input: { query: '退货' } }]

describe('没挂网页工具的运行：照旧走 direct，事件序列与改前逐字相同', () => {
  const record = process.env.WP179_RECORD_GOLDEN === '1'
  const golden = (): Record<string, unknown> =>
    record ? {} : (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>)
  const recorded: Record<string, unknown> = {}
  afterAll(() => {
    if (record) writeFileSync(GOLDEN, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
  })

  it('职责没有 web_tools（服务端接了网页那一层也不挂）', async () => {
    const { events } = await runOnce({
      calls: READ_ONCE,
      extra: { web: webOption() } as Partial<RuntimeOptions>,
    })
    recorded.no_web_tools = events
    if (!record) expect(events).toEqual(golden().no_web_tools)
  })

  it('职责有 web_tools、服务端没接网页那一层', async () => {
    const { events } = await runOnce({
      web: { tools: ['web_search', 'web_fetch'] },
      calls: READ_ONCE,
    })
    recorded.no_web_option = events
    if (!record) expect(events).toEqual(golden().no_web_option)
  })
})

describe('挂了网页工具的运行：走 dsh，官方两个工具在模型面前', () => {
  it('搜一次、抓一次：审计与用量都记下，令牌不进事件', async () => {
    seenSearch.length = 0
    const { events, gateway } = await runOnce({
      web: { tools: ['web_search', 'web_fetch'] },
      calls: [
        { name: 'web_search', input: { queries: ['65W GaN 2026'] } },
        { name: 'web_fetch', input: { url: 'http://127.0.0.1:9/x' } },
      ],
      extra: { web: webOption() } as Partial<RuntimeOptions>,
    })
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(gateway.seen[0]?.tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    expect(seenSearch[0]?.headers['x-dsh-auth-token']).toBe('acct-srv-test')
    expect(payloadsOf(events, 'tool.result').map((r) => r.status)).toEqual(['ok', 'error'])
    // 审计：查询 / 网址 + 条数 + 成败，没有正文
    expect(payloadsOf(events, 'web.searched')).toEqual([
      expect.objectContaining({
        run_id: expect.any(String),
        role_id: 'dtc.content',
        queries: ['65W GaN 2026'],
        results: 2,
        ok: true,
      }),
    ])
    expect(payloadsOf(events, 'web.fetched')).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:9/x', ok: false }),
    ])
    // 用量：一条查询一笔，purpose web_search，provider 标明账号
    expect(gateway.external).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ purpose: 'web_search', role_id: 'dtc.content' }),
        model: { provider: 'deepseek-account', model: 'deepseek-v4-flash' },
      }),
    ])
    expect(JSON.stringify(events)).not.toContain('acct-srv-test')
  })

  it('设置里把「用你的 DeepSeek 账号搜索」关了：不给搜索，抓网页照旧', async () => {
    const { events, gateway } = await runOnce({
      web: { tools: ['web_search', 'web_fetch'] },
      extra: { web: webOption({ searchEnabled: () => false }) } as Partial<RuntimeOptions>,
    })
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(gateway.seen[0]?.tools).toContain('web_fetch')
    expect(gateway.seen[0]?.tools).not.toContain('web_search')
  })

  it('没有凭据（没登录账号、也没有 DeepSeek 官方 key）：同样不给搜索', async () => {
    const { gateway } = await runOnce({
      web: { tools: ['web_search'] },
      extra: {
        web: webOption({ credentialKind: () => undefined }),
      } as Partial<RuntimeOptions>,
    })
    // 只挂了搜索、搜索又给不了 → 整个网页那一层都不挂，照旧 direct
    expect(gateway.seen[0]?.tools).not.toContain('web_search')
  })
})

describe('挂了网页工具的红人运行走 dsh 之后，红人工具照样调得动（与 direct 那条路对齐）', () => {
  it('draft_outreach 这类服务端执行器的工具不被当成"写外部"拦下', async () => {
    const calls: string[] = []
    const { events } = await runOnce({
      web: { tools: ['web_search', 'web_fetch'] },
      role_id: 'kol.youtube',
      calls: [
        { name: 'draft_outreach', input: { creator_id: 'cr_1' } },
        { name: 'score_creator', input: { creator_id: 'cr_1' } },
      ],
      extra: {
        web: webOption(),
        kolTools: async (call: { name: string }) => {
          calls.push(call.name)
          return { status: 'ok', data: { ok: true } }
        },
      } as unknown as Partial<RuntimeOptions>,
    })
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(calls).toEqual(['draft_outreach', 'score_creator'])
    const results = payloadsOf(events, 'tool.result')
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok'])
  })
})
