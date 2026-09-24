/**
 * WP148：服务端**带浏览器的运行改走 dsh 运行时**（照 WP144 电脑操控那条分流的写法）。
 *
 * 服务端平时走 direct 运行时，那条路上没有浏览器工具（浏览器提供方只在 dsh 那棵树上挂）。
 * 所以设置页配好了浏览器、职责也填了 `browser_scope`，以前服务端的运行照样一个 `browser_*`
 * 都拿不到。这份文件钉四件事：
 *
 * | 场景 | 用什么 | 钉什么 |
 * |---|---|---|
 * | 没开浏览器 | 真 `createRuntime` + 替身模型 | 仍走 direct，事件序列与改前**逐字相同**（改前录的金样） |
 * | 官方 Playwright 那一种 | 官方 `mountSessionMcp` + 假 Playwright MCP 进程 | 走到 dsh、提供方挂上、白名单内放外拒、截图进替身模型 |
 * | BrowserSkill 那一种 | 真腾讯插件 + 假 `bsk` | 同样走到 dsh、门禁照拦 |
 * | 浏览器 + 电脑操控 | 两样都在场 | 同一棵树挂两样 |
 *
 * **不联网、不开真浏览器、不启动 cua-driver、不截真屏**：假服务器只回固定内容。
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  RunBrowser,
} from '@agentsws/contracts'
import { subprocessAvailable } from '@agentsws/dsh-adapter'
import { type ModelGatewayApi, visionProbeBase64 } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

/*
 * 浏览器那条腿：官方 Playwright 提供方是「`mountSessionMcp` + 起 `@playwright/mcp` 的 cli.js」
 * 这么一层薄壳。这里只把**那个进程**换成假 MCP 服务器（同 dsh-adapter 的
 * `screenshots-to-model.test.ts`），其余——官方浏览器 seam、MCP 桥、图片准入、我们的门禁与
 * 附件库、服务端的分流——全是真的。服务端不直接依赖那个包，所以按 dsh-adapter 那一侧
 * 解析出来的绝对路径去替换。
 */
const PW = vi.hoisted(() => {
  const { createRequire } = process.getBuiltinModule('node:module')
  const { fileURLToPath } = process.getBuiltinModule('node:url')
  const adapter = fileURLToPath(
    new URL('../../../packages/dsh-adapter/package.json', import.meta.url),
  )
  const provider = createRequire(adapter).resolve(
    '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
  )
  const runtimeMcp = createRequire(provider).resolve(
    '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp',
  )
  return { provider, runtimeMcp }
})

vi.mock(PW.provider, async () => {
  const runtime = (await import(PW.runtimeMcp)) as {
    BrowserMcpConfig: unknown
    mountSessionMcp(ctx: unknown, options: unknown): void
  }
  // 工厂在测试文件的 import 之前就会跑（dsh-adapter 静态 import 了提供方），所以依赖都现取
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const gw = await import('@agentsws/model-gateway')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsws-wp148-pw-'))
  const server = path.join(dir, 'playwright-mcp.cjs')
  fs.writeFileSync(
    server,
    fakeMcpServer(
      ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'],
      gw.visionProbeBase64(),
    ),
    'utf8',
  )
  return {
    name: 'experimental-browser-use-playwright-mcp',
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
    Config: runtime.BrowserMcpConfig,
    apply(ctx: unknown) {
      runtime.mountSessionMcp(ctx, {
        name: 'playwright-mcp',
        exclusive: false,
        command: process.execPath,
        args: [server],
      })
    },
  }
})

const PNG = visionProbeBase64()

/**
 * 一个讲 MCP stdio（一行一条 JSON-RPC）的最小服务器。名字以 `screenshot` / `window_state`
 * 结尾的工具回「一段文字 + 一张图」，别的只回文字。
 */
