/**
 * WP476：事件清单与属性白名单钉在这里——改了清单，这份快照就红，提醒同时改 `docs/telemetry-events.md`。
 * 还钉住：信件、草稿、客户名、商品名、输入框内容、网址里的业务参数，从结构上就出不了门。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectTestids, render } from '../../../scripts/gen-telemetry-testids.mjs'
import {
  DEFAULT_TELEMETRY_HOST,
  GA4_APP_EVENTS,
  GA4_APP_PARAMS,
  GA4_MEASUREMENT_ID,
  GA4_RELAY_PATH,
  passesRule,
  sanitizeGa4Event,
  sanitizeTelemetryProps,
  TELEMETRY_BUTTONS,
  TELEMETRY_COMMON_PROPS,
  TELEMETRY_EVENTS,
  TELEMETRY_HOST_ENV,
  TELEMETRY_SDK_PROPS,
  TELEMETRY_TESTID_TEMPLATES,
  TELEMETRY_TESTIDS,
  telemetryCacheTier,
  telemetryCostTier,
  telemetryMarketRegion,
  telemetrySafeId,
  telemetryTestidOf,
} from '../src/index.js'

/** 业务内容样本：任何一条都不许以任何属性值的身份出门。 */
const BUSINESS = [
  '您好 Anna，关于订单 #10023 的退款我们已经处理',
  'Re: Wholesale inquiry from Acme Trading',
  'anna@example.com',
  '13800138000',
  'NordVolt 65W GaN 充电器',
  'https://shop.example.com/products/x?utm_source=mail&customer=anna',
  '/positions/a_123/duties/seo.weekly?draft=hello%20world',
  'Hello world',
  'Acme Trading Co.',
]

describe('WP476 事件清单（快照）', () => {
  it('事件名与各自的属性一张表钉死', () => {
    const shape = Object.fromEntries(
      Object.entries(TELEMETRY_EVENTS).map(([name, props]) => [name, Object.keys(props).sort()]),
    )
    expect(shape).toEqual({
      $pageview: ['position_template', 'role_id', 'route'],
      app_opened: [],
      page_left: ['position_template', 'role_id', 'route', 'seconds'],
      ui_click: ['button_id', 'position_template', 'role_id', 'route'],
      client_error: ['error_kind', 'error_name', 'route', 'scope'],
      task_finished: [
        'cache_tier',
        'cost_tier',
        'error_code',
        'outcome',
        'position_id',
        'role_id',
        'runtime',
      ],
      card_decided: ['card_kind', 'decision', 'role_id'],
      $autocapture: ['$event_type', 'position_template', 'role_id', 'route', 'tag', 'testid'],
    })
  })

  it('公共属性与 SDK 属性白名单钉死（`$current_url` 只许是路由模板）', () => {
    expect(Object.keys(TELEMETRY_COMMON_PROPS).sort()).toEqual([
      'account_id',
      'app_version',
      'install_id',
      'lang',
      'market_region',
      'mode',
      'shell',
    ])
    expect(TELEMETRY_COMMON_PROPS.market_region).toEqual({ kind: 'enum', values: ['CN'] })
    expect(Object.keys(TELEMETRY_SDK_PROPS).sort()).toEqual([
      '$browser',
      '$current_url',
      '$device_id',
      '$device_type',
      '$insert_id',
      '$is_identified',
      '$lib',
      '$lib_version',
      '$os',
      '$pageview_id',
      '$pathname',
      '$process_person_profile',
      '$screen_height',
      '$screen_width',
      '$session_id',
      '$viewport_height',
      '$viewport_width',
      '$window_id',
      'distinct_id',
      'token',
    ])
    expect(TELEMETRY_SDK_PROPS.$current_url).toEqual({ kind: 'route' })
  })

  it('按钮编号都是小写编号、不重复', () => {
    expect(new Set(TELEMETRY_BUTTONS).size).toBe(TELEMETRY_BUTTONS.length)
    for (const id of TELEMETRY_BUTTONS) expect(passesRule({ kind: 'code' }, id)).toBe(true)
  })

  it('文档里每个事件、每个按钮编号都写到了', () => {
    const doc = readFileSync(new URL('../../../docs/telemetry-events.md', import.meta.url), 'utf8')
    for (const name of Object.keys(TELEMETRY_EVENTS)) expect(doc).toContain(`\`${name}\``)
    for (const id of TELEMETRY_BUTTONS) expect(doc).toContain(`\`${id}\``)
    for (const key of Object.keys(TELEMETRY_COMMON_PROPS)) expect(doc).toContain(`\`${key}\``)
  })

  it('上报地址只由环境变量给（默认值只是给桌面壳用的常量）', () => {
    expect(TELEMETRY_HOST_ENV).toBe('AGENTSWS_TELEMETRY_HOST')
    expect(DEFAULT_TELEMETRY_HOST).toBe('https://t.agentsws.com')
  })
})

