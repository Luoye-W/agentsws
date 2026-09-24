/**
 * WP144（docs/80）：电脑操控——官方 `dsh-computer-use` + Cua Driver **MCP** 提供方。
 *
 * 与 `browser-seam.test.ts` / `browserskill-seam.test.ts` 同一个结构：
 *
 * | 层 | 用什么 | 测什么 |
 * |---|---|---|
 * | 提供方 | **真**官方提供方 + **假驱动**（一个讲 MCP stdio 的 node 脚本） | 挂得上、工具报上来、独占槽、没装好就不挂、驱动起不来不打死我们、卸载时驱动退出 |
 * | 门禁 | 真门禁（经 `harness.gate.execute` 走 dsh 工具流水线） | 没授权全拒、授权过期拒、硬拒、截图不进模型、人接手 |
 * | 两档 | 进程内 / 子进程 | 授权卡经宿主回调出得来 |
 *
 * **CI 里不启动真驱动、不动这台电脑**：假驱动只回固定 JSON；真驱动的手工步骤见
 * `scripts/dev-computer-use.md`（实现方不跑，留给 Luoye / Fable）。
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Completion, RunComputerUse, RunEvent, RuntimeAdapter } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { describe, expect, it, vi } from 'vitest'
import {
  applyCuaEnv,
  COMPUTER_HANDOFF_TOOL,
  CUA_ENV,
  CUA_TOOL_PREFIX,
  classifySideEffect,
  computerUseProviderConfig,
  createDshRuntime,
  createHarness,
  cuaDriverUsable,
  cuaToolName,
  type DshRuntimeMode,
  type DshRuntimeOptions,
  type ModelGatewayLike,
  REQUEST_COMPUTER_USE_TOOL,
  redactComputerUseValue,
  SCREENSHOT_OMITTED,
  subprocessAvailable,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const DIR = mkdtempSync(join(tmpdir(), 'agentsws-cua-test-'))
const LOG = join(DIR, 'driver.log')
const PNG_B64 = 'iVBORw0KGgo'.padEnd(6000, 'A')

/**
 * 假驱动：讲 MCP stdio（一行一条 JSON-RPC）的 node 脚本。工具名照上游驱动取几样
 * （列应用、读窗口、点击、查更新、查权限）。每次起来与每次调用都记一行日志——
 * 测试据此看它收到了什么、环境里两个开关关没关、卸载时退没退。
 */
const FAKE_DRIVER = join(DIR, 'cua-driver')
writeFileSync(
  FAKE_DRIVER,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const log = (o) => appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(o) + '\\n')
log({ start: process.pid, argv: process.argv.slice(2), telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, update: process.env.CUA_DRIVER_RS_UPDATE_CHECK })
process.on('exit', () => log({ exit: process.pid }))
const tools = ['list_apps', 'get_window_state', 'click', 'check_for_update', 'check_permissions'].map((name) => ({
  name,
  description: 'fake ' + name,
  inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, screenshot_out_file: { type: 'string' }, prompt: { type: 'boolean' } } },
}))
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
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-cua-driver', version: '0.28.0' } })
    else if (msg.method === 'tools/list') reply({ tools })
    else if (msg.method === 'ping') reply({})
    else if (msg.method === 'tools/call') {
      log({ call: msg.params.name, args: msg.params.arguments })
      if (msg.params.name === 'get_window_state') reply({ content: [{ type: 'text', text: 'tree_markdown: AXWindow "Notes"' }, { type: 'image', data: ${JSON.stringify(PNG_B64)}, mimeType: 'image/png' }] })
      else reply({ content: [{ type: 'text', text: 'ok ' + msg.params.name }] })
    } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no ' + msg.method } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  'utf8',
)
chmodSync(FAKE_DRIVER, 0o755)

/** 一个起来就退出、一句 MCP 都不讲的"驱动"（装坏了 / 不是那个文件）。 */
const BROKEN_DRIVER = join(DIR, 'broken-driver')
writeFileSync(BROKEN_DRIVER, '#!/bin/sh\necho "not an mcp server" >&2\nexit 3\n', 'utf8')
chmodSync(BROKEN_DRIVER, 0o755)

const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function cuOf(over: Partial<RunComputerUse> = {}): RunComputerUse {
  return { command: FAKE_DRIVER, args: ['mcp'], minutes: 10, ...over }
}
const GRANTED = (over: Partial<RunComputerUse> = {}) =>
  cuOf({ granted_until: iso(T0 + 10 * 60_000), grant_id: 'apv_cu_1', ...over })

