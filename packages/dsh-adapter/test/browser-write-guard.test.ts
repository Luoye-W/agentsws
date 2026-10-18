/**
 * WP387（docs/103 v2 T1）：**`google.com/alerts` 上的写操作，只在那张卡同意之后的那次运行里放行**。
 *
 * 两层：纯函数（`createBrowserWriteGuard` 认当前页）+ 真门禁（`installGate`，同名工具替身）。
 */
import type { RunEvent } from '@agentsws/contracts'
import { Provenance } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { BROWSERSKILL_TOOLS, createBrowserWriteGuard, installGate } from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const ALERTS = 'https://www.google.com/alerts'
const GRANT = [{ change_kind: 'google_alert_change' as const, change_id: 'chg_1' }]
const W = 'write_external'
const R = 'read_external'

describe('纯函数：认当前页', () => {
  it('没有卡：打开提醒页放行（只是去看），在上面点 / 输入一律拦，理由是人话', () => {
    const g = createBrowserWriteGuard(undefined)
    expect(
      g.check({ tool: 'bsk_page', args: { action: 'navigate', url: ALERTS }, effect: R }),
    ).toBe(undefined)
    expect(g.check({ tool: 'bsk_inspect', args: { action: 'snapshot' }, effect: R })).toBe(
      undefined,
    )
    const denied = g.check({ tool: 'bsk_interact', args: { action: 'click' }, effect: W })
    expect(denied).toMatch(/^browser_write_needs_card: /)
    expect(denied).toContain('Google')
    expect(g.check({ tool: 'bsk_interact', args: { action: 'fill' }, effect: W })).toBeDefined()
  })

  it('有同意过的卡：提醒页上照样放行', () => {
    const g = createBrowserWriteGuard(GRANT)
    g.check({ tool: 'bsk_page', args: { action: 'navigate', url: `${ALERTS}?hl=en` }, effect: R })
    expect(g.check({ tool: 'bsk_interact', args: { action: 'click' }, effect: W })).toBe(undefined)
  })

  it('别的页面不管（个人档的写照旧放行）；离开提醒页之后也不管', () => {
    const g = createBrowserWriteGuard(undefined)
    g.check({
      tool: 'bsk_page',
      args: { action: 'navigate', url: 'https://www.google.com/search?q=x' },
      effect: R,
    })
    expect(g.check({ tool: 'bsk_interact', args: { action: 'fill' }, effect: W })).toBe(undefined)
    g.check({ tool: 'bsk_page', args: { action: 'navigate', url: ALERTS }, effect: R })
    g.check({
      tool: 'bsk_page',
      args: { action: 'navigate', url: 'https://example.com/' },
      effect: R,
    })
    expect(g.check({ tool: 'bsk_interact', args: { action: 'click' }, effect: W })).toBe(undefined)
  })

  it('换 / 借标签、回退之后认不出停在哪：到过提醒页就当还在（最严），没到过就当不在', () => {
    const touched = createBrowserWriteGuard(undefined)
    touched.check({ tool: 'bsk_session', args: { action: 'start', url: ALERTS }, effect: R })
    expect(
      touched.check({ tool: 'bsk_tabs', args: { action: 'borrow', id: '3' }, effect: W }),
    ).toBe(undefined)
    expect(
      touched.check({ tool: 'bsk_interact', args: { action: 'click' }, effect: W }),
    ).toBeDefined()
    const back = createBrowserWriteGuard(undefined)
    back.check({ tool: 'bsk_tabs', args: { action: 'create', url: ALERTS }, effect: W })
    back.check({ tool: 'bsk_page', args: { action: 'back' }, effect: R })
    expect(back.state().unknown).toBe(true)
    expect(back.check({ tool: 'bsk_interact', args: { action: 'press' }, effect: W })).toBeDefined()
    const never = createBrowserWriteGuard(undefined)
    never.check({ tool: 'bsk_tabs', args: { action: 'select', id: '2' }, effect: R })
    expect(never.check({ tool: 'bsk_interact', args: { action: 'click' }, effect: W })).toBe(
      undefined,
    )
  })

  it('官方 provider 那一种（Playwright）同一条规矩', () => {
    const g = createBrowserWriteGuard(undefined)
    g.check({ tool: 'mcp__playwright-mcp__browser_navigate', args: { url: ALERTS }, effect: R })
    expect(
      g.check({ tool: 'mcp__playwright-mcp__browser_click', args: { ref: 'e1' }, effect: W }),
    ).toBeDefined()
  })
})

/** 裸组合（不含 Agent 层）。 */
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

const standIn = (name: string) =>
  defineTool({
    name,
    description: `browserskill ${name}`,
    parameters: { action: { type: 'string' }, url: { type: 'string' }, id: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    async execute() {
      return { ok: true } as never
    },
  })

async function gateOf(req: ReturnType<typeof makeRequest>) {
  const ctx = await bare()
  const agent = { preset: req.runtime.preset, run_id: req.id }
  const scope = createScope(ctx, agent)
  for (const name of BROWSERSKILL_TOOLS) scope.ctx.tools.register(standIn(name))
  const { sink, events } = collect()
  const gate = installGate(ctx, {
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions({}),
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

const PR = {
  browser: { mode: 'browserskill', bsk_path: '/nonexistent/bsk' } as const,
  allowed_hosts: ['www.google.com'],
  side_effect_policy: 'personal' as const,
}

describe('真门禁：个人档也要先有卡', () => {
  it('没卡：提醒页上点「创建提醒」被拦成 tool.result{blocked}，不留 browser_write', async () => {
    const g = await gateOf(makeRequest(PR))
    try {
      expect(
        (await g.gate.execute('c_1', 'bsk_page', { action: 'navigate', url: ALERTS })).isError,
      ).toBe(false)
      const res = await g.gate.execute('c_2', 'bsk_interact', { action: 'click', target: '@e9' })
      expect(res.isError).toBe(true)
      expect(
        g.events.some(
          (e: RunEvent) =>
            e.type === 'tool.result' &&
            e.status === 'blocked' &&
            String(e.reason).startsWith('browser_write_needs_card'),
        ),
      ).toBe(true)
      expect(
        g.events.some((e: RunEvent) => e.type === 'progress' && e.step === 'browser_write'),
      ).toBe(false)
    } finally {
      await g.dispose()
    }
  })

  it('有卡（服务端写上的 browser_grants）：放行，并照旧留一条 browser_write', async () => {
    const g = await gateOf(makeRequest({ ...PR, browser_grants: GRANT }))
    try {
      await g.gate.execute('c_1', 'bsk_page', { action: 'navigate', url: ALERTS })
      const res = await g.gate.execute('c_2', 'bsk_interact', { action: 'click', target: '@e9' })
      expect(res.isError).toBe(false)
      expect(
        g.events.some((e: RunEvent) => e.type === 'progress' && e.step === 'browser_write'),
      ).toBe(true)
    } finally {
      await g.dispose()
    }
  })
})
