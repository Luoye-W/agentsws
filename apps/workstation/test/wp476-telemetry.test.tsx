/**
 * WP476（决策 1590）：工作台这一侧的匿名使用数据。**全程不联网**：fetch / XHR / sendBeacon 都换成只记不发的替身，
 * 每条用例最后都断言它们没被叫过（除了本机的 `/v1/settings/telemetry`）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 没配置 / 关了：SDK 那一块根本不加载，`track` 是空操作 | 没配 key 整套不发 |
 * | posthog-js 的每个自动采集开关都关着；录屏默认关、开了也遮住全部文字与输入 | 不靠 autocapture 抓文字 |
 * | 真 SDK 生成的事件过 `before_send` 之后只剩白名单；地址只剩路由模板；`$set_once` 整段丢 | 信件 / 客户名 / 输入框内容 / 地址里的业务参数出不了门 |
 * | 路由模板表与 `App.tsx` 一一对应；按钮对照表里的 testid 真在源码里 | 不漏、不过期 |
 * | 设置开关 / 第一次提示 | 用户知情、可关 |
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  TELEMETRY_BUTTONS,
  TELEMETRY_COMMON_PROPS,
  TELEMETRY_EVENTS,
  TELEMETRY_SDK_PROPS,
  type TelemetryView,
} from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetrySetting } from '@/components/settings/telemetry-setting'
import { TelemetryNotice } from '@/components/telemetry/telemetry-root'
import { BUTTON_TESTIDS, buttonIdOf } from '@/lib/telemetry/buttons'
import {
  _resetTelemetry,
  applyTelemetry,
  beforeSend,
  posthogConfig,
  stopTelemetry,
  track,
} from '@/lib/telemetry/client'
import { ROUTE_TEMPLATES, routeTemplate, UNKNOWN_ROUTE } from '@/lib/telemetry/routes'
import { renderWithProviders } from './helpers'

const SRC = join(__dirname, '../src')
const KEY = 'phc_testkey0123456789abcdef'
const CLIENT = { api_host: '/v1/telemetry', key: KEY, replay: false }
const ACTIVE: TelemetryView = {
  enabled: true,
  notice_seen: false,
  install_id: 'ins_0123456789abcdef0123456789abcdef',
  configured: true,
  active: true,
  client: CLIENT,
  account_id: 'org_3f9a0c1d2e',
}
/** 关着 / 没配置的那一份（没有 `client`）。 */
const OFF: TelemetryView = {
  enabled: false,
  notice_seen: false,
  install_id: ACTIVE.install_id,
  configured: true,
  active: false,
}
const SUPER = { shell: 'web' as const, lang: 'zh' as const, app_version: '0.2.1-beta.5' }

/** 业务内容样本：任何一条都不许出现在出门的事件里。 */
const SECRETS = [
  '您好 Anna，订单 #10023 的退款已处理',
  'Acme Trading',
  'anna@example.com',
  'NordVolt 65W 充电器',
  'draft=hello',
  'a_9f3x7',
]

const ALLOWED = new Set([
  ...Object.values(TELEMETRY_EVENTS).flatMap((p) => Object.keys(p)),
  ...Object.keys(TELEMETRY_COMMON_PROPS),
  ...Object.keys(TELEMETRY_SDK_PROPS),
])

// ── 网络替身：只记不发 ─────────────────────────────────
const net = { fetch: [] as string[], xhr: [] as string[], beacon: [] as string[] }
beforeEach(() => {
  net.fetch = []
  net.xhr = []
  net.beacon = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      net.fetch.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/v1/settings/telemetry')) {
        const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as object)
        return new Response(JSON.stringify({ data: { ...ACTIVE, ...body }, trace_id: 't' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    }),
  )
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(function (
    this: XMLHttpRequest,
    _m: string,
    url: string | URL,
  ) {
    net.xhr.push(String(url))
  })
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {})
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string) => {
      net.beacon.push(url)
      return true
    },
  })
  window.history.replaceState(null, '', '/positions/a_9f3x7/duties/dtc.support?draft=hello#x')
  _resetTelemetry()
})
afterEach(() => {
  stopTelemetry()
  _resetTelemetry()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  try {
    window.localStorage.clear()
  } catch {
    // 有的 jsdom / Node 组合没有可用的 localStorage
  }
})
const outbound = (): string[] =>
  [...net.fetch, ...net.xhr, ...net.beacon].filter((u) => !u.includes('/v1/settings/telemetry'))

