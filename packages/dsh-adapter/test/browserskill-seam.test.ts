/**
 * 第二种浏览器：**用户正在用的那个浏览器**（腾讯 BrowserSkill，55 §10，WP92）。
 *
 * 与 `browser-seam.test.ts` 同一个结构，分两层：
 *
 * | 层 | 用什么 | 测什么 |
 * |---|---|---|
 * | 插件 | **真** `@wxg-prc-cpg/browser-skill-dsh-plugin` + **假 `bsk`**（一个回固定 JSON 的脚本） | 挂得上、六个工具、scope 语义、`lazyTools`、没装好就不挂 |
 * | 策略 | 真门禁（`installGate`）+ 同名的工具替身 | 读写按 `args.action`、三处白名单、两档策略、人接管 |
 *
 * **CI 里不装扩展、不出网**：假 `bsk` 是一个 `/bin/sh` 脚本，`echo` 一行 JSON 就退出。
 * 它证明的是装配与策略；真的连上一个浏览器、真的 observe 一次只能手工
 * （步骤见 `scripts/dev-browserskill.md`）。
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent, RuntimeAdapter } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as BrowserSkillPlugin from '@wxg-prc-cpg/browser-skill-dsh-plugin'
import { describe, expect, it, vi } from 'vitest'
import {
  applyBskEnv,
  BROWSERSKILL_TOOLS,
  BSK_NO_UPDATE_MANIFEST,
  browserSkillNavigationUrl,
  browserSkillPluginConfig,
  browserSkillToolName,
  bskBinaryUsable,
  classifySideEffect,
  createDshRuntime,
  createHarness,
  type DshRuntimeMode,
  type GateApi,
  installGate,
  isBrowserSkillHandoff,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

/**
 * 假 `bsk`：一个 `/bin/sh` 脚本，任何参数都回一行固定 JSON。
 *
 * 为什么非有一个不可（而不是随便指一个不存在的路径）：插件加载时会 spawn 一次
 * `bsk --version` 探活。指到不存在的文件时那个子进程 spawn 失败却仍被记进它的
 * in-flight 表，卸载时 `killAll()` 给一个**没有 pid** 的子进程发 SIGINT——信号落到
 * 跑测试的这个进程组上，vitest 当场没了。`bskBinaryUsable()` 就是为这条而存在的。
 */
const BSK_DIR = mkdtempSync(join(tmpdir(), 'agentsws-bsk-test-'))
const FAKE_BSK = join(BSK_DIR, 'bsk')
writeFileSync(FAKE_BSK, '#!/bin/sh\necho \'{"ok":true}\'\nexit 0\n', 'utf8')
chmodSync(FAKE_BSK, 0o755)

const KOL = {
  browser: { mode: 'browserskill', bsk_path: FAKE_BSK } as const,
  allowed_hosts: ['youtube.com', '*.youtube.com'],
}

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

/** 裸组合（不含 Agent 层），用来测 dsh 自己的语义。 */
async function bare(): Promise<Context> {
  const root = new Context()
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  return new Promise<Context>((resolve) => {
    root.plugin({
      name: 'probe',
      inject: ['tools', 'systemPrompt'],
      apply: (c: Context) => resolve(c),
    })
  })
}