function fakeMcpServer(tools: string[], png: string): string {
  return `
const tools = ${JSON.stringify(tools)}.map((name) => ({ name, description: 'fake ' + name, inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }))
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === '') continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.0' } })
    else if (msg.method === 'tools/list') reply({ tools })
    else if (msg.method === 'ping') reply({})
    else if (msg.method === 'tools/call') {
      const name = msg.params.name
      if (/(screenshot|window_state)$/.test(name)) reply({ content: [{ type: 'text', text: 'page: example.com' }, { type: 'image', data: ${JSON.stringify(png)}, mimeType: 'image/png' }] })
      else reply({ content: [{ type: 'text', text: 'ok ' + name }] })
    } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no ' + msg.method } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

const GOLDEN = join(dirname(new URL(import.meta.url).pathname), 'fixtures/wp148-direct-events.json')

const clock: Clock = { now: () => '2026-09-24T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

/** 按脚本出工具调用的替身模型；每一次收到的请求都记下来。 */
function scripted(
  calls: { name: string; input?: Record<string, unknown> }[],
): ModelGatewayApi & { seen: { messages: ChatMessage[]; tools: string[] }[] } {
  const seen: { messages: ChatMessage[]; tools: string[] }[] = []
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
  } as unknown as ModelGatewayApi & { seen: { messages: ChatMessage[]; tools: string[] }[] }
}

/** 一条职责；`browser_scope` 就是这条职责的域名白名单。 */
function fakeRoles(browser_scope: string[]): RoleStore {
  return {
    effectiveConfig: () => ({
      role_id: 'ops.web',
      grounding: [],
      skills: [],
      browser_scope,
    }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
}

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '看一眼店铺首页',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-24T09:00:00.000Z',
  updated_at: '2026-09-24T09:00:00.000Z',
} as unknown as Matter

/** 起一次服务端运行，回事件日志（信封里去掉 id / at 之外全留）与替身模型。 */
async function runOnce(input: {
  browser_scope: string[]
  browser?: RunBrowser
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
    roles: fakeRoles(input.browser_scope),
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => MODEL,
    modelVision: () => 'ok',
    ...(input.browser === undefined ? {} : { browser: () => input.browser }),
    ...input.extra,
  })
  const { run_id } = await runtime.startRun({
    matter,
    brief: '打开首页看看有没有挂掉',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { run_id, events, gateway }
}

const ATTACH: RunBrowser = { mode: 'attach', endpoint: 'http://127.0.0.1:9' }
/** 金样那两次运行都调一次普通读工具（没接执行器 → 一条 error 结果），序列才不止五条。 */
const READ_ONCE = [{ name: 'search_policies', input: { query: '退货' } }]

describe('没开浏览器的运行：照旧走 direct，事件序列与改前逐字相同', () => {
  it('职责没填 browser_scope（设置页配了浏览器也不开）', async () => {
    const { events } = await runOnce({ browser_scope: [], browser: ATTACH, calls: READ_ONCE })
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { no_scope: unknown }
    expect(events).toEqual(golden.no_scope)
  })

  it('职责填了 browser_scope、设置页没配浏览器', async () => {
    const { events } = await runOnce({ browser_scope: ['example.com'], calls: READ_ONCE })
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { no_browser: unknown }
    expect(events).toEqual(golden.no_browser)
  })
})

// ── 带浏览器的运行 ───────────────────────────────────────────────────────────
type Part = Extract<ChatMessage['content'], unknown[]>[number]
const imagesIn = (messages: ChatMessage[]): Part[] =>
  messages.flatMap((m) =>
    typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image'),
  )
const payloadsOf = (events: Omit<EventEnvelope, 'id' | 'at'>[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>)
const NAV = 'mcp__playwright-mcp__browser_navigate'
const SHOT = 'mcp__playwright-mcp__browser_take_screenshot'
/** 测试里钉成进程内：结果不随「dsh-adapter 编没编出子进程入口」变（服务进程不给 = auto）。 */
const IN_PROCESS: Partial<RuntimeOptions> = { dshMode: 'in-process' }

describe('官方 Playwright 那一种：服务端的运行走到 dsh，提供方挂上', () => {
  it('白名单内放、外拒；截图进了替身模型；事件里没有图片字节', async () => {
    const { events, gateway } = await runOnce({
      browser_scope: ['example.com'],
      browser: ATTACH,
      calls: [
        { name: NAV, input: { url: 'https://example.com/' } },
        { name: NAV, input: { url: 'https://evil.test/login' } },
        { name: SHOT },
      ],
      extra: IN_PROCESS,
    })
    // 走的是 dsh（direct 那条路自报 `direct-llm`）
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    // 提供方挂上了：第一次问模型时工具表里就有浏览器工具
    expect(gateway.seen[0]?.tools).toEqual(expect.arrayContaining([NAV, SHOT]))
    const results = payloadsOf(events, 'tool.result')
    expect(results.map((r) => r.status)).toEqual(['ok', 'blocked', 'ok'])
    expect(String(results[1]?.reason)).toContain('browser_host_not_allowed')
    // 截图：第四次请求（截图之后那一轮）里有一张图
    const after = gateway.seen[3]?.messages ?? []
    expect(imagesIn(after)).toHaveLength(1)
    expect(after.filter((m) => m.role === 'tool').at(-1)?.name).toBe(SHOT)
    expect(JSON.stringify(events)).not.toContain(PNG.slice(0, 64))
    expect(payloadsOf(events, 'run.completed')).toHaveLength(1)
  })

  /*
   * 服务进程不给 `dshMode`（= auto）：编过的机器上走子进程档。子进程里没有上面那个替身，
   * 挂的是**真** Playwright 提供方——attach 一个没人监听的端口（WP82 的办法：`@playwright/mcp`
   * 启动时不碰浏览器，第一次真调工具才连），所以只调一次会被门禁拦下的导航，工具体根本不跑。
   */
  it.runIf(subprocessAvailable())(
    '子进程档（服务进程的缺省）：真提供方挂上，白名单外照拦',
    async () => {
      const { events, gateway } = await runOnce({
        browser_scope: ['example.com'],
        browser: { mode: 'attach', endpoint: 'http://127.0.0.1:59321' },
        calls: [{ name: NAV, input: { url: 'https://evil.test/' } }],
        extra: { dshMode: 'subprocess' },
      })
      expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
      expect(gateway.seen[0]?.tools).toEqual(expect.arrayContaining([NAV, SHOT]))
      const results = payloadsOf(events, 'tool.result')
      expect(results.map((r) => r.status)).toEqual(['blocked'])
      expect(String(results[0]?.reason)).toContain('browser_host_not_allowed')
    },
  )

  it('模型没验证过能看图：浏览器照样能用，只是截图不进模型', async () => {
    const { events, gateway } = await runOnce({
      browser_scope: ['example.com'],
      browser: ATTACH,
      calls: [{ name: SHOT }],
      extra: { ...IN_PROCESS, modelVision: () => 'unchecked' },
    })
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(imagesIn(gateway.seen[1]?.messages ?? [])).toHaveLength(0)
  })
})

// ── BrowserSkill 那一种（用户正在用的浏览器）───────────────────────────────────
const FIXTURES = mkdtempSync(join(tmpdir(), 'agentsws-wp148-bin-'))
/** 假 `bsk`：任何参数都回一行固定 JSON（同 dsh-adapter 的 `browserskill-seam.test.ts`）。 */
const FAKE_BSK = join(FIXTURES, 'bsk')
writeFileSync(FAKE_BSK, '#!/bin/sh\necho \'{"ok":true}\'\nexit 0\n', 'utf8')
chmodSync(FAKE_BSK, 0o755)
const BSK_TOOLS = [
  'browser_assist',
  'browser_inspect',
  'browser_interact',
  'browser_page',
  'browser_session',
  'browser_tabs',
]

describe('BrowserSkill 那一种：同样走到 dsh，门禁照拦', () => {
  it('六个工具进了工具表；白名单外的地址被拦下', async () => {
    const before = { ...process.env }
    try {
      const { events, gateway } = await runOnce({
        browser_scope: ['youtube.com'],
        browser: { mode: 'browserskill', bsk_path: FAKE_BSK },
        calls: [{ name: 'browser_page', input: { action: 'navigate', url: 'https://evil.test/' } }],
        extra: IN_PROCESS,
      })
      expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
      expect(gateway.seen[0]?.tools).toEqual(expect.arrayContaining(BSK_TOOLS))
      const results = payloadsOf(events, 'tool.result')
      expect(results.map((r) => r.status)).toEqual(['blocked'])
      expect(String(results[0]?.reason)).toContain('browser_host_not_allowed')
    } finally {
      // 插件挂之前会往进程环境里写两个更新开关（`applyBskEnv`），测完还原
      for (const name of ['BSK_AUTO_UPDATE', 'BSK_UPDATE_MANIFEST_URL']) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
  })
})

// ── 浏览器 + 电脑操控：同一棵树挂两样 ─────────────────────────────────────────
/** 假 Cua Driver：一个讲 MCP stdio 的 node 脚本（不启动真驱动、不截真屏）。 */
const DRIVER = join(FIXTURES, 'cua-driver')
writeFileSync(
  DRIVER,
  `#!${process.execPath}\n${fakeMcpServer(['list_apps', 'get_window_state', 'click'], PNG)}`,
  'utf8',
)
chmodSync(DRIVER, 0o755)