describe('WP476 白名单：业务内容出不了门', () => {
  it('清单外的事件一律丢（含 SDK 自己的 autocapture / exception / web vitals / pageleave）', () => {
    for (const name of [
      '$autocapture',
      '$exception',
      '$web_vitals',
      '$pageleave',
      '$rageclick',
      '$dead_click',
      '$identify',
      '$set',
      'draft_saved',
      'Hello world',
    ])
      expect(sanitizeTelemetryProps(name, { route: '/' })).toBeNull()
  })

  it('录屏事件只在开了回放时放过，且只带画面与会话号', () => {
    expect(sanitizeTelemetryProps('$snapshot', { $snapshot_data: [] })).toBeNull()
    const out = sanitizeTelemetryProps(
      '$snapshot',
      { $snapshot_data: [], $session_id: 's1', $current_url: 'https://x.example/?q=anna' },
      { replay: true },
    )
    expect(Object.keys(out ?? {}).sort()).toEqual(['$session_id', '$snapshot_data'])
  })

  it('每个事件的每个属性塞业务内容都被丢掉', () => {
    for (const [name, props] of Object.entries(TELEMETRY_EVENTS)) {
      const keys = [
        ...Object.keys(props),
        ...Object.keys(TELEMETRY_COMMON_PROPS),
        ...Object.keys(TELEMETRY_SDK_PROPS),
      ]
      for (const text of BUSINESS) {
        const out = sanitizeTelemetryProps(name, Object.fromEntries(keys.map((k) => [k, text])))
        // autocapture 认不出元素（testid 不在表里）整条丢
        if (name === '$autocapture') expect(out, `${name} ← ${text}`).toBeNull()
        else expect(out, `${name} ← ${text}`).toEqual({})
      }
    }
  })

  it('清单外的属性名一律丢（正文、标题、收件人、`$referrer`、`$initial_current_url`…）', () => {
    const out = sanitizeTelemetryProps('card_decided', {
      decision: 'approve',
      card_kind: 'outbound_draft',
      body: 'Hi Anna',
      subject: 'Re: order',
      to: 'anna@example.com',
      title: 'reply',
      $referrer: 'https://mail.example.com/',
      $host: '127.0.0.1:4317',
      $raw_user_agent: 'Mozilla/5.0',
      $initial_current_url: 'http://127.0.0.1:4317/?draft=x',
      $set: { email: 'anna@example.com' },
    })
    expect(out).toEqual({ decision: 'approve', card_kind: 'outbound_draft' })
  })

  it('合规的值原样留下', () => {
    expect(
      sanitizeTelemetryProps('task_finished', {
        outcome: 'failure',
        cost_tier: 'mid',
        cache_tier: 'high',
        role_id: 'dtc.customer-care',
        position_id: 'dtc-support',
        error_code: 'model_timeout',
        runtime: 'dsh',
        install_id: 'ins_k3f9a0',
        app_version: '0.2.1-beta.5',
        shell: 'server',
      }),
    ).toEqual({
      outcome: 'failure',
      cost_tier: 'mid',
      cache_tier: 'high',
      role_id: 'dtc.customer-care',
      position_id: 'dtc-support',
      error_code: 'model_timeout',
      runtime: 'dsh',
      install_id: 'ins_k3f9a0',
      app_version: '0.2.1-beta.5',
      shell: 'server',
    })
    expect(
      sanitizeTelemetryProps('$pageview', {
        route: '/positions/:id/duties/:role_id',
        $current_url: '/positions/:id',
        $screen_width: 1440,
        $os: 'Mac OS X',
      }),
    ).toEqual({
      route: '/positions/:id/duties/:role_id',
      $current_url: '/positions/:id',
      $screen_width: 1440,
      $os: 'Mac OS X',
    })
  })

  it('编号规则：带长串数字的（订单号、电话）过不去', () => {
    expect(passesRule({ kind: 'code' }, 'order_1002345')).toBe(false)
    expect(passesRule({ kind: 'code' }, 'outbound_draft')).toBe(true)
  })

  it('路由规则：只许模板，具体 id / 查询串 / 大写 / 中文都过不去', () => {
    const route = { kind: 'route' } as const
    for (const ok of ['/', '/inbox', '/positions/:id', '/positions/:assignment/duties/:role_id'])
      expect(passesRule(route, ok), ok).toBe(true)
    for (const bad of ['/positions/a_123', '/inbox?x=1', '/Inbox', '/客户', '/cards/#1', 'inbox'])
      expect(passesRule(route, bad), bad).toBe(false)
  })
})