/** 与上游同名的工具替身（六个多态工具，入参里有 action / url）。 */
const standIn = (name: string) =>
  defineTool({
    name,
    description: `browserskill ${name}`,
    parameters: { action: { type: 'string' }, url: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    async execute() {
      return { ok: true } as never
    },
  })

type RunEventList = ReturnType<typeof collect>['events']

/**
 * 真门禁 + 同名替身。替身注册在 `createScope(ctx, agent)` 里而不是全局——
 * 这一点必须与真插件一致（实测：挂在 Agent 的 scoped ctx 上，注册就是 scoped 的）。
 */
async function gateOnBare(
  req: ReturnType<typeof makeRequest>,
  over: Partial<Parameters<typeof installGate>[1]['options']> = {},
): Promise<{ gate: GateApi; events: RunEventList; dispose(): Promise<void> }> {
  const ctx = await bare()
  const agent = { preset: req.runtime.preset, run_id: req.id }
  const scope = createScope(ctx, agent)
  for (const name of BROWSERSKILL_TOOLS) scope.ctx.tools.register(standIn(name))
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

describe('(a) 真插件：挂得上，六个工具，与官方 provider 同一个位置', () => {
  it('RunRequest.browser{mode:browserskill} → 六个工具进这个 Agent 的 scope', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools
        .schemas(harness.agent as never)
        .map((s) => s.name)
        .filter((n) => browserSkillToolName(n) !== undefined)
        .sort()
      expect(names).toEqual([...BROWSERSKILL_TOOLS].sort())
      expect(names).toHaveLength(6)
      // 这一档**不走** `dsh-browser-use` 那个 seam：连服务都不挂
      expect(harness.ctx.get('browserUse')).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('职责自己的工具照常在，两边互不遮挡（restrict 只管全局注册的那些）', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(names).toContain('get_order')
      expect(names.filter((n) => browserSkillToolName(n) !== undefined)).toHaveLength(6)
    } finally {
      await harness.dispose()
    }
  })

  it('插件的六个工具是 scoped registration：**不能**列进 restrict（列了当场抛）', async () => {
    const ctx = await bare()
    const agent = { id: 'a1' }
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin(BrowserSkillPlugin, {
      ...browserSkillPluginConfig({ mode: 'browserskill', bsk_path: FAKE_BSK }),
    } as never)
    try {
      expect(ctx.tools.schemas(agent as never)).toHaveLength(6)
      // AGENT-LAYER §9.4 的那条上游语义，对这个插件同样成立
      expect(() => scope.ctx.tools.restrict({ allow: [...BROWSERSKILL_TOOLS] })).toThrow(
        /unknown global tools/,
      )
    } finally {
      await scope.dispose()
    }
  })

  it('lazyTools 必须是 false：上游缺省 true 时我们这棵树里一个工具都不会有', async () => {
    expect(browserSkillPluginConfig({ mode: 'browserskill', bsk_path: FAKE_BSK }).lazyTools).toBe(
      false,
    )
    const ctx = await bare()
    const agent = { id: 'b1' }
    const scope = createScope(ctx, agent)
    // 上游缺省：工具要等 `browser-skill` 这个技能被成功调用过一次才注册，
    // 而我们的组合里没有 skill 那一层，触发器一辈子不会响
    await scope.ctx.plugin(BrowserSkillPlugin, {
      bskPath: FAKE_BSK,
      lazyTools: true,
      observationEnabled: false,
      maxSessions: 1,
    } as never)
    try {
      expect(ctx.tools.schemas(agent as never)).toHaveLength(0)
    } finally {
      await scope.dispose()
    }
  })

  it('bsk 没装好就不挂：这次运行明明白白地失败（而不是悄悄没有浏览器）', async () => {
    const missing = join(BSK_DIR, 'not-installed-bsk')
    expect(bskBinaryUsable(missing)).toBe(false)
    expect(bskBinaryUsable(FAKE_BSK)).toBe(true)
    const req = makeRequest({ ...KOL, browser: { mode: 'browserskill', bsk_path: missing } })
    await expect(harnessOf(req)).rejects.toThrow(/BrowserSkill 没装好/u)
  })

  it('不给 RunRequest.browser → 一个浏览器工具都不存在', async () => {
    const req = makeRequest()
    const { harness } = await harnessOf(req)
    try {
      expect(
        harness.ctx.tools
          .schemas(harness.agent as never)
          .filter((s) => browserSkillToolName(s.name) !== undefined),
      ).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('两个更新开关都写进环境：既不自己换版本，也不去 GitHub 查', async () => {
    const env: NodeJS.ProcessEnv = { BSK_AUTO_UPDATE: 'on' }
    applyBskEnv(env)
    // ① 关"装"
    expect(env.BSK_AUTO_UPDATE).toBe('off')
    // ② 关"查"——实测 `off` 只关装不关查（daemon 照样每 30 分钟取一次 version.json）
    expect(env.BSK_UPDATE_MANIFEST_URL).toBe(BSK_NO_UPDATE_MANIFEST)
    expect(new URL(BSK_NO_UPDATE_MANIFEST).hostname).toBe('127.0.0.1')

    const before = { ...process.env }
    process.env.BSK_AUTO_UPDATE = 'on'
    delete process.env.BSK_UPDATE_MANIFEST_URL
    const { harness } = await harnessOf(makeRequest({ ...KOL }))
    try {
      // 插件 spawn `bsk` 时不传 env（原样继承本进程），所以这两条只能写在进程环境里
      expect(process.env.BSK_AUTO_UPDATE).toBe('off')
      expect(process.env.BSK_UPDATE_MANIFEST_URL).toBe(BSK_NO_UPDATE_MANIFEST)
    } finally {
      await harness.dispose()
      for (const name of ['BSK_AUTO_UPDATE', 'BSK_UPDATE_MANIFEST_URL']) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
  })
})

describe('(b) 提示词：这一种独有的三条规矩进 persona 段', () => {
  it('单独窗口 / 借标签要问 / 卡住了请人接管——三条都在', async () => {
    const req = makeRequest({ ...KOL })
    const { harness } = await harnessOf(req)
    try {
      const text = await harness.systemText()
      expect(text).toContain('## 浏览器')
      expect(text).toContain('youtube.com')
      expect(text).toContain('用户自己那个浏览器')
      expect(text).toContain('单独的 Agent 窗口')
      expect(text).toContain('request-help')
      // 两种方式共用的那两条也还在（55 §3）
      expect(text).toContain('遇到登录页、验证码、两步验证就停下')
    } finally {
      await harness.dispose()
    }
  })

  it('官方 provider 那一种不会多出这三条（两种方式的提示词不串味）', async () => {
    const req = makeRequest({
      browser: { mode: 'launch', headless: true },
      allowed_hosts: ['youtube.com'],
    })
    const { harness } = await harnessOf(req)
    try {
      const text = await harness.systemText()
      expect(text).toContain('## 浏览器')
      expect(text).not.toContain('单独的 Agent 窗口')
    } finally {
      await harness.dispose()
    }
  })
})

describe('(c) 读写分类：看 args.action（55 §10 那张表）', () => {
  const cases: [string, string, 'read_external' | 'write_external'][] = [
    ['browser_inspect', 'observe', 'read_external'],
    ['browser_inspect', 'snapshot', 'read_external'],
    ['browser_inspect', 'html', 'read_external'],
    ['browser_inspect', 'screenshot', 'read_external'],
    ['browser_inspect', 'console', 'read_external'],
    ['browser_inspect', 'network', 'read_external'],
    ['browser_page', 'navigate', 'read_external'],
    ['browser_page', 'back', 'read_external'],
    ['browser_page', 'forward', 'read_external'],
    ['browser_page', 'reload', 'read_external'],
    ['browser_page', 'wait', 'read_external'],
    ['browser_session', 'start', 'read_external'],
    ['browser_session', 'stop', 'read_external'],
    ['browser_session', 'list', 'read_external'],
    ['browser_tabs', 'list', 'read_external'],
    ['browser_tabs', 'select', 'read_external'],
    ['browser_tabs', 'create', 'write_external'],
    ['browser_tabs', 'close', 'write_external'],
    ['browser_tabs', 'borrow', 'write_external'],
    ['browser_tabs', 'return', 'write_external'],
    ['browser_interact', 'click', 'write_external'],
    ['browser_interact', 'fill', 'write_external'],
    ['browser_interact', 'press', 'write_external'],
    ['browser_interact', 'select', 'write_external'],
    ['browser_assist', 'resize', 'read_external'],
    ['browser_assist', 'emulate', 'read_external'],
    ['browser_assist', 'request-help', 'read_external'],
  ]
  it.each(cases)('%s{action:%s} → %s', (tool, action, expected) => {
    expect(classifySideEffect(tool, undefined, { action })).toBe(expected)
  })

  it('没给 action、或者上游新增的动作 → 一律按写（16 §3 最严）', () => {
    expect(classifySideEffect('browser_inspect')).toBe('write_external')
    expect(classifySideEffect('browser_page', undefined, { action: 'brand_new' })).toBe(
      'write_external',
    )
    expect(classifySideEffect('browser_tabs', undefined, { action: 42 })).toBe('write_external')
  })

  it('人接管认得出来（放行的同时要记一条）', () => {
    expect(isBrowserSkillHandoff('browser_assist', { action: 'request-help' })).toBe(true)
    expect(isBrowserSkillHandoff('browser_assist', { action: 'resize' })).toBe(false)
    expect(isBrowserSkillHandoff('browser_interact', { action: 'request-help' })).toBe(false)
  })
})

describe('(d) 域名白名单：三处 url 一处不漏', () => {
  it('三处认得出来，别的动作没有 url 可查', () => {
    expect(browserSkillNavigationUrl('browser_page', { action: 'navigate', url: 'x' })).toBe('x')
    expect(browserSkillNavigationUrl('browser_session', { action: 'start', url: 'x' })).toBe('x')
    expect(browserSkillNavigationUrl('browser_tabs', { action: 'create', url: 'x' })).toBe('x')
    // 该给地址却没给（navigate）→ 空串 → 按"打不开这个地址"拒
    expect(browserSkillNavigationUrl('browser_page', { action: 'navigate' })).toBe('')
    // 选填的两处不给 url = 开个空白窗口 / 空白标签，白名单没话说
    expect(browserSkillNavigationUrl('browser_session', { action: 'start' })).toBeUndefined()
    expect(browserSkillNavigationUrl('browser_tabs', { action: 'create' })).toBeUndefined()
    expect(browserSkillNavigationUrl('browser_interact', { action: 'click' })).toBeUndefined()
  })

  it('白名单内放行、白名单外拒，三处都一样（理由是人话）', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const good = await g.gate.execute('c_1', 'browser_page', {
        action: 'navigate',
        url: 'https://www.youtube.com/@someone',
      })
      expect(good.isError).toBe(false)

      const bad = await g.gate.execute('c_2', 'browser_page', {
        action: 'navigate',
        url: 'https://www.amazon.com/dp/B000',
      })
      expect(bad.isError).toBe(true)
      expect(g.gate.records.get('c_2')?.reason).toContain('www.amazon.com 不在里面')

      const session = await g.gate.execute('c_3', 'browser_session', {
        action: 'start',
        url: 'https://evil.example.com/',
      })
      expect(session.isError).toBe(true)
      expect(g.gate.records.get('c_3')?.reason).toContain('evil.example.com 不在里面')

      const tab = await g.gate.execute('c_4', 'browser_tabs', {
        action: 'create',
        url: 'https://evil.example.com/',
      })
      expect(tab.isError).toBe(true)
      expect(g.gate.records.get('c_4')?.reason).toContain('evil.example.com 不在里面')
      // Model-visible ⟺ logged
      expect(
        g.events.filter((e) => e.type === 'tool.result' && e.status === 'blocked'),
      ).toHaveLength(3)
    } finally {
      await g.dispose()
    }
  })

  it('职责没填 browser_scope（allowed_hosts 空）→ 任何导航都拒', async () => {
    const req = makeRequest({
      browser: { mode: 'browserskill', bsk_path: FAKE_BSK },
      side_effect_policy: 'personal',
    })
    const g = await gateOnBare(req)
    try {
      const res = await g.gate.execute('c_1', 'browser_page', {
        action: 'navigate',
        url: 'https://www.youtube.com/',
      })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('没有开放任何网站')
    } finally {
      await g.dispose()
    }
  })

  it('URL 不是 URL → 拒，而不是"没有 host 所以放行"', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const res = await g.gate.execute('c_1', 'browser_page', {
        action: 'navigate',
        url: 'youtube.com',
      })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('打不开这个地址')
    } finally {
      await g.dispose()
    }
  })
})

describe('(e) 两档策略：公司端拒写、个人端放行并留痕', () => {
  it('executor 档：点击、借标签一律拒（现成的 tool.result{blocked}）', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }))
    try {
      const click = await g.gate.execute('c_1', 'browser_interact', {
        action: 'click',
        target: '@e3',
      })
      expect(click.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toContain('write_external_requires_executor')

      const borrow = await g.gate.execute('c_2', 'browser_tabs', { action: 'borrow', tabId: '7' })
      expect(borrow.isError).toBe(true)
      expect(g.gate.records.get('c_2')?.reason).toContain('write_external_requires_executor')
    } finally {
      await g.dispose()
    }
  })

  it('executor 档：看页面照样放行（不然连看一眼都做不到）', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'executor' }))
    try {
      const res = await g.gate.execute('c_1', 'browser_inspect', { action: 'observe' })
      expect(res.isError).toBe(false)
    } finally {
      await g.dispose()
    }
  })

  it('personal 档：写放行，并记一条 progress{browser_write}', async () => {
    const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: 'personal' }))
    try {
      const res = await g.gate.execute('c_1', 'browser_interact', {
        action: 'fill',
        target: '@e3',
        value: 'hi',
      })
      expect(res.isError).toBe(false)
      expect(
        g.events.some(
          (e: RunEvent) =>
            e.type === 'progress' && e.step === 'browser_write' && e.note === 'browser_interact',
        ),
      ).toBe(true)
    } finally {
      await g.dispose()
    }
  })

  it('人接管（request-help）两档都放行，并记一条 progress{browser_handoff}', async () => {
    for (const policy of ['personal', 'executor'] as const) {
      const g = await gateOnBare(makeRequest({ ...KOL, side_effect_policy: policy }))
      try {
        const res = await g.gate.execute('c_1', 'browser_assist', {
          action: 'request-help',
          prompt: '请你登录一下',
        })
        expect(res.isError, policy).toBe(false)
        expect(
          g.events.some(
            (e: RunEvent) =>
              e.type === 'progress' && e.step === 'browser_handoff' && e.note === 'browser_assist',
          ),
          policy,
        ).toBe(true)
      } finally {
        await g.dispose()
      }
    }
  })

  it('不给 browser 时这六个名字不在 allowlist 里 → blocked（不是"没这个工具"）', async () => {
    const g = await gateOnBare(makeRequest())
    try {
      const res = await g.gate.execute('c_1', 'browser_inspect', { action: 'observe' })
      expect(res.isError).toBe(true)
      expect(g.gate.records.get('c_1')?.reason).toBe('not_in_allowlist: browser_inspect')
    } finally {
      await g.dispose()
    }
  })
})

describe('(f) 两档 headless 各跑一次带 browserskill 的运行', () => {
  const MODES: Exclude<DshRuntimeMode, 'auto'>[] = ['in-process', 'subprocess']
  it.each(MODES)('%s：挂着插件跑完一整次运行（假 bsk，不出网、不装扩展）', async (mode) => {
    const runtime: RuntimeAdapter = createDshRuntime({ ...baseOptions(), mode })
    const { sink, events } = collect()
    const req = makeRequest({ ...KOL, side_effect_policy: 'personal' })
    const result = await runtime.run(req, sink, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
