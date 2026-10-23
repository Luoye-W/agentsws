/**
 * WP477（决策 1609）：软件的四件关键事经 `<上报地址>/mp/collect` 报 GA4。**全程不联网**：出门的 fetch 一律是替身。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 只发四件事（`app_first_open`、`setup_complete`、`first_task`、`daily_active`），参数只有版本、地区与会话两格 | 不带业务内容 |
 * | 前三件一台电脑只发一次；`daily_active` 一天一次（发成功才记，落盘、重启还在） | 漏斗口径 |
 * | 开关关了一件都不发 | 用户知情、可关 |
 * | 中文界面带 `market_region: CN`；英文不带 | 决策 1600 |
 * | 云上没配 `GA4_API_SECRET`（`/config` 里 `ga4` 不是 true）→ 一件都不发；没有上报地址 → 一个请求都没有 | 没配就整条不发 |
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GA4_APP_EVENTS } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createTelemetry, localDay, type TelemetryFetch } from '../src/telemetry.js'

const HOST = 'https://t.example.test'
const KEY = 'phc_testkey0123456789abcdef'

const SECRETS = ['您好 Anna，订单 #10023', 'Acme Trading', 'anna@example.com', 'dtc.acme-glasses']

interface Sent {
  url: string
  method: string
  body: string | undefined
}

function fakeFetch(config: { key: string | null; ga4?: boolean } = { key: KEY, ga4: true }) {
  const sent: Sent[] = []
  let failCollect = false
  const fn: TelemetryFetch = async (url, init) => {
    sent.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    if (url.endsWith('/config')) return new Response(JSON.stringify(config), { status: 200 })
    if (url.endsWith('/mp/collect') && failCollect) throw new Error('offline')
    return new Response('{"status":1}', { status: 200 })
  }
  const ga4 = () =>
    sent
      .filter((s) => s.url.endsWith('/mp/collect'))
      .map(
        (s) =>
          JSON.parse(s.body ?? '{}') as {
            client_id: string
            events: { name: string; params: Record<string, unknown> }[]
          },
      )
  return {
    fn,
    sent,
    ga4,
    names: () => ga4().flatMap((b) => b.events.map((e) => e.name)),
    offline(v: boolean) {
      failCollect = v
    },
  }
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp477-'))
  dirs.push(d)
  return d
}
let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function make(
  fetcher: TelemetryFetch | undefined,
  opts: { env?: Record<string, string>; dir?: string; now?: () => string } = {},
) {
  return createTelemetry({
    env: { AGENTSWS_TELEMETRY_HOST: HOST, ...opts.env },
    now: opts.now ?? (() => '2026-10-23T08:00:00.000Z'),
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
    ...(opts.dir === undefined ? {} : { dir: opts.dir }),
    appVersion: '0.2.1-beta.12',
    accountId: () => 'org_3f9a0c1d2e',
    flushIntervalMs: 0,
  })
}

const ev = (type: string, payload: Record<string, unknown> = {}) => ({
  type,
  actor: { kind: 'agent' as const, id: 'asg_x', run_id: 'run_1' },
  correlation: { trace_id: 't', run_id: 'run_1' },
  payload: { ...payload, summary: SECRETS.join(' ') },
})

describe('WP477 只发四件事', () => {
  it('打开 → app_first_open + daily_active；向导走完 → setup_complete；任务跑成 → first_task；参数只有白名单里的', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    await t.update({ lang: 'zh' })
    t.onEvent(ev('onboarding.applied', { assignment_ids: ['asg_x'] }))
    t.onEvent(ev('run.started', { runtime: 'dsh' }))
    t.onEvent(ev('run.completed', { usage: { cost_base: 0.05 } }))
    // 别的事件（卡片、失败的任务、取消）都不报 GA4
    t.onEvent(ev('run.failed', { error: { code: 'X', message: SECRETS[0] } }))
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved' })
    await t.flush()

    expect(f.names().sort()).toEqual(
      ['app_first_open', 'daily_active', 'first_task', 'setup_complete'].sort(),
    )
    expect([...GA4_APP_EVENTS].sort()).toEqual(f.names().sort())
    for (const body of f.ga4()) {
      expect(Object.keys(body).sort()).toEqual(['client_id', 'events'])
      expect(body.client_id).toMatch(/^ins_[a-f0-9]{32}$/)
      for (const e of body.events)
        expect(e.params).toEqual({
          app_version: '0.2.1-beta.12',
          market_region: 'CN',
          session_id: Math.floor(Date.parse('2026-10-23T08:00:00.000Z') / 1000),
          engagement_time_msec: 1,
        })
    }
    const raw = f.sent.map((s) => s.body ?? '').join('\n')
    for (const secret of SECRETS) expect(raw).not.toContain(secret)
    // 都发到 <上报地址>/mp/collect，没有别的去处
    for (const s of f.sent.filter((x) => !x.url.endsWith('/config')))
      expect([`${HOST}/mp/collect`, `${HOST}/batch/`]).toContain(s.url)
  })

  it('前三件只发一次；daily_active 一天一次，换一天再发；落盘、重启还记得', async () => {
    const dir = tmp()
    let clock = '2026-10-23T08:00:00.000Z'
    const f = fakeFetch()
    const t = make(f.fn, { dir, now: () => clock })
    await t.update({ lang: 'en' })
    t.onEvent(ev('onboarding.applied'))
    t.onEvent(ev('run.completed'))
    await t.flush()
    await t.view()
    t.onEvent(ev('onboarding.applied'))
    t.onEvent(ev('run.completed'))
    await t.flush()
    expect(f.names().sort()).toEqual(
      ['app_first_open', 'daily_active', 'first_task', 'setup_complete'].sort(),
    )
    const stored = JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf8')) as {
      ga4: Record<string, string>
      lang: string
    }
    expect(stored.lang).toBe('en')
    expect(stored.ga4.daily_active).toBe(localDay(clock))
    t.close()

    // 重启（同一个数据目录）：同一天什么都不再发；第二天只发 daily_active
    const f2 = fakeFetch()
    const t2 = make(f2.fn, { dir, now: () => clock })
    await t2.view()
    await t2.flush()
    expect(f2.names()).toEqual([])
    clock = '2026-10-25T08:00:00.000Z'
    await t2.view()
    await t2.view()
    await t2.flush()
    expect(f2.names()).toEqual(['daily_active'])
    t2.close()
  })

  it('发不出去：不记，下次打开再发', async () => {
    const f = fakeFetch()
    f.offline(true)
    const t = make(f.fn)
    await t.update({ lang: 'en' })
    await t.flush()
    expect(f.names()).toEqual(['app_first_open', 'daily_active'])
    f.offline(false)
    await t.view()
    await t.flush()
    expect(f.names()).toEqual(['app_first_open', 'daily_active', 'app_first_open', 'daily_active'])
    await t.view()
    await t.flush()
    expect(f.names()).toHaveLength(4)
  })

  it('还不知道界面语言时先不报「打开了」（工作台紧接着会把语言告诉过来）', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    await t.view()
    await t.flush()
    expect(f.names()).toEqual([])
    const v = await t.update({ lang: 'zh' })
    expect(v.lang).toBe('zh')
    await t.flush()
    expect(f.names()).toEqual(['app_first_open', 'daily_active'])
  })
})

describe('WP477 不发的几种情况', () => {
  it('开关关了：一件都不发（之后打开、跑任务也不发）', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    await t.update({ enabled: false, lang: 'zh' })
    await t.view()
    t.onEvent(ev('onboarding.applied'))
    t.onEvent(ev('run.completed'))
    await t.flush()
    expect(f.ga4()).toEqual([])
  })

  it('中文带 market_region=CN；英文不带', async () => {
    const zh = fakeFetch()
    const a = make(zh.fn)
    await a.update({ lang: 'zh' })
    await a.flush()
    const en = fakeFetch()
    const b = make(en.fn)
    await b.update({ lang: 'en' })
    await b.flush()
    for (const body of zh.ga4())
      for (const e of body.events) expect(e.params.market_region).toBe('CN')
    expect(en.ga4().length).toBeGreaterThan(0)
    for (const body of en.ga4())
      for (const e of body.events) expect(e.params).not.toHaveProperty('market_region')
  })

  it('云上没配 GA4_API_SECRET（/config 没说 ga4: true）：一件都不发；PostHog 那边照旧', async () => {
    for (const config of [
      { key: KEY },
      { key: KEY, ga4: false },
      { key: null, ga4: 'yes' as unknown as boolean },
    ]) {
      const f = fakeFetch(config)
      const t = make(f.fn)
      await t.update({ lang: 'zh' })
      t.onEvent(ev('onboarding.applied'))
      t.onEvent(ev('run.completed'))
      await t.flush()
      expect(f.ga4()).toEqual([])
    }
  })

  it('GA4 不依赖 PostHog 的 key：只配了 GA4 也照发', async () => {
    const f = fakeFetch({ key: null, ga4: true })
    const t = make(f.fn)
    await t.update({ lang: 'en' })
    await t.flush()
    expect(f.names()).toEqual(['app_first_open', 'daily_active'])
  })

  it('没有上报地址：一个请求都没有；测试进程里有地址没塞替身：全局 fetch 一次都不叫', async () => {
    const f = fakeFetch()
    const t = make(f.fn, { env: { AGENTSWS_TELEMETRY_HOST: '' } })
    await t.update({ lang: 'zh' })
    t.onEvent(ev('onboarding.applied'))
    t.onEvent(ev('run.completed'))
    await t.flush()
    expect(f.sent).toEqual([])

    const spy = vi.spyOn(globalThis, 'fetch')
    const u = make(undefined, { env: { VITEST: 'true' } })
    await u.update({ lang: 'zh' })
    u.onEvent(ev('run.completed'))
    await u.flush()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('WP477 服务进程里装好了', () => {
  it('PUT /v1/settings/telemetry { lang } 记下语言并报「打开了」；不认的语言 400', async () => {
    const f = fakeFetch()
    server = await createServer({
      dbDir: tmp(),
      quiet: true,
      env: { AGENTSWS_TELEMETRY_HOST: HOST },
      telemetryFetch: f.fn,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
    })
    const s = server
    const call = async (method: string, path: string, body?: unknown) => {
      const headers = new Headers({
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
      })
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> } }
    }
    const put = await call('PUT', '/v1/settings/telemetry', { lang: 'zh' })
    expect(put.json.data).toMatchObject({ lang: 'zh', enabled: true })
    await s.telemetry.flush()
    expect(f.names()).toEqual(['app_first_open', 'daily_active'])
    for (const body of f.ga4()) expect(body.events[0]?.params.market_region).toBe('CN')
    const bad = await call('PUT', '/v1/settings/telemetry', { lang: 'Acme Trading' })
    expect(bad.status).toBe(400)
  })
})

describe('WP477 按岗位 / 职责看体验：只出内置目录里的 id，别的都是 custom', () => {
  const KEYED = { key: KEY, ga4: false }
  const mk = (fetcher: TelemetryFetch) =>
    createTelemetry({
      env: { AGENTSWS_TELEMETRY_HOST: HOST },
      now: () => '2026-10-23T08:00:00.000Z',
      fetch: fetcher,
      flushIntervalMs: 0,
      bundledRoleIds: () => new Set(['dtc.support', 'kol.youtube']),
      bundledPositionIds: () => new Set(['customer-care', 'kol-marketing']),
    })
  const event = (name: string, props: Record<string, unknown>) => ({
    uuid: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
    event: name,
    timestamp: '2026-10-23T08:00:00.000Z',
    properties: {
      token: KEY,
      distinct_id: 'ins_0123456789abcdef0123456789abcdef',
      lang: 'zh',
      ...props,
    },
  })
  const forwarded = (f: ReturnType<typeof fakeFetch>) =>
    f.sent
      .filter((s) => s.url.endsWith('/batch/'))
      .flatMap(
        (s) =>
          (
            JSON.parse(s.body ?? '{}') as {
              batch: { event: string; properties: Record<string, unknown> }[]
            }
          ).batch,
      )

  it('岗位起了客户品牌的名字：发出去的只是模板 id；自建岗位 / 自建职责 → custom', async () => {
    const f = fakeFetch(KEYED)
    const t = mk(f.fn)
    const body = JSON.stringify([
      // 内置岗位（用户把它改名成了「Acme 旗舰店客服」——id 不变，名字不进来）
      event('$pageview', { route: '/positions/:id', position_template: 'customer-care' }),
      // 职责页：内置岗位 + 内置职责
      event('$pageview', {
        route: '/positions/:assignment/duties/:role_id',
        position_template: 'kol-marketing',
        role_id: 'kol.youtube',
      }),
      // 自建岗位（pos-…）、自建职责（id 里拼了品牌名）→ custom
      event('$pageview', {
        route: '/positions/:assignment/duties/:role_id',
        position_template: 'pos-1a2b3c4d',
        role_id: 'dtc.acme-glasses',
      }),
      // 工作台没洗干净的岗位名（不该发生）：过不了编号规则，整格丢
      event('$pageview', { route: '/positions/:id', position_template: 'Acme 旗舰店客服' }),
      event('$autocapture', {
        $event_type: 'click',
        testid: 'inbox-row',
        tag: 'div',
        route: '/inbox',
        role_id: 'dtc.support',
        $el_text: SECRETS[0],
      }),
      event('ui_click', {
        button_id: 'card.approve',
        route: '/inbox',
        role_id: 'acme.custom-duty',
      }),
    ])
    await t.ingest({ kind: 'e', query: '', body: new TextEncoder().encode(body) })
    const out = forwarded(f).map((e) => [
      e.event,
      e.properties.position_template,
      e.properties.role_id,
    ])
    expect(out).toEqual([
      ['$pageview', 'customer-care', undefined],
      ['$pageview', 'kol-marketing', 'kol.youtube'],
      ['$pageview', 'custom', 'custom'],
      ['$pageview', undefined, undefined],
      ['$autocapture', undefined, 'dtc.support'],
      ['ui_click', undefined, 'custom'],
    ])
    const raw = f.sent.map((s) => s.body ?? '').join('\n')
    for (const s of [...SECRETS, 'Acme 旗舰店客服', 'pos-1a2b3c4d', 'acme'])
      expect(raw).not.toContain(s)
  })

  it('卡片定了：带卡挂的那条职责（内置原样、自建 custom）', async () => {
    const f = fakeFetch(KEYED)
    const t = mk(f.fn)
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved', role_id: 'dtc.support' })
    t.onCardDecided({ kind: 'outbound_draft', state: 'rejected', role_id: 'dtc.acme-glasses' })
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved_edited' })
    await t.flush()
    expect(forwarded(f).map((e) => [e.event, e.properties.decision, e.properties.role_id])).toEqual(
      [
        ['card_decided', 'approve', 'dtc.support'],
        ['card_decided', 'reject', 'custom'],
        ['card_decided', 'edit', undefined],
      ],
    )
  })
})