function grantedComputerUse(): NonNullable<RuntimeOptions['computerUse']> {
  // 授权窗口按墙钟判（harness 缺省 `Date.now`），所以从现在起算
  const until = new Date(Date.now() + 10 * 60_000).toISOString()
  return {
    forRun: () => ({
      command: DRIVER,
      args: ['mcp'],
      minutes: 10,
      granted_until: until,
      grant_id: 'apv_cu_1',
    }),
    remember: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
  } as unknown as NonNullable<RuntimeOptions['computerUse']>
}

describe('浏览器与电脑操控同时在场', () => {
  it('同一棵树挂两样：两边的工具都在第一次请求的工具表里', async () => {
    const computerUse = grantedComputerUse()
    const { events, gateway } = await runOnce({
      browser_scope: ['example.com'],
      browser: ATTACH,
      calls: [{ name: NAV, input: { url: 'https://example.com/' } }],
      extra: { ...IN_PROCESS, computerUse },
    })
    expect(payloadsOf(events, 'run.started')).toHaveLength(1)
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(gateway.seen[0]?.tools).toEqual(
      expect.arrayContaining([NAV, SHOT, 'mcp__cua-driver-mcp__get_window_state']),
    )
    expect(payloadsOf(events, 'tool.result').map((r) => r.status)).toEqual(['ok'])
    expect(computerUse.activate).toHaveBeenCalledTimes(1)
    expect(computerUse.deactivate).toHaveBeenCalledTimes(1)
  })

  it('只开电脑操控（WP144 那条路）：照旧走 dsh，没有浏览器工具', async () => {
    const { events, gateway } = await runOnce({
      browser_scope: [],
      extra: { ...IN_PROCESS, computerUse: grantedComputerUse() },
    })
    expect(payloadsOf(events, 'run.started')[0]?.runtime).toBe('dsh')
    expect(gateway.seen[0]?.tools.some((t) => t.startsWith('mcp__playwright-mcp__'))).toBe(false)
    expect(gateway.seen[0]?.tools).toContain('mcp__cua-driver-mcp__click')
  })
})
