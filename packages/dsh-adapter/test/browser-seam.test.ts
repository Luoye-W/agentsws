/**
 * 浏览器：官方 provider + 我们这一侧的策略（55 §3，WP82）。
 *
 * WP70 这份文件还是一个 spike（仿真 provider + 11 条断言），结论是"真 provider 挂不进来，
 * 因为我们的组合里没有 `agents`"。**两条前提都已经不成立了**：
 *
 * 1. WP81 把官方 Agent 层引进来了 —— `agents` 有了；
 * 2. WP82 实测：`@playwright/mcp` 的 `cli.js` **启动时不碰浏览器**（它只在第一次真调
 *    工具时才连），所以 attach 模式指一个**没人监听的** endpoint，provider 照样挂得上、
 *    照样把 24 个工具报上来。于是这份文件里的 provider 是**真的**，不再是替身。
 *
 * 所以这里分两层测：
 *
 * | 层 | 用什么 | 测什么 |
 * |---|---|---|
 * | provider | **真** `dsh-experimental-browser-use-playwright-mcp` + 死 endpoint | 挂得上、工具名、提示词段、独占 |
 * | 策略 | 真门禁（`installGate`）+ 同名的工具替身 | 域名白名单 / 读写分类 / 注 JS / 两档策略 |
 *
 * 第二层为什么不用真 provider：拒绝的那几条用得上（门禁在 `tools/pre-execute` 就拦下了，
 * 工具体根本不跑），但**放行**的那几条会真的去连 endpoint，然后卡到 MCP 客户端超时。
 * 测的是我们的门禁不是 Playwright，所以放行路径用同名替身，跑得快、判得准。
 *
 * 真 provider 在本机真 Chrome 上的手工验证步骤见 `scripts/dev-browser.md`。
 */
import { Provenance } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_DEFAULT_TOOL_NAMES,
  BROWSER_DEFAULT_TOOLS,
  BROWSER_TOOL_PREFIX,
  classifySideEffect,
  createHarness,
  type GateApi,
  installGate,
  PERSONA_SECTION,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

/** 上游 `mcp.ts` 的命名规则：`` const toolPrefix = `mcp__${options.name}__` ``。 */
const PROVIDER = 'playwright-mcp'
const PREFIX = BROWSER_TOOL_PREFIX
/** 上游按 `` assembly.sections.filter(s => s.name !== `mcp:${options.name}`) `` 过滤，可见段名就是这个。 */
const MCP_SECTION = `mcp:${PROVIDER}`

/** dsh 0.1.6-alpha.1 的两个分节位（`dsh-system-prompt` 的 `SECTION_ORDERS`）。 */
const TOOL_COMPUTER_USE = 3000
const MCP_SERVERS = 3100

/**
 * attach 到一个**没人监听**的回环端口。
 *
 * 这不是偷懒：上游 provider 启动的是 `@playwright/mcp` 的 MCP 服务器进程，
 * 它启动时不连浏览器（连接是第一次调工具时才发生的），所以 endpoint 通不通
 * 不影响"工具报上来了没有"。而我们这一层要测的恰恰只有这一件事。
 */
const DEAD_ENDPOINT = 'http://127.0.0.1:59321'

const meta = (req: ReturnType<typeof makeRequest>) => ({
  workspace_id: req.workspace_id,
  assignment_id: req.actor.assignment_id,
  role_id: req.actor.role_id,
  run_id: req.id,
  purpose: 'run' as const,
})

async function harnessOf(req: ReturnType<typeof makeRequest>) {
  const { sink, events } = collect()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions(),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    model: 'stub-v1',
    meta: meta(req),
  })
  return { harness, events }
}

