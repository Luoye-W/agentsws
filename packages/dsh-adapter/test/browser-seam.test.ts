/**
 * WP70 浏览器 seam spike（docs/42 §⑤ 第 3 条；结论供 docs/53 §4.3 引用）。
 *
 * **这是证明，不是产品代码。** dsh 0.1.6-alpha.1 新增了实验性 Browser Use
 * （`@deepseek-ai/dsh-browser-use` 的 provider 槽 + `dsh-experimental-browser-use-playwright-mcp`
 * 等后端）。要回答的是三件事：
 *
 * (a) provider 注册的工具进 `ctx.tools` 之后，**会不会过我们 `gate.ts` 的
 *     `tools/pre-execute` 门禁**；`ctx.tools.restrict({ allow })` 的 preset allowlist
 *     能不能把它们挡在职责之外。
 * (b) 新分节位 `TOOL_COMPUTER_USE: 3000` / `MCP_SERVERS: 3100` 加的系统提示词段，
 *     会不会漏过我们 `systemPrompt.section({ complete: true })` 的遮蔽。
 * (c) "一个 Session 一个浏览器、attach 模式独占" 与我们"一工作区一 runtime"相容吗。
 *
 * ## 为什么挂的是"仿真 provider"而不是真的 playwright-mcp
 *
 * 真 provider（`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`）挂不进来，
 * 两个都是硬原因，写在这里免得下次有人以为是偷懒：
 *
 * 1. 它 `dependencies` 里有 `@playwright/mcp@0.0.80` → `playwright`，后者的
 *    postinstall 下载 Chromium。16 §3 最严解释 / docs/42 红线 2：不给 dsh 的原生
 *    依赖开构建。开不了构建 = 起不了真浏览器，真 MCP 子进程也就无从谈起。
 * 2. 它的 `inject` 是 `['browserUse', 'agents', 'tools', 'systemPrompt']`，而
 *    `mountSessionMcp` 整个挂在 `ctx.on('agent/created')` 上、按 `Agent` 分配资源
 *    （出处：上游 `packages/experimental/browser-use-runtime/src/mcp.ts`）。
 *    WP70 当时我们的组合里根本没有 `agents`、也没有 `Agent`。**WP81 已经补上**
 *    （`harness.ts` 挂了官方 Agent 层），所以今天只差一个 `browserUse` provider——
 *    文件末尾那组断言记的就是这个差量，见 docs/54（将改号 55）§3。
 *
 * 所以：`@deepseek-ai/dsh-browser-use` 是**真的**（devDependency，只依赖 cordis +
 * dsh-brand，两个都已在树里），provider 槽的独占语义按真实现测；工具与提示词段则由
 * 一个仿真 provider 按上游 `mcp.ts` 的原样注册（工具名前缀 `mcp__<name>__`、
 * 提示词段名 `mcp:<name>`）——我们要测的是**我们这一侧的门禁**，不是 Playwright。
 */
import { Context } from '@deepseek-ai/cordis'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { createHarness, PERSONA_SECTION } from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

/** 上游 `mcp.ts` 的命名规则：`const toolPrefix = \`mcp__${options.name}__\``。 */
const PROVIDER = 'playwright-mcp'
const PREFIX = `mcp__${PROVIDER}__`
/** 上游按 `assembly.sections.filter(s => s.name !== \`mcp:${options.name}\`)` 过滤，可见段名就是这个。 */
const MCP_SECTION = `mcp:${PROVIDER}`

/** dsh 0.1.6-alpha.1 新增的两个分节位（`dsh-system-prompt/lib/types/index.d.ts` 的 `SECTION_ORDERS`）。 */
const TOOL_COMPUTER_USE = 3000
const MCP_SERVERS = 3100

