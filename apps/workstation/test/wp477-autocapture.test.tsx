/**
 * WP477（决策 1617 / 1618）：autocapture 开着，但全遮。**全程不联网**：fetch / XHR / sendBeacon 都是只记不发的替身。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 真 SDK 点收件箱一行（上面有客户名、主题）：出门只剩 click / `inbox-row` / 标签 / 路由模板，一个字都不带 | 业务内容出不了门 |
 * | 带变量的 testid 只发模板（`rail-office-sheet-tab-:x`）；不在表里的 testid、没有 testid 的整条不发 | 变量里可能是工作表名、邮箱名 |
 * | 热力图 / 死点击 / 连点 / 性能 / 录屏照旧关 | 只开这一样 |
 * | 工作台把界面语言告诉本机服务（PUT `{ lang }`），一种语言只说一次 | GA4 的 `market_region`（决策 1600 / 1609） |
 */
import type { TelemetryView } from '@agentsws/contracts'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryRoot } from '@/components/telemetry/telemetry-root'
import {
  _resetTelemetry,
  applyTelemetry,
  autocaptureTarget,
  beforeSend,
  cardRoleOf,
  listenForTargets,
  posthogConfig,
  setTelemetryContext,
  stopTelemetry,
  telemetryContextFor,
  track,
} from '@/lib/telemetry/client'
import { renderWithProviders } from './helpers'

const KEY = 'phc_testkey0123456789abcdef'
const CLIENT = { api_host: '/v1/telemetry', key: KEY, replay: false }
const VIEW: TelemetryView = {
  enabled: true,
  notice_seen: true,
  install_id: 'ins_0123456789abcdef0123456789abcdef',
  configured: true,
  active: false,
}
const CUSTOMER = 'Anna Schmidt'
const SUBJECT = 'Re: Wholesale inquiry from Acme Trading'
const SECRETS = [
  CUSTOMER,
  'Anna',
  'Schmidt',
  SUBJECT,
  'Wholesale',
  'Acme',
  'anna@example.com',
  '10023',
]