// ── 第二层用的工具替身：名字与上游逐字相同，工具体只回一句话 ──────────────
const browserTool = (short: string) =>
  defineTool({
    name: `${PREFIX}${short}`,
    description: `playwright ${short}`,
    parameters: { url: { type: 'string' }, action: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    async execute() {
      return { ok: true } as never
    },
  })

/** 裸组合（不含 Agent 层），用来测 dsh 自己的语义。 */
async function bare(withBrowserUse = true): Promise<Context> {
  const root = new Context()
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  if (withBrowserUse) root.plugin(BrowserUseRegistry)
  return new Promise<Context>((resolve) => {
    root.plugin({
      name: 'probe',
      inject: ['tools', 'systemPrompt', ...(withBrowserUse ? ['browserUse'] : [])],
      apply: (c: Context) => resolve(c),
    })
  })
}

/**
 * 真门禁 + 同名工具替身，走的是与运行时**同一份** `installGate`。
 *
 * 替身注册在一个 `createScope(ctx, agent)` 里而不是全局——这一点必须与真 provider
 * 一致：官方 provider 就是在它自己的 agent scope 里注册 MCP 工具的，而
 * `restrict({ allow })` 只遮全局工具。注册成全局的话职责白名单会把它们一起遮掉，
 * 测出来的就不是生产里的行为了。
 */
async function gateOnBare(
  req: ReturnType<typeof makeRequest>,
  over: Partial<Parameters<typeof installGate>[1]['options']> = {},
): Promise<{ gate: GateApi; events: RunEventList; dispose(): Promise<void> }> {
  const ctx = await bare(false)
  const agent = { preset: req.runtime.preset, run_id: req.id }
  const scope = createScope(ctx, agent)
  for (const short of BROWSER_DEFAULT_TOOLS) scope.ctx.tools.register(browserTool(short))
  const { sink, events } = collect()
  const gate = installGate(ctx, {
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions(over),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    agent,
    agentCtx: scope.ctx,
  })
  return {
    gate,
    events,
    dispose: async () => {
      await gate.dispose()
      await scope.dispose()
    },
  }
}

type RunEventList = ReturnType<typeof collect>['events']

const KOL = {
  browser: { mode: 'attach', endpoint: DEAD_ENDPOINT } as const,
  allowed_hosts: ['youtube.com', '*.youtube.com'],
}

describe('(a) 真 provider：挂得上，工具名与我们那张表逐条相同', () => {
  it('RunRequest.browser 在场 → provider 挂上，24 个工具进这个 Agent 的 scope', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools
        .schemas(harness.agent as never)
        .map((s) => s.name)
        .filter((n) => n.startsWith(PREFIX))
        .sort()
      // 这是**实测**的那一份：我们写死的表若与上游对不上，这一条当场红
      expect(names).toEqual([...BROWSER_DEFAULT_TOOL_NAMES].sort())
      expect(names).toHaveLength(24)
      // provider 槽被官方 provider 自己占住了
      expect(harness.ctx.get('browserUse')).toBeDefined()
      expect(String(harness.ctx.browserUse.providerName)).toBe(PROVIDER)
    } finally {
      await harness.dispose()
    }
  }, 60_000)

  it('不给 RunRequest.browser → 整层浏览器都不存在（没有服务、没有工具、不起子进程）', async () => {
    const req = makeRequest()
    const { harness } = await harnessOf(req)
    try {
      expect(harness.ctx.get('browserUse')).toBeUndefined()
      expect(
        harness.ctx.tools.schemas(harness.agent as never).filter((s) => s.name.startsWith(PREFIX)),
      ).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('provider 的工具是 scoped registration：职责的 restrict 白名单不遮它们（上游语义）', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      // `restrict({ allow })` 只遮"继承下来的全局工具"（上游原话：scoped registrations
      // remain visible）。我们的白名单里只有自己那几个工具，浏览器那 24 个照样在。
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(names).toContain('get_order')
      expect(names.filter((n) => n.startsWith(PREFIX))).toHaveLength(24)
      // 全局注册的工具则照旧被遮（restrict 还在干活，没被浏览器这一层削弱）
      harness.ctx.tools.register(
        defineTool({
          name: 'create_refund',
          description: 'x',
          parameters: {},
          output: { schema: { type: 'json' }, render: () => [] },
          async execute() {
            return {} as never
          },
        }),
      )
      expect(harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)).not.toContain(
        'create_refund',
      )
    } finally {
      await harness.dispose()
    }
  }, 60_000)

  it('不给 browser 时浏览器工具名不在 allowlist 里 → blocked（不是"没这个工具"）', async () => {
    const g = await gateOnBare(makeRequest())
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_navigate`, {
        url: 'https://www.youtube.com/',
      })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toBe(`not_in_allowlist: ${PREFIX}browser_navigate`)
    } finally {
      await g.dispose()
    }
  })
})

describe('(b) 提示词：官方那两段被遮掉，我们的浏览器规矩进 persona 段', () => {
  it('裸组合里 MCP_SERVERS / TOOL_COMPUTER_USE 两段确实进了 assemble()', async () => {
    const ctx = await bare()
    ctx.systemPrompt.section({ name: MCP_SECTION, order: MCP_SERVERS, text: 'BROWSER-GUIDANCE' })
    ctx.systemPrompt.section({
      name: 'tool:computer-use',
      order: TOOL_COMPUTER_USE,
      text: 'SCREENSHOT-GUIDANCE',
    })
    const names = (await ctx.systemPrompt.assemble()).sections.map((s) => s.name)
    expect(names).toContain(MCP_SECTION)
    expect(names).toContain('tool:computer-use')
  })

  it('加上一个 complete 段之后两段都被遮掉，渲染出来只有 complete 段本身', async () => {
    const ctx = await bare()
    ctx.systemPrompt.section({ name: MCP_SECTION, order: MCP_SERVERS, text: 'BROWSER-GUIDANCE' })
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: 0,
      text: 'PERSONA-ONLY',
      complete: true,
    })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).toEqual([PERSONA_SECTION])
    expect(renderPrompt(assembly)).toBe('PERSONA-ONLY')
  })

  it('真 provider 在场时，它自己那段也照样被遮掉', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const names = (await harness.contextSections()).map((s) => s.name)
      expect(names).not.toContain(MCP_SECTION)
      const text = await harness.systemText()
      expect(text).not.toContain('Playwright')
    } finally {
      await harness.dispose()
    }
  }, 60_000)

  it('所以"能打开哪些站 / 登录页怎么办"必须由我们写进 persona 段——这一条钉住它在', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const text = await harness.systemText()
      expect(text).toContain('## 浏览器')
      expect(text).toContain('youtube.com')
      // 55 §3「人接管」那一行：遇到登录页 / 验证码停下来找人，不猜密码（13 §4）
      expect(text).toContain('遇到登录页、验证码、两步验证就停下')
      expect(text).toContain('不要猜密码')
      // executor 档还要多一句"只能看不能动"
      expect(text).toContain('只能看不能动')
    } finally {
      await harness.dispose()
    }
  }, 60_000)

  it('不给 browser 的运行里，persona 段里一个字的浏览器都没有', async () => {
    const req = makeRequest()
    const { harness } = await harnessOf(req)
    try {
      expect(await harness.systemText()).not.toContain('## 浏览器')
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})

describe('(c) 一个 Session 一个浏览器：provider 槽独占', () => {
  it('槽是独占的：第二个 provider 挂不上，报的是第一个的名字', async () => {
    const ctx = await bare()
    const release = ctx.browserUse.register(BrowserUseProviderName(PROVIDER))
    expect(String(ctx.browserUse.providerName)).toBe(PROVIDER)
    expect(() => ctx.browserUse.register(BrowserUseProviderName('chrome-devtools-mcp'))).toThrow(
      /provider "playwright-mcp" is already registered/,
    )
    await release()
    expect(ctx.browserUse.providerName).toBeUndefined()
  })

  it('attach 模式下两次运行不会同时占住同一个 Chrome：第一棵树 dispose 之后槽才空出来', async () => {
    const first = await harnessOf(makeRequest({ ...KOL, id: 'run_a' }))
    expect(String(first.harness.ctx.browserUse.providerName)).toBe(PROVIDER)
    await first.harness.dispose()
    // 一次运行一棵树（17 §5.1）：树没了，槽与 MCP 子进程一起走
    const second = await harnessOf(makeRequest({ ...KOL, id: 'run_b' }))
    try {
      expect(String(second.harness.ctx.browserUse.providerName)).toBe(PROVIDER)
    } finally {
      await second.harness.dispose()
    }
  }, 90_000)
})

describe('(d) 域名白名单（55 §3 第二行）', () => {
  it('白名单里的站放行：youtube.com 与 www.youtube.com（通配）都开得了', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const a = await g.gate.execute('c_1', `${PREFIX}browser_navigate`, {
        url: 'https://www.youtube.com/@someone',
      })
      expect(a.isError).toBe(false)
      const b = await g.gate.execute('c_2', `${PREFIX}browser_navigate`, {
        url: 'https://youtube.com/results?search_query=x',
      })
      expect(b.isError).toBe(false)
    } finally {
      await g.dispose()
    }
  })

  it('白名单外的站拒，理由是人话', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_navigate`, {
        url: 'https://www.amazon.com/dp/B000',
      })
      expect(res.isError).toBe(true)
      const rec = g.gate.records.get('c_1')
      expect(rec?.status).toBe('blocked')
      expect(rec?.reason).toContain('这个岗位只能打开')
      expect(rec?.reason).toContain('www.amazon.com 不在里面')
      // Model-visible ⟺ logged：拒也发一条 tool.result
      expect(g.events.some((e) => e.type === 'tool.result' && e.status === 'blocked')).toBe(true)
    } finally {
      await g.dispose()
    }
  })

  it('allowed_hosts 为空（= 职责没填 browser_scope）→ 任何 navigate 都拒', async () => {
    const req = makeRequest({
      browser: { mode: 'attach', endpoint: DEAD_ENDPOINT },
      side_effect_policy: 'personal',
    })
    const g = await gateOnBare(req)
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_navigate`, {
        url: 'https://www.youtube.com/',
      })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('没有开放任何网站')
    } finally {
      await g.dispose()
    }
  })

  it('开新标签页也带 URL，一样查白名单（browser_tabs action=new）', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const bad = await g.gate.execute('c_1', `${PREFIX}browser_tabs`, {
        action: 'new',
        url: 'https://evil.example.com/',
      })
      expect(bad.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('evil.example.com 不在里面')
      const good = await g.gate.execute('c_2', `${PREFIX}browser_tabs`, {
        action: 'new',
        url: 'https://m.youtube.com/',
      })
      expect(good.isError).toBe(false)
    } finally {
      await g.dispose()
    }
  })

  it('URL 不是 URL（模型给了个半截地址）→ 拒，而不是当成"没有 host 所以放行"', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_navigate`, { url: 'youtube.com' })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('打不开这个地址')
    } finally {
      await g.dispose()
    }
  })
})

