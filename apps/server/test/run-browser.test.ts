/**
 * WP95（`docs/upstream/sidebar-compare.md` #12 / #15）：把一次运行的事件折成
 * 第三栏「运行中的浏览器」那五格。
 *
 * 钉三件事：
 * 1. **两种执行器各认各的**（官方 provider 按前缀、BrowserSkill 按裸名）；
 * 2. **只给域名**——网址里的路径与 query 一个字都不往外端（21 敏感级）；
 * 3. **等人接管**是一个会被下一次动手清掉的状态，而且跑完了就不再挂着。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { summarizeRunBrowser } from '../src/run-browser.js'

let seq = 0

function ev(
  type: string,
  payload: unknown,
  at = `2026-09-18T02:0${seq % 10}:00.000Z`,
): EventEnvelope {
  seq += 1
  return {
    id: `ev_${seq}`,
    schema_version: 1,
    workspace_id: 'ws_1',
    type,
    at,
    actor: { kind: 'agent', id: 'agent', run_id: 'run_1' },
    correlation: { trace_id: 'tr_1', run_id: 'run_1' },
    payload,
  }
}

describe('哪种执行器', () => {
  it('官方 provider：工具名带 `mcp__playwright-mcp__` 前缀', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', {
        call_id: 'c1',
        tool: 'mcp__playwright-mcp__browser_navigate',
        input: { url: 'https://shop.myshopify.com/admin/orders/1234?token=abc' },
      }),
    ])
    expect(view.executor).toBe('playwright-mcp')
    expect(view.navigations).toBe(1)
    // **只给域名**：订单号与 token 一个字都没跟出来
    expect(view.current_host).toBe('shop.myshopify.com')
    expect(JSON.stringify(view)).not.toContain('1234')
    expect(JSON.stringify(view)).not.toContain('token')
  })

  it('BrowserSkill：六个 bsk_* 裸名工具，URL 在 `action` 那一支上', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', {
        call_id: 'c1',
        tool: 'bsk_page',
        input: { action: 'navigate', url: 'https://admin.shopify.com/store/x/themes' },
      }),
    ])
    expect(view.executor).toBe('browserskill')
    expect(view.current_host).toBe('admin.shopify.com')
    expect(view.last_navigation?.tool).toBe('bsk_page')
  })

  it('一个浏览器工具都没调过：`none`，而且别的工具的拒绝不进这个面板', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', { call_id: 'c1', tool: 'shopify_admin_read', input: {} }),
      ev('tool.result', { call_id: 'c1', status: 'blocked', reason: '越额度' }),
    ])
    expect(view.executor).toBe('none')
    expect(view.blocked).toBe(0)
    expect(view.last_blocked).toBeUndefined()
  })
})

describe('被拦下来的那一次', () => {
  it('按 call_id 认回是哪个工具，理由原样端出去', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', {
        call_id: 'c1',
        tool: 'bsk_page',
        input: { action: 'navigate', url: 'https://example.com/' },
      }),
      ev('tool.result', {
        call_id: 'c1',
        status: 'blocked',
        reason: 'browser_host_not_allowed: example.com 不在这个岗位开放的站里',
      }),
    ])
    expect(view.blocked).toBe(1)
    expect(view.last_blocked?.tool).toBe('bsk_page')
    expect(view.last_blocked?.reason).toContain('browser_host_not_allowed')
  })
})

describe('等人接管', () => {
  it('`progress{browser_handoff}` 之后就是"等你接管"', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', { call_id: 'c1', tool: 'bsk_assist', input: { action: 'request-help' } }),
      ev('progress', { step: 'browser_handoff', note: 'bsk_assist' }),
    ])
    expect(view.awaiting_handoff?.note).toBe('bsk_assist')
    expect(view.running).toBe(true)
  })

  it('人接完管、它又动手了：这个状态就该消失', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('progress', { step: 'browser_handoff', note: 'bsk_assist' }),
      ev('tool.call', {
        call_id: 'c2',
        tool: 'bsk_page',
        input: { action: 'navigate', url: 'https://admin.shopify.com/' },
      }),
    ])
    expect(view.awaiting_handoff).toBeUndefined()
  })

  it('跑完了就不再挂着"等你接管"（没人会来接一个已经结束的运行）', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('progress', { step: 'browser_handoff' }),
      ev('run.completed', { summary: '做完了' }),
    ])
    expect(view.running).toBe(false)
    expect(view.awaiting_handoff).toBeUndefined()
  })
})

describe('还在不在跑', () => {
  it('三条终止事件任意一条都算结束', () => {
    for (const type of ['run.completed', 'run.failed', 'run.cancelled']) {
      expect(summarizeRunBrowser('run_1', [ev(type, {})]).running).toBe(false)
    }
  })

  it('URL 解析不了就不给域名，但导航次数照数（它确实动过）', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', {
        call_id: 'c1',
        tool: 'mcp__playwright-mcp__browser_navigate',
        input: { url: '不是一个网址' },
      }),
    ])
    expect(view.navigations).toBe(1)
    expect(view.current_host).toBeUndefined()
  })
})

describe('WP463：ego', () => {
  it('执行器认 ego_* 三个工具；每段脚本的那一行（退出码 / 耗时 / 摘要）按顺序列出来', () => {
    const view = summarizeRunBrowser('run_1', [
      ev('tool.call', { call_id: 'c1', tool: 'ego_guide', input: {} }),
      ev('tool.call', {
        call_id: 'c2',
        tool: 'ego_run',
        input: {
          script: 'await (await taskSpace("t")).page("p1").goto("https://example.com/?token=abc")',
        },
      }),
      ev('progress', { step: 'ego_run', note: '退出码 0 · 1.2 秒 · Example Domain' }),
      ev('tool.call', { call_id: 'c3', tool: 'ego_run', input: { script: 'throw 1' } }),
      ev('progress', { step: 'ego_run', note: '退出码 1 · 0.3 秒 · Error: 1' }),
    ])
    expect(view.executor).toBe('ego')
    expect(view.ego_runs?.map((r) => r.note)).toEqual([
      '退出码 0 · 1.2 秒 · Example Domain',
      '退出码 1 · 0.3 秒 · Error: 1',
    ])
    // 脚本里的网址不往外端（它在 tool.call 里，面板只要摘要）
    expect(JSON.stringify(view)).not.toContain('token')
    expect(view.navigations).toBe(0)
  })

  it('最多留最近 20 段', () => {
    const events = []
    for (let i = 0; i < 25; i++)
      events.push(ev('progress', { step: 'ego_run', note: `第 ${i} 段` }))
    const view = summarizeRunBrowser('run_1', events)
    expect(view.ego_runs).toHaveLength(20)
    expect(view.ego_runs?.[0]?.note).toBe('第 5 段')
  })
})
