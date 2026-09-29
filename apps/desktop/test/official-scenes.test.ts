/**
 * WP184（docs/79 §3.1 / §9）：托盘这一侧——官方场景默认在我们自己的窗口里打开（能切回浏览器），
 * 用户自己装的官方桌面端多一行；api-client 的三条新接口。
 */
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api-client.js'
import type { HealthSnapshot } from '../src/health.js'
import { strings } from '../src/i18n.js'
import { sceneSubmenu, type TrayModelInput } from '../src/menu.js'
import type { ApiFetchLike, ApiResponseLike } from '../src/ports.js'

const healthy: HealthSnapshot = {
  ok: true,
  status: 'ok',
  version: '0.1.0',
  halted: false,
  at: undefined,
  error: undefined,
}

const input = (patch: Partial<TrayModelInput> = {}): TrayModelInput => ({
  language: 'zh-CN',
  serverUrl: 'http://127.0.0.1:4317',
  version: '0.1.0',
  server: {
    name: 'server',
    state: 'running',
    pid: 1,
    attempts: 0,
    startedAt: undefined,
    lastExit: undefined,
    retryInMs: undefined,
  },
  health: healthy,
  paused: false,
  connect: undefined,
  launchAtLogin: false,
  scenes: [
    { name: 'agentsws', origin: 'agentsws', state: 'running' },
    { name: 'web', origin: 'official', state: 'stopped' },
  ],
  ...patch,
})

describe('托盘：官方桌面端那一行与「在浏览器里打开场景」', () => {
  it('装了官方桌面端：场景后面多一行；没装不出', () => {
    const t = strings('zh-CN')
    const items = sceneSubmenu(input({ officialDesktop: true }))?.submenu ?? []
    expect(items.map((i) => i.id)).toEqual([
      'switch-scene',
      'switch-scene',
      'launch-official-desktop',
      'separator',
      'toggle-scene-in-browser',
      'manage-scenes',
    ])
    expect(items[2]?.label).toBe(t.officialDesktop)
    const none = sceneSubmenu(input())?.submenu ?? []
    expect(none.some((i) => i.id === 'launch-official-desktop')).toBe(false)
  })

  it('「在浏览器里打开场景」是个勾选项，跟着配置走（默认不勾 = 我们自己的窗口）', () => {
    const off = (sceneSubmenu(input())?.submenu ?? []).find(
      (i) => i.id === 'toggle-scene-in-browser',
    )
    expect(off).toMatchObject({ type: 'checkbox', checked: false })
    const on = (sceneSubmenu(input({ sceneInBrowser: true }))?.submenu ?? []).find(
      (i) => i.id === 'toggle-scene-in-browser',
    )
    expect(on?.checked).toBe(true)
    expect(strings('en-US').officialDesktop).toBe('Official desktop app (installed by you)')
  })
})

describe('api-client：场景菜单、重启、启动官方桌面端', () => {
  const session = { cookie: 'c=1', name: 'c', value: '1', person: { id: 'p', email: 'e' } }
  const res = (status: number, body: unknown): ApiResponseLike => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  })
  const clientOf = (routes: Record<string, ApiResponseLike>) => {
    const calls: { url: string; method?: string | undefined }[] = []
    const fetchImpl: ApiFetchLike = async (url, init) => {
      calls.push({ url, method: init?.method })
      return routes[url.replace('http://127.0.0.1:4317', '')] ?? res(404, {})
    }
    return {
      calls,
      api: createApiClient({ baseUrl: 'http://127.0.0.1:4317', sessionKey: 'k', fetchImpl }),
    }
  }

  it('sceneMenu：带上官方桌面端装没装', async () => {
    const { api } = clientOf({
      '/v1/dsh-scenes': res(200, {
        data: {
          available: true,
          scenes: [{ name: 'web', origin: 'official', state: 'running', launchable: true }],
          official_desktop: { name: 'DeepSeek Harness', app_path: '/Applications/x.app' },
        },
      }),
    })
    expect(await api.sceneMenu(session, 'a')).toEqual({
      ok: true,
      value: {
        scenes: [{ name: 'web', origin: 'official', state: 'running' }],
        officialDesktop: true,
      },
    })
    const none = clientOf({ '/v1/dsh-scenes': res(200, { data: { available: true, scenes: [] } }) })
    expect(await none.api.sceneMenu(session, 'a')).toEqual({
      ok: true,
      value: { scenes: [], officialDesktop: false },
    })
  })

  it('restartScene 回网址；launchOfficialDesktop 回 true，没装回那句人话', async () => {
    const { api, calls } = clientOf({
      '/v1/dsh-scenes/web/restart': res(200, { data: { url: 'http://127.0.0.1:6000/?token=t' } }),
      '/v1/dsh-scenes/official-desktop/launch': res(200, { data: { launched: true } }),
    })
    expect(await api.restartScene(session, 'a', 'web')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:6000/?token=t',
    })
    expect(await api.launchOfficialDesktop(session, 'a')).toEqual({ ok: true, value: true })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST'])
    const missing = clientOf({
      '/v1/dsh-scenes/official-desktop/launch': res(404, {
        error: { code: 'not_found', message: '这台电脑上没有装' },
      }),
    })
    expect(await missing.api.launchOfficialDesktop(session, 'a')).toEqual({
      ok: false,
      reason: '这台电脑上没有装',
    })
  })
})