describe('(e) 读写分类（55 §3 第一行）', () => {
  it('只读的那几个是 read_external，写的那几个是 write_external', () => {
    for (const short of [
      'browser_navigate',
      'browser_snapshot',
      'browser_take_screenshot',
      'browser_find',
      'browser_console_messages',
      'browser_network_requests',
      'browser_network_request',
      'browser_wait_for',
      'browser_resize',
    ]) {
      expect(classifySideEffect(`${PREFIX}${short}`), short).toBe('read_external')
    }
    for (const short of [
      'browser_click',
      'browser_type',
      'browser_fill_form',
      'browser_select_option',
      'browser_press_key',
      'browser_hover',
      'browser_drag',
      'browser_drop',
      'browser_file_upload',
      'browser_evaluate',
      'browser_run_code_unsafe',
      'browser_handle_dialog',
      'browser_navigate_back',
      'browser_close',
    ]) {
      expect(classifySideEffect(`${PREFIX}${short}`), short).toBe('write_external')
    }
  })

  it('browser_tabs 按 action 判：list / select 是读，new / close 与不给 action 是写', () => {
    const t = `${PREFIX}browser_tabs`
    expect(classifySideEffect(t, undefined, { action: 'list' })).toBe('read_external')
    expect(classifySideEffect(t, undefined, { action: 'select', index: 1 })).toBe('read_external')
    expect(classifySideEffect(t, undefined, { action: 'new' })).toBe('write_external')
    expect(classifySideEffect(t, undefined, { action: 'close' })).toBe('write_external')
    expect(classifySideEffect(t)).toBe('write_external')
  })

  it('不在表里的浏览器工具名一律按写处理（16 §3 最严；上游新增的工具默认进不了公司端）', () => {
    expect(classifySideEffect(`${PREFIX}browser_brand_new_tool`)).toBe('write_external')
    expect(classifySideEffect(`${PREFIX}anything_at_all`)).toBe('write_external')
  })

  it('executor 档：写工具（browser_click）拒；personal 档：放行并记一条事件', async () => {
    const blocked = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }))
    try {
      const res = await blocked.gate.execute('c_1', `${PREFIX}browser_click`, { target: 'e1' })
      expect(res.isError).toBe(true)
      expect(blocked.gate.records.get('c_1')?.reason).toContain('write_external_requires_executor')
    } finally {
      await blocked.dispose()
    }

    const allowed = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const res = await allowed.gate.execute('c_1', `${PREFIX}browser_click`, { target: 'e1' })
      expect(res.isError).toBe(false)
      // 「AI 在我的浏览器里动了手」在时间线上的那一行
      expect(
        allowed.events.some(
          (e) =>
            e.type === 'progress' &&
            e.step === 'browser_write' &&
            e.note === `${PREFIX}browser_click`,
        ),
      ).toBe(true)
    } finally {
      await allowed.dispose()
    }
  })

  it('executor 档下只读工具照样放行（不然连看一眼网页都做不到）', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }))
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_snapshot`, {})
      expect(res.isError).toBe(false)
    } finally {
      await g.dispose()
    }
  })
})

describe('(f) 注 JS：公司端一律拒（55 §3）', () => {
  it('browser_evaluate / browser_run_code_unsafe 在 executor 档有专门的拒绝理由', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }))
    try {
      for (const [i, short] of ['browser_evaluate', 'browser_run_code_unsafe'].entries()) {
        const id = `c_${i}`
        const res = await g.gate.execute(id, `${PREFIX}${short}`, { function: '() => 1' })
        expect(res.isError).toBe(true)
        expect(g.gate.records.get(id)?.reason).toContain('不允许让 AI 在网页里跑脚本')
      }
    } finally {
      await g.dispose()
    }
  })

  it('哪怕有人给 sideEffects 加了覆盖把它标成只读，这一条照样拦得住', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }), {
      sideEffects: { [`${PREFIX}browser_evaluate`]: 'read_external' },
    })
    try {
      const res = await g.gate.execute('c_1', `${PREFIX}browser_evaluate`, { function: '() => 1' })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('不允许让 AI 在网页里跑脚本')
    } finally {
      await g.dispose()
    }
  })
})