const net = { fetch: [] as string[], xhr: [] as string[], beacon: [] as string[] }
let served: TelemetryView = VIEW
beforeEach(() => {
  net.fetch = []
  net.xhr = []
  net.beacon = []
  served = VIEW
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      net.fetch.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/v1/settings/telemetry')) {
        const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as object)
        served = { ...served, ...body }
        return new Response(JSON.stringify({ data: served, trace_id: 't' }), {
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
  window.history.replaceState(null, '', '/inbox?thread=thr_9f3x7&q=Anna#x')
  _resetTelemetry()
})
afterEach(() => {
  stopTelemetry()
  _resetTelemetry()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
/** 往外网的（本机同源的 `/v1/...` 不算）。 */
const outbound = (): string[] =>
  [...net.fetch, ...net.xhr, ...net.beacon].filter((u) => !/^(?:[A-Z]+ )?\/(?!\/)/.test(u))

/**
 * 一行收件箱（照 `inbox-row.tsx`：整行是 `div role="button"`、手形光标）：外层带 testid，
 * 里面是客户名、主题、一个链接，属性上也塞了业务内容。
 */
function inboxRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.style.cursor = 'pointer'
  row.setAttribute('data-testid', 'inbox-row')
  row.setAttribute('data-id', 'thr_9f3x7')
  row.setAttribute('title', SUBJECT)
  row.setAttribute('aria-label', `${CUSTOMER} ${SUBJECT}`)
  row.className = 'row customer-anna'
  row.innerHTML = `<span class="who">${CUSTOMER}</span><p data-testid="inbox-row-line">${SUBJECT}</p><a href="https://shop.example.com/orders/10023?customer=anna@example.com">#10023</a>`
  // jsdom 不会真跳转（跳了只报一句 not implemented）
  row.querySelector('a')?.addEventListener('click', (e) => e.preventDefault())
  document.body.append(row)
  return row
}

describe('WP477 autocapture：认元素只靠源码里写死的 testid', () => {
  it('最近的 testid：写死的原样；带变量的只给模板；不在表里 / 没有 → 不认', () => {
    const row = inboxRow()
    expect(autocaptureTarget(row.querySelector('span') as Element)).toEqual({
      testid: 'inbox-row',
      tag: 'div',
    })
    expect(autocaptureTarget(row.querySelector('a') as Element)).toEqual({
      testid: 'inbox-row',
      tag: 'a',
    })
    const tab = document.createElement('button')
    tab.setAttribute('data-testid', `rail-office-sheet-tab-${CUSTOMER}`)
    tab.textContent = CUSTOMER
    document.body.append(tab)
    expect(autocaptureTarget(tab)).toEqual({ testid: 'rail-office-sheet-tab-:x', tag: 'button' })
    const odd = document.createElement('button')
    odd.setAttribute('data-testid', 'acme-trading-row')
    document.body.append(odd)
    expect(autocaptureTarget(odd)).toBeUndefined()
    const bare = document.createElement('button')
    document.body.append(bare)
    expect(autocaptureTarget(bare)).toBeUndefined()
    expect(autocaptureTarget(undefined)).toBeUndefined()
  })

  it('真 SDK：点收件箱一行，出门只剩 click / inbox-row / 标签 / 路由模板；不在表里的元素整条不发', async () => {
    const mod = await import('posthog-js/dist/module.no-external')
    const finals: { event: string; properties: Record<string, unknown> }[] = []
    const cfg = posthogConfig(CLIENT, { shell: 'web', lang: 'zh', install_id: VIEW.install_id })
    // 热力图 / 死点击 / 连点 / 性能 / 录屏照旧关；字与属性全遮
    expect(cfg).toMatchObject({
      mask_all_text: true,
      mask_all_element_attributes: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      capture_performance: false,
      disable_session_recording: true,
      autocapture: {
        dom_event_allowlist: ['click', 'change', 'submit'],
        capture_copied_text: false,
      },
    })
    listenForTargets()
    const ours = cfg.before_send as unknown as (cr: unknown) => unknown
    const instance = mod.posthog.init(
      KEY,
      {
        ...cfg,
        before_send: [
          ours,
          (cr: unknown) => {
            if (cr !== null) finals.push(cr as never)
            return null
          },
        ],
      } as never,
      'wp477test',
    )
    expect(instance).toBeDefined()

    const row = inboxRow()
    fireEvent.click(row.querySelector('span') as Element)
    fireEvent.click(row.querySelector('a') as Element)
    // 不在表里的 testid、没有 testid 的元素：整条不发
    const odd = document.createElement('button')
    odd.setAttribute('data-testid', 'acme-trading-row')
    odd.textContent = CUSTOMER
    document.body.append(odd)
    fireEvent.click(odd)
    const bare = document.createElement('button')
    bare.textContent = SUBJECT
    document.body.append(bare)
    fireEvent.click(bare)

    await waitFor(() => {
      expect(finals.filter((f) => f.event === '$autocapture').length).toBeGreaterThanOrEqual(1)
    })
    const auto = finals.filter((f) => f.event === '$autocapture')
    expect(auto.length).toBe(2)
    for (const f of auto) {
      expect(f.properties.testid).toBe('inbox-row')
      expect(f.properties.$event_type).toBe('click')
      expect(f.properties.route).toBe('/inbox')
      expect(f.properties.$current_url).toBe('/inbox')
      for (const gone of [
        '$el_text',
        '$elements',
        '$elements_chain',
        '$external_click_url',
        '$element_selectors',
      ])
        expect(f.properties, gone).not.toHaveProperty(gone)
      for (const key of Object.keys(f.properties)) expect(key.startsWith('attr__'), key).toBe(false)
      const text = JSON.stringify(f)
      for (const s of SECRETS) expect(text, s).not.toContain(s)
      expect(text).not.toContain('thr_9f3x7')
    }
    expect(auto.map((f) => f.properties.tag).sort()).toEqual(['a', 'div'])
    stopTelemetry()
    await new Promise((r) => setTimeout(r, 50))
    expect(outbound()).toEqual([])
  })
})

describe('WP477 工作台把界面语言告诉本机服务', () => {
  it('本机服务记的和当前不一样就 PUT { lang } 一次；一样就不再说', async () => {
    renderWithProviders(<TelemetryRoot />, '/inbox')
    await waitFor(() => {
      expect(net.fetch).toContain('PUT /v1/settings/telemetry')
    })
    const puts = () =>
      (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.filter(
        ([u, init]) => init?.method === 'PUT' && String(u).includes('/v1/settings/telemetry'),
      )
    expect(puts().map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ lang: 'zh' }])
    await new Promise((r) => setTimeout(r, 50))
    expect(puts()).toHaveLength(1)
    expect(outbound()).toEqual([])
  })
})

describe('WP477 按岗位 / 职责看体验（Luoye 10-23）', () => {
  it('岗位起了客户品牌的名字：只带 id；不像编号的（岗位名、中文）换成 custom；地址对得上才带', () => {
    setTelemetryContext('/positions/customer-care', {
      position_template: 'customer-care',
      role_id: 'dtc.support',
    })
    expect(telemetryContextFor('/positions/customer-care')).toEqual({
      position_template: 'customer-care',
      role_id: 'dtc.support',
    })
    // 换了一个岗位（同一个路由模板）：上一页的不串过来
    expect(telemetryContextFor('/positions/pos-1a2b3c4d')).toEqual({})
    setTelemetryContext('/positions/pos-1a2b3c4d', {
      position_template: 'Acme 旗舰店客服',
      role_id: '我的职责',
    })
    expect(telemetryContextFor('/positions/pos-1a2b3c4d')).toEqual({
      position_template: 'custom',
      role_id: 'custom',
    })
    setTelemetryContext('/positions/pos-1a2b3c4d', undefined)
    expect(telemetryContextFor('/positions/pos-1a2b3c4d')).toEqual({})
  })

  it('页面访问 / 按钮 / autocapture 都带上这一页的岗位与职责；点在卡上带卡的职责；出门只剩 id', async () => {
    window.history.replaceState(null, '', '/positions/a_9f3x7/duties/dtc.support')
    const captured: [string, Record<string, unknown>][] = []
    const fake = {
      posthog: {
        init: () => undefined,
        register: () => undefined,
        unregister: () => undefined,
        capture: (event: string, props: Record<string, unknown>) => {
          captured.push([event, props])
        },
      },
    }
    await applyTelemetry(
      { ...VIEW, active: true, client: CLIENT },
      { shell: 'web', lang: 'zh' },
      async () => fake as never,
    )
    setTelemetryContext('/positions/a_9f3x7/duties/dtc.support', {
      position_template: 'customer-care',
      role_id: 'dtc.support',
    })
    track('$pageview', { route: '/positions/:assignment/duties/:role_id' })
    track('ui_click', { button_id: 'card.approve', role_id: 'kol.youtube' })
    expect(captured).toEqual([
      [
        '$pageview',
        {
          route: '/positions/:assignment/duties/:role_id',
          position_template: 'customer-care',
          role_id: 'dtc.support',
        },
      ],
      [
        'ui_click',
        {
          route: '/positions/:assignment/duties/:role_id',
          position_template: 'customer-care',
          // 点在一张卡上：带那张卡的职责
          role_id: 'kol.youtube',
          button_id: 'card.approve',
        },
      ],
    ])

    // autocapture：点在一张卡（卡挂 kol.youtube）里的按钮
    const card = document.createElement('div')
    card.setAttribute('data-testid', 'deck-card')
    card.setAttribute('data-track-role', 'kol.youtube')
    card.innerHTML = `<button data-testid="inbox-draft-approve">${CUSTOMER}</button>`
    document.body.append(card)
    const button = card.querySelector('button') as Element
    expect(cardRoleOf(button)).toEqual({ role_id: 'kol.youtube' })
    listenForTargets()
    fireEvent.click(button)
    const out = beforeSend(
      {
        uuid: 'u1',
        event: '$autocapture',
        properties: { $event_type: 'click', $el_text: CUSTOMER, token: KEY },
      } as never,
      { replay: false },
    )
    expect(out?.properties).toEqual({
      $event_type: 'click',
      testid: 'inbox-draft-approve',
      tag: 'button',
      route: '/positions/:assignment/duties/:role_id',
      position_template: 'customer-care',
      role_id: 'kol.youtube',
      token: KEY,
      $current_url: '/positions/:assignment/duties/:role_id',
      $pathname: '/positions/:assignment/duties/:role_id',
    })
    // 自建职责的卡：工作台这一关只认编号样子；名字样的换成 custom（本机服务再按内置目录核）
    card.setAttribute('data-track-role', 'Acme 旗舰店')
    expect(cardRoleOf(button)).toEqual({ role_id: 'custom' })
    expect(outbound()).toEqual([])
  })
})