function driverLog(): Record<string, unknown>[] {
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

const meta = (req: ReturnType<typeof makeRequest>) => ({
  workspace_id: req.workspace_id,
  assignment_id: req.actor.assignment_id,
  role_id: req.actor.role_id,
  run_id: req.id,
  purpose: 'run' as const,
})

async function harnessOf(
  req: ReturnType<typeof makeRequest>,
  over: Partial<DshRuntimeOptions> = {},
) {
  const { sink, events } = collect()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions({ wallClockMs: () => T0, ...over }),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    model: 'stub-v1',
    meta: meta(req),
  })
  return { harness, events }
}

const cuaNames = (names: string[]) => names.filter((n) => cuaToolName(n) !== undefined).sort()

describe('(a) 真提供方 + 假驱动：批过才挂，挂得上', () => {
  it('授权中 → 驱动报的工具以 mcp__cua-driver-mcp__ 前缀进这个 Agent 的 scope；独占槽登记着', async () => {
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(cuaNames(names)).toEqual(
        ['check_for_update', 'check_permissions', 'click', 'get_window_state', 'list_apps'].map(
          (n) => `${CUA_TOOL_PREFIX}${n}`,
        ),
      )
      // 职责自己的工具照常在；授权中给的是「交还给人」那一个，不是「请求授权」
      expect(names).toContain('get_order')
      expect(names).toContain(COMPUTER_HANDOFF_TOOL)
      expect(names).not.toContain(REQUEST_COMPUTER_USE_TOOL)
      const registry = harness.ctx.get('computerUse') as { providerName?: string }
      expect(registry.providerName).toBe('cua-driver-mcp')
    } finally {
      await harness.dispose()
    }
  })

  it('还没批 → 提供方不挂、驱动一个进程都不起；模型只看得见 request_computer_use', async () => {
    const before = driverLog().length
    const req = makeRequest({ computer_use: cuOf() })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(cuaNames(names)).toEqual([])
      expect(names).toContain(REQUEST_COMPUTER_USE_TOOL)
      expect(names).not.toContain(COMPUTER_HANDOFF_TOOL)
      expect(harness.ctx.get('computerUse')).toBeUndefined()
      expect(driverLog().length).toBe(before)
    } finally {
      await harness.dispose()
    }
  })

  it('授权已过期 → 与没批一样：不挂提供方', async () => {
    const req = makeRequest({ computer_use: GRANTED({ granted_until: iso(T0 - 1) }) })
    const { harness } = await harnessOf(req)
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(cuaNames(names)).toEqual([])
      expect(names).toContain(REQUEST_COMPUTER_USE_TOOL)
    } finally {
      await harness.dispose()
    }
  })

  it('不给 computer_use → 两个自有工具与驱动工具一个都没有', async () => {
    const { harness } = await harnessOf(makeRequest())
    try {
      const names = harness.ctx.tools.schemas(harness.agent as never).map((s) => s.name)
      expect(cuaNames(names)).toEqual([])
      expect(names).not.toContain(REQUEST_COMPUTER_USE_TOOL)
      expect(names).not.toContain(COMPUTER_HANDOFF_TOOL)
    } finally {
      await harness.dispose()
    }
  })

  it('驱动没装（路径指错）→ 挂之前就拒，这次运行明明白白地失败；我们的进程活着', async () => {
    const missing = join(DIR, 'not-installed-cua-driver')
    expect(cuaDriverUsable(missing)).toBe(false)
    expect(cuaDriverUsable(FAKE_DRIVER)).toBe(true)
    const req = makeRequest({ computer_use: GRANTED({ command: missing }) })
    await expect(harnessOf(req)).rejects.toThrow(/电脑操控的驱动没装好/u)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('驱动起来就退（不讲 MCP）→ 提供方激活失败、回滚；不会把我们自己的进程打死', async () => {
    const req = makeRequest({ computer_use: GRANTED({ command: BROKEN_DRIVER }) })
    await expect(harnessOf(req)).rejects.toThrow()
    // 还活着：WP92 那条「信号落到我们自己的进程组」的坑，这一种不会踩
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('卸载 = 驱动退出（点「停止」就是 dispose 这棵树）；两个开关在驱动的环境里是关的', async () => {
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness } = await harnessOf(req)
    const starts = driverLog().filter((l) => typeof l.start === 'number')
    const mine = starts.at(-1)
    expect(mine?.telemetry).toBe('false')
    expect(mine?.update).toBe('false')
    expect(mine?.argv).toEqual(['mcp'])
    await harness.dispose()
    await new Promise((r) => setTimeout(r, 300))
    expect(driverLog().some((l) => l.exit === mine?.start)).toBe(true)
  })

  it('提供方配置：不自动重连、一次调用 60 秒上限、参数原样', () => {
    const cfg = computerUseProviderConfig(cuOf({ args: ['mcp', '--direct'] }))
    expect(cfg).toEqual({
      command: FAKE_DRIVER,
      args: ['mcp', '--direct'],
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    })
    const env: NodeJS.ProcessEnv = { CUA_DRIVER_RS_TELEMETRY_ENABLED: 'true' }
    applyCuaEnv(env)
    expect(env).toEqual({ ...CUA_ENV })
  })
})

describe('(b) 门禁：驱动工具全部按写、只看授权窗口', () => {
  it('分类：驱动的每个工具（含截图 / 列窗口）都是 write_external', () => {
    for (const n of ['list_apps', 'get_window_state', 'screenshot', 'whatever_new_tool']) {
      expect(classifySideEffect(`${CUA_TOOL_PREFIX}${n}`)).toBe('write_external')
    }
  })

  it('授权中：放行，并在时间线上留一行 progress{computer_use}（公司端策略的请求也一样只看授权）', async () => {
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness, events } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_1', `${CUA_TOOL_PREFIX}list_apps`, {})
      expect(res.isError).toBe(false)
      expect(events).toContainEqual({
        type: 'progress',
        step: 'computer_use',
        note: `${CUA_TOOL_PREFIX}list_apps`,
      })
      expect(driverLog().some((l) => l.call === 'list_apps')).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('授权过期：立刻拒（墙钟走过 granted_until 之后的下一次调用）', async () => {
    let now = T0
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness } = await harnessOf(req, { wallClockMs: () => now })
    try {
      now = T0 + 10 * 60_000 + 1
      const calls = driverLog().filter((l) => l.call === 'click').length
      const res = await harness.gate.execute('c_2', `${CUA_TOOL_PREFIX}click`, { pid: 1 })
      expect(res.isError).toBe(true)
      expect(harness.gate.records.get('c_2')?.reason).toMatch(/^computer_use_expired/u)
      // 驱动根本没收到这一次
      expect(driverLog().filter((l) => l.call === 'click').length).toBe(calls)
    } finally {
      await harness.dispose()
    }
  })

  it('查更新 / 往磁盘写截图：授权中也硬拒', async () => {
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness } = await harnessOf(req)
    try {
      await harness.gate.execute('c_3', `${CUA_TOOL_PREFIX}check_for_update`, {})
      expect(harness.gate.records.get('c_3')?.reason).toMatch(/^computer_use_tool_denied/u)
      await harness.gate.execute('c_4', `${CUA_TOOL_PREFIX}get_window_state`, {
        pid: 1,
        window_id: 2,
        screenshot_out_file: '/tmp/x.png',
      })
      expect(harness.gate.records.get('c_4')?.reason).toMatch(/^computer_use_arg_denied/u)
    } finally {
      await harness.dispose()
    }
  })

  it('截图不进模型：结果里的图片块与 base64 换成一句说明', async () => {
    const req = makeRequest({ computer_use: GRANTED() })
    const seen: unknown[] = []
    const { harness } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_5', `${CUA_TOOL_PREFIX}get_window_state`, {
        pid: 1,
        window_id: 2,
      })
      expect(res.isError).toBe(false)
      seen.push(res.isError ? undefined : res.value)
      const text = JSON.stringify(seen)
      expect(text).not.toContain(PNG_B64.slice(0, 64))
      expect(text).toContain('tree_markdown')
    } finally {
      await harness.dispose()
    }
    expect(redactComputerUseValue({ content: [{ type: 'image', data: PNG_B64 }] })).toEqual({
      content: [{ type: 'text', text: SCREENSHOT_OMITTED }],
    })
    expect(redactComputerUseValue({ screenshot_png_b64: PNG_B64, ok: 'short' })).toEqual({
      screenshot_png_b64: SCREENSHOT_OMITTED,
      ok: 'short',
    })
  })

  it('没批：驱动工具一个都调不到（连工具都不存在）', async () => {
    const req = makeRequest({ computer_use: cuOf() })
    const { harness } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_6', `${CUA_TOOL_PREFIX}list_apps`, {})
      expect(res.isError).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe('(c) 授权卡 / 接手卡：经宿主回调出卡，批了才挂', () => {
  it('没批时调 request_computer_use → 宿主出一张 computer_use 卡，事件与产出登记', async () => {
    const asked: { stage: string; reason: string }[] = []
    const req = makeRequest({ computer_use: cuOf() })
    const { harness, events } = await harnessOf(req, {
      requestComputerUse: async ({ stage, reason }) => {
        asked.push({ stage, reason })
        return { approval_item_id: 'apv_cu_9' }
      },
    })
    try {
      const res = await harness.gate.execute('c_7', REQUEST_COMPUTER_USE_TOOL, {
        reason: '在记事本里整理今天的发货单',
      })
      expect(res.isError).toBe(false)
      expect(asked).toEqual([{ stage: 'authorize', reason: '在记事本里整理今天的发货单' }])
      expect(events).toContainEqual({
        type: 'proposal.created',
        approval_item_id: 'apv_cu_9',
        kind: 'computer_use',
      })
      expect(harness.gate.outputs).toContainEqual({
        kind: 'proposal',
        approval_item_id: 'apv_cu_9',
      })
    } finally {
      await harness.dispose()
    }
  })

  it('宿主没接这条路 → 请求工具失败（fail-closed），不会有任何授权', async () => {
    const req = makeRequest({ computer_use: cuOf() })
    const { harness } = await harnessOf(req)
    try {
      const res = await harness.gate.execute('c_8', REQUEST_COMPUTER_USE_TOOL, { reason: 'x' })
      expect(res.isError).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('授权中调 computer_handoff → 出接手卡；之后这次运行再碰电脑一律拒', async () => {
    const asked: string[] = []
    const req = makeRequest({ computer_use: GRANTED() })
    const { harness, events } = await harnessOf(req, {
      requestComputerUse: async ({ stage }) => {
        asked.push(stage)
        return { approval_item_id: 'apv_cu_h' }
      },
    })
    try {
      const res = await harness.gate.execute('c_9', COMPUTER_HANDOFF_TOOL, {
        reason: '店铺后台要你输入短信验证码',
      })
      expect(res.isError).toBe(false)
      expect(asked).toEqual(['handoff'])
      expect(events).toContainEqual({
        type: 'progress',
        step: 'computer_handoff',
        note: '店铺后台要你输入短信验证码',
      })
      await harness.gate.execute('c_10', `${CUA_TOOL_PREFIX}click`, { pid: 1 })
      expect(harness.gate.records.get('c_10')?.reason).toMatch(/^computer_use_handed_off/u)
    } finally {
      await harness.dispose()
    }
  })

  it('提示词：没批时教它怎么请求，批了教它遇到密码 / 验证码停下', async () => {
    const a = await harnessOf(makeRequest({ computer_use: cuOf() }))
    try {
      const text = await a.harness.systemText()
      expect(text).toContain('操作这台电脑')
      expect(text).toContain(REQUEST_COMPUTER_USE_TOOL)
      expect(text).toContain('接下来 10 分钟')
    } finally {
      await a.harness.dispose()
    }
    const b = await harnessOf(makeRequest({ computer_use: GRANTED() }))
    try {
      const text = await b.harness.systemText()
      expect(text).toContain(COMPUTER_HANDOFF_TOOL)
      expect(text).toContain('密码')
      expect(text).toContain('验证码')
      expect(text).toContain('截图不会传给你')
    } finally {
      await b.harness.dispose()
    }
  })
})

/** 第一步调 request_computer_use，第二步收尾——只为验证两档都能把卡经宿主出出来。 */
function scriptedGateway(): ModelGatewayLike {
  let step = 0
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    async complete() {
      step += 1
      return step === 1
        ? done('', [
            { id: 'call_cu_1', name: REQUEST_COMPUTER_USE_TOOL, input: { reason: '整理发货单' } },
          ])
        : done('已发出授权卡，批准后我再接着做。')
    },
  }
}

describe('(d) 两档 headless：授权卡经宿主回调出得来', () => {
  const MODES: Exclude<DshRuntimeMode, 'auto'>[] = subprocessAvailable()
    ? ['in-process', 'subprocess']
    : ['in-process']
  it.each(MODES)('%s：模型请求操作电脑 → 宿主收到 authorize 卡', async (mode) => {
    const asked: string[] = []
    const runtime: RuntimeAdapter = createDshRuntime({
      ...baseOptions(),
      gateway: scriptedGateway(),
      mode,
      requestComputerUse: async ({ stage, request }) => {
        asked.push(`${stage}:${request.id}`)
        return { approval_item_id: 'apv_cu_run' }
      },
    })
    const { sink, events } = collect()
    const req = makeRequest({ computer_use: cuOf(), id: `run_cu_${mode}` })
    const result = await runtime.run(req, sink, new AbortController().signal)
    expect(result.status).not.toBe('failed')
    expect(asked).toEqual([`authorize:run_cu_${mode}`])
    expect(
      events.some((e: RunEvent) => e.type === 'proposal.created' && e.kind === 'computer_use'),
    ).toBe(true)
  })
})