describe('WP476 档位', () => {
  it('花费只出档', () => {
    expect([0, 0.004, 0.05, 0.5, 3, Number.NaN].map(telemetryCostTier)).toEqual([
      'none',
      'low',
      'mid',
      'high',
      'top',
      'none',
    ])
  })

  it('缓存命中只出档', () => {
    expect(telemetryCacheTier(0, 100)).toBe('none')
    expect(telemetryCacheTier(10, 0)).toBe('none')
    expect(telemetryCacheTier(10, 100)).toBe('low')
    expect(telemetryCacheTier(50, 100)).toBe('mid')
    expect(telemetryCacheTier(90, 100)).toBe('high')
  })
})

describe('决策 1600：market_region', () => {
  it('界面中文（zh*）→ CN；别的语言、没有 → 不带', () => {
    for (const zh of ['zh', 'zh-CN', 'zh-Hans', 'zh_TW', 'ZH'])
      expect(telemetryMarketRegion(zh), zh).toBe('CN')
    for (const other of ['en', 'en-US', 'ja', 'zhx', '', undefined])
      expect(telemetryMarketRegion(other), String(other)).toBeUndefined()
  })

  it('白名单只放 CN 过去：别的地区码、国家名、城市一律丢', () => {
    expect(sanitizeTelemetryProps('app_opened', { lang: 'zh', market_region: 'CN' })).toEqual({
      lang: 'zh',
      market_region: 'CN',
    })
    for (const bad of ['US', 'cn', 'China', '中国', 'Shanghai', 1])
      expect(sanitizeTelemetryProps('app_opened', { market_region: bad }), String(bad)).toEqual({})
  })
})

describe('WP477（决策 1617 / 1618）：autocapture 只留事件类型、testid、标签、路由模板', () => {
  it('testid 表是最新的（改了工作台的 testid 要重跑 node scripts/gen-telemetry-testids.mjs）', () => {
    const fresh = collectTestids()
    expect(TELEMETRY_TESTIDS).toEqual(fresh.statics)
    expect(TELEMETRY_TESTID_TEMPLATES).toEqual(fresh.templates)
    expect(readFileSync(new URL('../src/telemetry-testids.ts', import.meta.url), 'utf8')).toBe(
      render(fresh),
    )
  })

  it('写死的 testid 原样认；带变量的只给模板，变量那段（客户名、邮箱、表头）永远不出门', () => {
    expect(telemetryTestidOf('inbox-row')).toBe('inbox-row')
    expect(telemetryTestidOf('matter-send')).toBe('matter-send')
    expect(telemetryTestidOf('rail-office-sheet-tab-Acme Trading')).toBe('rail-office-sheet-tab-:x')
    expect(telemetryTestidOf('rail-office-sheet-tab-acme')).toBe('rail-office-sheet-tab-:x')
    expect(telemetryTestidOf('rail-office-sheet-tab-:x')).toBe('rail-office-sheet-tab-:x')
    for (const bad of [
      '',
      'acme-trading',
      'anna@example.com',
      '您好 Anna',
      'inbox-row-anna',
      1,
      null,
    ])
      expect(telemetryTestidOf(bad), String(bad)).toBeUndefined()
    for (const t of TELEMETRY_TESTID_TEMPLATES) {
      expect(t).toContain(':x')
      expect(t.replaceAll(':x', '')).toMatch(/[A-Za-z]{2,}/)
    }
  })

  it('收件箱一行（上面有客户名、主题）被点：出门只剩 click / inbox-row / div / 路由模板', () => {
    const out = sanitizeTelemetryProps('$autocapture', {
      $event_type: 'click',
      testid: 'inbox-row',
      tag: 'div',
      route: '/inbox',
      $el_text: 'Anna Schmidt · Re: Wholesale inquiry from Acme Trading',
      $elements: [
        {
          tag_name: 'div',
          $el_text: 'Anna Schmidt',
          attr__title: 'Re: Wholesale inquiry from Acme Trading',
          'attr__data-testid': 'inbox-row',
          nth_child: 3,
        },
      ],
      $elements_chain: 'div.row:text="Anna Schmidt"nth-child="3"',
      $external_click_url: 'https://shop.example.com/orders/10023?customer=anna',
      $element_selectors: ['.inbox-row'],
      $current_url: '/inbox',
      'customer-name': 'Anna Schmidt',
      token: 'phc_testkey0123456789abcdef',
      $session_id: 'sess_0193abc',
    })
    expect(out).toEqual({
      $event_type: 'click',
      testid: 'inbox-row',
      tag: 'div',
      route: '/inbox',
      $current_url: '/inbox',
      token: 'phc_testkey0123456789abcdef',
      $session_id: 'sess_0193abc',
    })
    const raw = JSON.stringify(out)
    for (const text of [...BUSINESS, 'Anna', 'Schmidt', 'Wholesale'])
      expect(raw).not.toContain(text)
  })

  it('没有 testid、testid 不在表里、标签 / 事件类型不在表里：认不出就整条不要 / 那一格丢', () => {
    expect(sanitizeTelemetryProps('$autocapture', { $event_type: 'click', tag: 'div' })).toBeNull()
    expect(
      sanitizeTelemetryProps('$autocapture', { $event_type: 'click', testid: 'acme-trading' }),
    ).toBeNull()
    expect(
      sanitizeTelemetryProps('$autocapture', {
        $event_type: 'copy',
        testid: 'inbox-row',
        tag: 'my-widget',
      }),
    ).toEqual({ testid: 'inbox-row' })
  })
})