/** 一个浏览器工具的替身：名字与注册路径同上游，工具体只回一句话。 */
const browserTool = (short: string) =>
  defineTool({
    name: `${PREFIX}${short}`,
    description: `playwright ${short}`,
    parameters: { url: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    async execute() {
      return { navigated: true } as never
    },
  })

/**
 * 仿真 provider：按上游 `mountSessionMcp` 的三个可观察动作做同样的事——
 * 占 provider 槽、往 `ctx.tools` 注册 `mcp__<name>__*`、往系统提示词加 `mcp:<name>` 段。
 */
function mountFakeBrowserProvider(ctx: Context, name = PROVIDER): () => Promise<void> {
  const release = ctx.browserUse.register(BrowserUseProviderName(name))
  ctx.tools.register(browserTool('browser_navigate'))
  ctx.tools.register(browserTool('browser_click'))
  ctx.systemPrompt.section({
    name: `mcp:${name}`,
    order: MCP_SERVERS,
    text: `You can drive a Chromium browser through the ${name} tools.`,
  })
  ctx.systemPrompt.section({
    name: 'tool:computer-use',
    order: TOOL_COMPUTER_USE,
    text: 'You can take screenshots of the local computer.',
  })
  return release
}

const call = (ctx: Context, name: string, agent?: object) =>
  ctx.tools.execute({
    callId: `c_${Math.random().toString(36).slice(2, 8)}` as never,
    name,
    arguments: {},
    ...(agent === undefined ? {} : { agent: agent as never }),
    signal: new AbortController().signal,
  })

/** 裸组合 + browserUse 槽（不装我们的门禁），用来测 dsh 自己的语义。 */
async function bare(): Promise<Context> {
  const root = new Context()
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  root.plugin(BrowserUseRegistry)
  return new Promise<Context>((resolve) => {
    root.plugin({
      name: 'probe',
      inject: ['tools', 'systemPrompt', 'browserUse'],
      apply: (c) => resolve(c),
    })
  })
}

describe('spike (a)：provider 的工具过我们的门禁，也被 preset allowlist 挡得住', () => {
  it('浏览器工具是普通的 ctx.tools 注册，`tools/pre-execute` 照样先过', async () => {
    const ctx = await bare()
    mountFakeBrowserProvider(ctx)
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push(exec.name)
      return next()
    })
    const res = await call(ctx, `${PREFIX}browser_navigate`)
    expect(res.isError).toBe(false)
    // 门禁看得见它，而且是先于工具体跑的
    expect(seen).toEqual([`${PREFIX}browser_navigate`])
  })

  it('门禁 deny 的话，工具体根本不跑（社区工具没有绕过去的路）', async () => {
    const ctx = await bare()
    let body = 0
    ctx.tools.register(
      defineTool({
        name: `${PREFIX}browser_type`,
        description: 'typing',
        parameters: {},
        output: { schema: { type: 'json' }, render: () => [] },
        async execute() {
          body += 1
          return {} as never
        },
      }),
    )
    ctx.on('tools/pre-execute', async (exec) =>
      exec.name.startsWith(PREFIX)
        ? { kind: 'deny', reason: 'browser not in allowlist' }
        : { kind: 'allow' },
    )
    const res = await call(ctx, `${PREFIX}browser_type`)
    expect(res.isError).toBe(true)
    expect(body).toBe(0)
  })

  it('`ctx.tools.restrict({ allow })`：浏览器工具不在 allowlist 里就对该职责不可见、也调不到', async () => {
    const ctx = await bare()
    mountFakeBrowserProvider(ctx)
    ctx.tools.register(browserTool('browser_snapshot'))
    const agent = { id: 'dtc.support' }
    const scope = createScope(ctx, agent)
    // preset 的 allowlist 里只有我们自己的工具
    scope.ctx.tools.restrict({ allow: [`${PREFIX}browser_navigate`] })
    expect(ctx.tools.schemas(agent).map((s) => s.name)).toEqual([`${PREFIX}browser_navigate`])
    // 全局仍然看得见三个：restrict 是 scope 级的过滤，不是注销
    expect(ctx.tools.schemas().filter((s) => s.name.startsWith(PREFIX))).toHaveLength(3)
    const res = await call(ctx, `${PREFIX}browser_click`, agent)
    expect(res.isError).toBe(true)
    expect(res.isError && res.error.info?.code).toBe('UNKNOWN_TOOL')
    await scope.dispose()
  })

  it('真门禁（gate.ts）对浏览器工具的判定：不在 RunRequest.tools.allow 里 → blocked', async () => {
    const req = makeRequest()
    const { sink, events } = collect()
    const harness = await createHarness({
      request: req,
      sink,
      provenance: new (await import('@agentsws/core')).Provenance(req.id),
      options: baseOptions(),
      buildStageIntent: () => undefined,
      buildDraftPayload: () => undefined,
      model: 'stub-v1',
      meta: {
        workspace_id: req.workspace_id,
        assignment_id: req.actor.assignment_id,
        role_id: req.actor.role_id,
        run_id: req.id,
        purpose: 'run',
      },
    })
    try {
      harness.ctx.tools.register(browserTool('browser_navigate'))
      const res = await harness.gate.execute('c_browser', `${PREFIX}browser_navigate`, {})
      expect(res.isError).toBe(true)
      const record = harness.gate.records.get('c_browser')
      expect(record?.status).toBe('blocked')
      expect(record?.reason).toBe(`not_in_allowlist: ${PREFIX}browser_navigate`)
      // 而且它照常发了一条 tool.result 事件（Model-visible ⟺ logged，16 §2）
      expect(events.some((e) => e.type === 'tool.result')).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe('spike (b)：新分节位不漏过 complete 段的遮蔽', () => {
  it('裸组合里 MCP_SERVERS / TOOL_COMPUTER_USE 两段确实进了 assemble()', async () => {
    const ctx = await bare()
    mountFakeBrowserProvider(ctx)
    const names = (await ctx.systemPrompt.assemble()).sections.map((s) => s.name)
    expect(names).toContain(MCP_SECTION)
    expect(names).toContain('tool:computer-use')
  })

  it('加上一个 complete 段之后，两段都被遮掉，渲染出来的就只有 complete 段本身', async () => {
    const ctx = await bare()
    mountFakeBrowserProvider(ctx)
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

  it('顺序无关：complete 段先注册、provider 后挂，结果一样', async () => {
    const ctx = await bare()
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: 0,
      text: 'PERSONA-ONLY',
      complete: true,
    })
    mountFakeBrowserProvider(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).toEqual([PERSONA_SECTION])
    expect(renderPrompt(assembly)).toBe('PERSONA-ONLY')
  })

  it('真门禁装出来的 persona 也一样遮得住（systemText() 里没有浏览器那两段）', async () => {
    const req = makeRequest()
    const { sink } = collect()
    const harness = await createHarness({
      request: req,
      sink,
      provenance: new (await import('@agentsws/core')).Provenance(req.id),
      options: baseOptions(),
      buildStageIntent: () => undefined,
      buildDraftPayload: () => undefined,
      model: 'stub-v1',
      meta: {
        workspace_id: req.workspace_id,
        assignment_id: req.actor.assignment_id,
        role_id: req.actor.role_id,
        run_id: req.id,
        purpose: 'run',
      },
    })
    try {
      harness.ctx.systemPrompt.section({
        name: MCP_SECTION,
        order: MCP_SERVERS,
        text: 'BROWSER-GUIDANCE',
      })
      harness.ctx.systemPrompt.section({
        name: 'tool:computer-use',
        order: TOOL_COMPUTER_USE,
        text: 'SCREENSHOT-GUIDANCE',
      })
      const text = await harness.systemText()
      expect(text).not.toContain('BROWSER-GUIDANCE')
      expect(text).not.toContain('SCREENSHOT-GUIDANCE')
    } finally {
      await harness.dispose()
    }
  })
})

describe('spike (c)：一个组合一个 provider；与"一工作区一 runtime"的关系', () => {
  it('provider 槽是独占的：第二个 provider 挂不上，报的是第一个的名字', async () => {
    const ctx = await bare()
    mountFakeBrowserProvider(ctx, 'playwright-mcp')
    expect(ctx.browserUse.providerName).toBe('playwright-mcp')
    expect(() => ctx.browserUse.register(BrowserUseProviderName('chrome-devtools-mcp'))).toThrow(
      /provider "playwright-mcp" is already registered/,
    )
  })

  it('释放之后可以换一个 provider（槽跟着 Cordis effect 走）', async () => {
    const ctx = await bare()
    const release = mountFakeBrowserProvider(ctx, 'playwright-mcp')
    await release()
    expect(ctx.browserUse.providerName).toBeUndefined()
    const second = ctx.browserUse.register(BrowserUseProviderName('chrome-devtools-mcp'))
    expect(ctx.browserUse.providerName).toBe('chrome-devtools-mcp')
    await second()
  })

  it('WP81 之后组合里有 `agents` 了：真 provider 还缺的只剩 `browserUse`（WP82 的活）', async () => {
    const req = makeRequest()
    const { sink } = collect()
    const harness = await createHarness({
      request: req,
      sink,
      provenance: new (await import('@agentsws/core')).Provenance(req.id),
      options: baseOptions(),
      buildStageIntent: () => undefined,
      buildDraftPayload: () => undefined,
      model: 'stub-v1',
      meta: {
        workspace_id: req.workspace_id,
        assignment_id: req.actor.assignment_id,
        role_id: req.actor.role_id,
        run_id: req.id,
        purpose: 'run',
      },
    })
    try {
      // 上游 playwright-mcp 的 inject 是 ['browserUse', 'agents', 'tools', 'systemPrompt']。
      // WP70 时四个里缺两个（`agents` / `browserUse`）；WP81 引进官方 Agent 层之后
      // 只缺 `browserUse` —— 挂上 provider 就能用，这正是 WP82 的入口。
      expect(harness.ctx.get('tools')).toBeDefined()
      expect(harness.ctx.get('systemPrompt')).toBeDefined()
      expect(typeof harness.ctx.get('agents')).toBe('object')
      expect(harness.agent.ctx).toBeDefined()
      expect(harness.ctx.get('browserUse')).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})