// ── 路由模板 ───────────────────────────────────────────
describe('WP476 路由模板', () => {
  it('具体 id、查询串、#… 都换掉；设置归到 /settings/<节>；认不出的是 /other', () => {
    expect(
      routeTemplate({ pathname: '/positions/a_9f3x7/duties/dtc.support', search: '?draft=hello' }),
    ).toBe('/positions/:assignment/duties/:role_id')
    expect(routeTemplate({ pathname: '/matters/mat_123/' })).toBe('/matters/:id')
    expect(routeTemplate({ pathname: '/assistant/conv_77' })).toBe('/assistant/:id')
    expect(routeTemplate({ pathname: '/' })).toBe('/')
    expect(routeTemplate({ pathname: '/settings/privacy', hash: '#telemetry' })).toBe(
      '/settings/privacy',
    )
    expect(routeTemplate({ pathname: '/settings', search: '?tab=billing' })).toMatch(
      /^\/settings\/[a-z-]+$/,
    )
    expect(routeTemplate({ pathname: '/connections', search: '?service=gmail' })).toBe(
      '/settings/connections',
    )
    expect(routeTemplate({ pathname: '/anna@example.com/orders' })).toBe(UNKNOWN_ROUTE)
  })

  it('模板表与 App.tsx 的 <Route path> 一一对应', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
    const paths = [
      ...app.matchAll(/<Route\s+path=(?:"([^"]+)"|\{`\$\{ASSISTANT_PATH\}([^`]*)`\})/g),
    ]
      .map((m) => (m[1] !== undefined ? m[1] : `/assistant${m[2] ?? ''}`))
      .filter((p) => p !== '*')
      .flatMap((p) => (p.endsWith('?') ? [p.replace(/\/:[a-z_]+\?$/, ''), p.slice(0, -1)] : [p]))
    expect(paths.length).toBeGreaterThan(20)
    expect(new Set(paths)).toEqual(new Set(ROUTE_TEMPLATES))
  })
})

// ── 按钮编号 ───────────────────────────────────────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : []
  })
}

describe('WP476 关键按钮', () => {
  it('对照表里的编号都在清单里；每个 testid 真在源码里（整串、不带变量）', () => {
    const all = sourceFiles(SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const [testid, id] of Object.entries(BUTTON_TESTIDS)) {
      expect(TELEMETRY_BUTTONS).toContain(id)
      expect(all, testid).toContain(`data-testid="${testid}"`)
    }
    // 助理用岗位页那一个对话框（WP456-T8）：发送键靠 data-track 记成 assistant.send，不混进 matter.send
    expect(all).toContain('sendTrack="assistant.send"')
  })

  it('点在按钮里的图标上也认得；不在表里的按钮、按钮上的字一概不认', () => {
    document.body.innerHTML = `
      <button data-testid="matter-send" data-track="assistant.send"><span id="icon">发送给 Anna</span></button>
      <button data-testid="card-approve-apv_123">通过</button>
      <button data-track="nav.settings">设置</button>
      <button data-track="Acme Trading">x</button>
      <div data-testid="matter-send"><span id="not-button">x</span></div>`
    expect(buttonIdOf(document.getElementById('icon'))).toBe('assistant.send')
    expect(
      buttonIdOf(document.querySelector('[data-testid="card-approve-apv_123"]')),
    ).toBeUndefined()
    expect(buttonIdOf(document.querySelector('[data-track="nav.settings"]'))).toBe('nav.settings')
    expect(buttonIdOf(document.querySelector('[data-track="Acme Trading"]'))).toBeUndefined()
    expect(buttonIdOf(document.getElementById('not-button'))).toBeUndefined()
    document.body.innerHTML = ''
  })
})

