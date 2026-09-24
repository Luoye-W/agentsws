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
import { readFileSync } from 'node:fs'
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
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

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