describe('WP477（决策 1609）：软件的四件关键事 → GA4', () => {
  it('只有四件事，名字合 GA4 规范（不撞保留名、40 字以内）', () => {
    expect([...GA4_APP_EVENTS]).toEqual([
      'app_first_open',
      'setup_complete',
      'first_task',
      'daily_active',
    ])
    const reserved = ['first_open', 'first_visit', 'session_start', 'user_engagement', 'app_update']
    for (const name of GA4_APP_EVENTS) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
      expect(reserved).not.toContain(name)
    }
    expect(Object.keys(GA4_APP_PARAMS).sort()).toEqual([
      'app_version',
      'engagement_time_msec',
      'market_region',
      'session_id',
    ])
    expect(GA4_MEASUREMENT_ID).toBe('G-P4LBL51H3P')
    expect(GA4_RELAY_PATH).toBe('/mp/collect')
  })

  it('名字不在四件里 → 不发；参数只留白名单里的、值过得了规则的', () => {
    expect(sanitizeGa4Event('first_open', {})).toBeNull()
    expect(sanitizeGa4Event('purchase', {})).toBeNull()
    const out = sanitizeGa4Event('first_task', {
      app_version: '0.2.1-beta.12',
      market_region: 'CN',
      session_id: 1_761_206_400,
      engagement_time_msec: 1,
      role_id: 'dtc.customer-care',
      summary: BUSINESS[0],
      email: BUSINESS[2],
    })
    expect(out).toEqual({
      name: 'first_task',
      params: {
        app_version: '0.2.1-beta.12',
        market_region: 'CN',
        session_id: 1_761_206_400,
        engagement_time_msec: 1,
      },
    })
    for (const text of BUSINESS)
      expect(
        sanitizeGa4Event('daily_active', {
          app_version: text,
          market_region: text,
          session_id: text,
        }),
      ).toEqual({ name: 'daily_active', params: {} })
  })

  it('文档里四件事都写到了', () => {
    const doc = readFileSync(new URL('../../../docs/telemetry-events.md', import.meta.url), 'utf8')
    for (const name of GA4_APP_EVENTS) expect(doc).toContain(`\`${name}\``)
    expect(doc).toContain('`$autocapture`')
  })
})

describe('WP477：按岗位 / 职责看体验', () => {
  it('岗位模板与职责只许是编号；岗位名（中文、空格、大写）在工作台就换成 custom', () => {
    expect(telemetrySafeId('customer-care')).toBe('customer-care')
    expect(telemetrySafeId('dtc.support')).toBe('dtc.support')
    for (const name of [
      'Acme 旗舰店客服',
      'Acme Trading',
      '我的岗位',
      'anna@example.com',
      'pos 10023',
    ])
      expect(telemetrySafeId(name), name).toBe('custom')
    expect(telemetrySafeId(undefined)).toBeUndefined()
    expect(
      sanitizeTelemetryProps('$pageview', {
        route: '/positions/:id',
        position_template: 'Acme 旗舰店客服',
        role_id: 'dtc.support',
      }),
    ).toEqual({ route: '/positions/:id', role_id: 'dtc.support' })
  })
})