// ── SDK 配置与出门那一关 ──────────────────────────────
describe('WP476 posthog-js 的开关', () => {
  it('自动采集全关、不拉外部脚本、不要远程配置、录屏默认关；开了也遮住全部文字与输入', () => {
    const cfg = posthogConfig(CLIENT, { ...SUPER, install_id: ACTIVE.install_id })
    expect(cfg).toMatchObject({
      // 同源的本机转发；浏览器里什么都不存，匿名号 = 这台机器的匿名设备号
      api_host: '/v1/telemetry',
      persistence: 'memory',
      disable_persistence: true,
      bootstrap: { distinctID: ACTIVE.install_id, isIdentifiedID: false },
      disable_compression: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      rageclick: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      save_referrer: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      disable_session_recording: true,
      enable_recording_console_log: false,
    })
    const withReplay = posthogConfig(
      { ...CLIENT, replay: true },
      { ...SUPER, install_id: 'ins_x1234567' },
    )
    expect(withReplay.disable_session_recording).toBe(false)
    expect(withReplay.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
      maskAllElementAttributes: true,
      recordHeaders: false,
      recordBody: false,
    })
  })

  it('before_send：清单外的事件丢；地址换成模板；业务属性、$set_once 整段丢', () => {
    const base = { uuid: 'u1', timestamp: new Date(0) }
    expect(
      beforeSend(
        { ...base, event: '$autocapture', properties: { $el_text: SECRETS[0] } } as never,
        { replay: false },
      ),
    ).toBeNull()
    expect(
      beforeSend({ ...base, event: '$snapshot', properties: {} } as never, { replay: false }),
    ).toBeNull()
    const out = beforeSend(
      {
        ...base,
        event: 'ui_click',
        properties: {
          button_id: 'assistant.send',
          $current_url: 'http://127.0.0.1:4317/positions/a_9f3x7/duties/dtc.support?draft=hello',
          $pathname: '/positions/a_9f3x7/duties/dtc.support',
          $referrer: 'https://mail.example.com/?to=anna@example.com',
          $host: '127.0.0.1:4317',
          text: SECRETS[0],
          $os: 'Mac OS X',
        },
        $set_once: { $initial_current_url: 'http://127.0.0.1:4317/?draft=hello' },
      } as never,
      { replay: false },
    )
    expect(out).toEqual({
      ...base,
      event: 'ui_click',
      properties: {
        button_id: 'assistant.send',
        $current_url: '/positions/:assignment/duties/:role_id',
        $pathname: '/positions/:assignment/duties/:role_id',
        $os: 'Mac OS X',
      },
    })
  })
})

describe('WP476 没配置就不加载', () => {
  it('不 active（没配置 / 关了 / 云上没给 key / 老服务进程）：SDK 不加载，攒的扔掉，之后不攒', async () => {
    for (const view of [undefined, { ...OFF, enabled: true }, OFF]) {
      _resetTelemetry()
      const load = vi.fn()
      track('app_opened')
      await applyTelemetry(view as TelemetryView | undefined, SUPER, load)
      track('$pageview', { route: '/' })
      expect(load).not.toHaveBeenCalled()
    }
    expect(outbound()).toEqual([])
  })

  it('active：初始化一次、攒的补发；关掉就停', async () => {
    const captured: [string, Record<string, unknown>][] = []
    const fake = {
      init: vi.fn(),
      register: vi.fn(),
      capture: vi.fn((e: string, p: Record<string, unknown>) => {
        captured.push([e, p])
      }),
    }
    const load = vi.fn(async () => ({ posthog: fake }) as never)
    track('app_opened')
    track('$pageview', { route: '/' })
    await applyTelemetry(ACTIVE, SUPER, load)
    await applyTelemetry(ACTIVE, SUPER, load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(fake.init).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ api_host: CLIENT.api_host }),
    )
    expect(captured.map(([e]) => e)).toEqual(['app_opened', '$pageview'])
    track('ui_click', { button_id: 'nav.settings' })
    expect(captured.at(-1)).toEqual([
      'ui_click',
      { route: '/positions/:assignment/duties/:role_id', button_id: 'nav.settings' },
    ])
    await applyTelemetry(OFF, SUPER, load)
    track('ui_click', { button_id: 'nav.settings' })
    expect(captured).toHaveLength(3)
    // 关掉之后 SDK 手上还有的，`before_send` 一条都不放
    expect(
      beforeSend({ uuid: 'u', event: 'app_opened', properties: {} } as never, { replay: false }),
    ).toBeNull()
    // 再打开：不重复加载，接着发
    await applyTelemetry(ACTIVE, SUPER, load)
    track('ui_click', { button_id: 'nav.settings' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(4)
  })
})

