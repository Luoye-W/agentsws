/**
 * WP144（docs/80 §5）：桌面壳这一侧的「看得见、停得住」。
 *
 * - AI 正在操作这台电脑时，托盘菜单**最上面**一行说明 + 一行「停止」，悬停提示也说；
 *   没在操作、连公司服务器那一档都不出；
 * - 红色图标**不是** template（template 会被系统反色成黑白，就看不出变色了）；
 * - api-client：`active` 服务没装配（501）当"没有"；`stop` 走 POST。
 */
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api-client.js'
import type { HealthSnapshot } from '../src/health.js'
import { strings } from '../src/i18n.js'
import { buildTrayMenu, computerUseItems, type TrayModelInput, trayTooltip } from '../src/menu.js'
import type { ApiFetchLike, ApiResponseLike } from '../src/ports.js'
import {
  TRAY_ICON_ACTIVE_2X_PNG_BASE64,
  TRAY_ICON_ACTIVE_PNG_BASE64,
  TRAY_ICON_PNG_BASE64,
} from '../src/tray-icon.js'

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
  ...patch,
})

const until = new Date(2026, 8, 24, 10, 30).toISOString()

describe('托盘：AI 正在操作电脑', () => {
  it('在操作 → 菜单最上面一行说明（灰的）+「停止」，悬停提示也说', () => {
    const menu = buildTrayMenu(input({ computerUse: { until } }))
    expect(menu[0]).toMatchObject({
      id: 'status',
      label: 'AI 正在操作电脑（到 10:30）',
      enabled: false,
    })
    expect(menu[1]).toMatchObject({ id: 'stop-computer-use', label: '停止', enabled: true })
    expect(menu[2]?.type).toBe('separator')
    expect(trayTooltip(input({ computerUse: { until } }))).toContain('AI 正在操作电脑（到 10:30）')
  })

  it('没在操作 / 连公司服务器那一档 → 一行都不出', () => {
    expect(computerUseItems(input())).toEqual([])
    expect(computerUseItems(input({ computerUse: { until }, mode: 'remote' }))).toEqual([])
    expect(buildTrayMenu(input()).some((i) => i.id === 'stop-computer-use')).toBe(false)
  })

  it('英文也有', () => {
    const t = strings('en-US')
    const menu = buildTrayMenu(input({ language: 'en-US', computerUse: { until } }))
    expect(menu[0]?.label).toBe(t.computerUseActive.replace('{until}', '10:30'))
    expect(menu[1]?.label).toBe('Stop')
  })

  it('红色图标与平时那张不是同一张，两种分辨率都有', () => {
    expect(TRAY_ICON_ACTIVE_PNG_BASE64).not.toBe(TRAY_ICON_PNG_BASE64)
    for (const b64 of [TRAY_ICON_ACTIVE_PNG_BASE64, TRAY_ICON_ACTIVE_2X_PNG_BASE64]) {
      expect(Buffer.from(b64, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG')
    }
  })
})

describe('api-client：active / stop', () => {
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
      return routes[url.replace('http://127.0.0.1:4317', '')] ?? res(501, {})
    }
    return {
      calls,
      api: createApiClient({ baseUrl: 'http://127.0.0.1:4317', sessionKey: 'k', fetchImpl }),
    }
  }

  it('在操作 → 回授权到几点；没装配（501）当没有', async () => {
    const on = clientOf({ '/v1/computer-use/active': res(200, { data: { active: { until } } }) })
    expect(await on.api.computerUseActive(session, 'asg')).toEqual({ ok: true, value: { until } })
    const off = clientOf({})
    expect(await off.api.computerUseActive(session, 'asg')).toEqual({ ok: true, value: undefined })
  })

  it('停止走 POST /v1/computer-use/stop', async () => {
    const c = clientOf({ '/v1/computer-use/stop': res(200, { data: { stopped: 1 } }) })
    expect(await c.api.stopComputerUse(session, 'asg')).toEqual({ ok: true, value: 1 })
    expect(c.calls).toEqual([{ url: 'http://127.0.0.1:4317/v1/computer-use/stop', method: 'POST' }])
  })
})
