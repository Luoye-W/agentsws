/**
 * WP144（docs/80）：`/v1/settings/computer-use*` 与 `/v1/computer-use/*` 在**网关这一层**的形状。
 *
 * 业务都在服务进程（`apps/server/src/computer-use.ts`，那边有自己的测试）；这里只钉三件事：
 * 没装配就是 501、入参校验（分钟数 1–60）、七条路由都转给端口。
 */
import type { ComputerUseSettingsView } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ComputerUsePort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

const VIEW: ComputerUseSettingsView = {
  enabled: false,
  roles: [],
  minutes: 10,
  allowed: true,
  platform: 'darwin',
  driver: { installed: false, pinned_version: '0.28.0' },
}

async function wired(withPort = true) {
  const h = await harness()
  const calls: string[] = []
  const port: ComputerUsePort = {
    settings: () => (calls.push('settings'), VIEW),
    setSettings: (_a, input) => (calls.push(`set:${JSON.stringify(input)}`), { ...VIEW, ...input }),
    install: () => (calls.push('install'), { ...VIEW, driver: { installed: true } }),
    check: () => (calls.push('check'), { ran: true, ok: true, checks: [] }),
    openSettings: (_a, pane) => (calls.push(`open:${pane}`), { opened: true, url: 'x' }),
    active: () => (calls.push('active'), {}),
    stop: () => (calls.push('stop'), { stopped: 0 }),
  }
  const gateway = createGateway(withPort ? { ...h.deps, computerUse: port } : h.deps)
  const call = (method: string, path: string, body?: unknown) => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  return { call, calls }
}

describe('WP144 电脑操控路由', () => {
  it('没装配 → 501（不装电脑操控照常能用）', async () => {
    const { call } = await wired(false)
    expect((await call('GET', '/v1/settings/computer-use')).status).toBe(501)
    expect((await call('GET', '/v1/computer-use/active')).status).toBe(501)
  })

  it('七条路由都转给端口', async () => {
    const { call, calls } = await wired()
    expect((await call('GET', '/v1/settings/computer-use')).status).toBe(200)
    expect(
      (await call('PUT', '/v1/settings/computer-use', { enabled: true, roles: ['site.builder'] }))
        .status,
    ).toBe(200)
    expect((await call('POST', '/v1/settings/computer-use/install')).status).toBe(200)
    expect((await call('POST', '/v1/settings/computer-use/check')).status).toBe(200)
    expect(
      (await call('POST', '/v1/settings/computer-use/open-settings', { pane: 'accessibility' }))
        .status,
    ).toBe(200)
    expect((await call('GET', '/v1/computer-use/active')).status).toBe(200)
    expect((await call('POST', '/v1/computer-use/stop')).status).toBe(200)
    expect(calls).toEqual([
      'settings',
      'set:{"enabled":true,"roles":["site.builder"]}',
      'install',
      'check',
      'open:accessibility',
      'active',
      'stop',
    ])
  })

  it('入参校验：分钟数只许 1–60，系统设置只有两页', async () => {
    const { call, calls } = await wired()
    expect((await call('PUT', '/v1/settings/computer-use', { minutes: 99 })).status).toBe(400)
    expect(
      (await call('POST', '/v1/settings/computer-use/open-settings', { pane: 'firewall' })).status,
    ).toBe(400)
    expect(calls).toEqual([])
  })
})