describe('WP476 真 SDK：出门的只剩白名单（拦在 before_send 之后，一个请求都不发）', () => {
  it('posthog-js 自己加的属性、业务文字、地址里的参数都出不了门', async () => {
    const storeWrites: string[] = []
    const storeRemoves: string[] = []
    const fakeStore = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: (k: string) => {
        storeWrites.push(k)
      },
      removeItem: (k: string) => {
        storeRemoves.push(k)
      },
      clear: () => {},
    }
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, name, { configurable: true, value: fakeStore })
    const mod = await import('posthog-js/dist/module.no-external')
    const finals: { event: string; properties: Record<string, unknown>; [k: string]: unknown }[] =
      []
    const cfg = posthogConfig(CLIENT, {
      ...SUPER,
      install_id: ACTIVE.install_id,
      account_id: 'org_3f9a0c1d2e',
    })
    const ours = cfg.before_send as unknown as (cr: unknown) => unknown
    const instance = mod.posthog.init(
      KEY,
      {
        ...cfg,
        // 我们那一关之后再接一道：记下最终形态、然后丢掉（一条都不进发送队列）
        before_send: [
          ours,
          (cr: unknown) => {
            if (cr !== null) finals.push(cr as never)
            return null
          },
        ],
      } as never,
      'wp476test',
    )
    expect(instance).toBeDefined()
    const ph = instance as NonNullable<typeof instance>
    ph.capture('$pageview', { route: '/positions/:assignment/duties/:role_id' })
    ph.capture('ui_click', { button_id: 'assistant.send', note: SECRETS[0], customer: SECRETS[1] })
    ph.capture('client_error', {
      error_kind: 'error',
      error_name: 'TypeError',
      message: SECRETS[2],
    })
    ph.capture('$autocapture', { $el_text: SECRETS[3] })
    ph.capture('draft_saved', { body: SECRETS[0] })
    ph.identify('anna@example.com', { email: 'anna@example.com' })
    expect(finals.map((f) => f.event)).toEqual(['$pageview', 'ui_click', 'client_error'])
    for (const f of finals) {
      const text = JSON.stringify(f)
      for (const s of SECRETS) expect(text, s).not.toContain(s)
      for (const key of Object.keys(f.properties)) expect(ALLOWED, key).toContain(key)
      expect(f.properties.$current_url).toBe('/positions/:assignment/duties/:role_id')
      expect(f.properties.distinct_id).toBe(ACTIVE.install_id)
      expect(f).not.toHaveProperty('$set')
      expect(f).not.toHaveProperty('$set_once')
      // 公共属性是 super property：匿名设备号、账号 id（不是邮箱）
      expect(f.properties).toMatchObject({
        install_id: ACTIVE.install_id,
        account_id: 'org_3f9a0c1d2e',
        shell: 'web',
        lang: 'zh',
      })
    }
    stopTelemetry()
    await new Promise((r) => setTimeout(r, 50))
    expect(outbound()).toEqual([])
    // 浏览器存储里一样都没写（只许「能不能用」的探测：写进去马上删掉）
    expect(storeWrites.filter((k) => !storeRemoves.includes(k))).toEqual([])
  })
})

// ── 设置与第一次提示 ─────────────────────────────────
describe('WP476 用户知情', () => {
  it('设置里的开关：关掉 = 同时记下提示看过了', async () => {
    renderWithProviders(<TelemetrySetting />)
    const sw = await screen.findByTestId('settings-telemetry-switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => {
      expect(net.fetch).toContain('PUT /v1/settings/telemetry')
    })
    const put = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    )
    expect(JSON.parse(String(put?.[1].body))).toEqual({ enabled: false, notice_seen: true })
    expect(outbound()).toEqual([])
  })

  it('第一次提示：真会发、没看过才出；「不发送」= 关掉', async () => {
    const { unmount } = renderWithProviders(<TelemetryNotice view={{ ...ACTIVE, active: false }} />)
    expect(screen.queryByTestId('telemetry-notice')).toBeNull()
    unmount()
    renderWithProviders(<TelemetryNotice view={{ ...ACTIVE, notice_seen: true }} />)
    expect(screen.queryByTestId('telemetry-notice')).toBeNull()
    renderWithProviders(<TelemetryNotice view={ACTIVE} />)
    expect(screen.getByTestId('telemetry-notice').textContent).toContain('匿名使用数据')
    fireEvent.click(screen.getByTestId('telemetry-notice-off'))
    await waitFor(() => {
      expect(net.fetch).toContain('PUT /v1/settings/telemetry')
    })
    const put = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    )
    expect(JSON.parse(String(put?.[1].body))).toEqual({ enabled: false, notice_seen: true })
  })
})
