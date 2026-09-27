/**
 * WP158：Search Console 与 GA4 的真读数那一层（`google-reads.ts`）。
 *
 * 连接器全是替身（不联网、没有真账号）：返回形状照 OpenConnector v1.6.5 的
 * `google_search_console` / `google_analytics` provider 归一后的样子。守五件事：
 * 选站点（自动 / 手动 / 没选不读）、窗口与时区、按天缓存、失败保留上一份、令牌守卫。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createGoogleReads, GSC_PICK_SITE, scrubDetail } from '../src/google-reads.js'

const TOKEN = 'ocx_exec_SECRET_do_not_leak_9f8e7d'
const SITE = 'https://www.example-shop.com'

interface Call {
  action: string
  input: Record<string, unknown>
  token: string
  connection?: string
}

/** 一个会记账的假连接器。`fail` 返回非 undefined 就按它抛。 */
function fakeConnect(over: {
  sites?: { siteUrl: string; permissionLevel: string }[]
  properties?: { propertyId: string; displayName: string }[]
  fail?: (action: string, input: Record<string, unknown>) => Error | undefined
}) {
  const calls: Call[] = []
  const issued: {
    assignment_id?: string
    allowed_actions: string[]
    allowed_connections: string[]
    kind: string
  }[] = []
  const revoked: string[] = []
  const read = (svc: string, names: string[]) =>
    names.map((n) => ({ id: `${svc}.${n}`, side_effect: 'read' }))
  const row = (q: string, path: string, c: number, i: number, p: number) => ({
    keys: [q, `${SITE}${path}`],
    clicks: c,
    impressions: i,
    ctr: c / i,
    position: p,
  })
  const connect = {
    actions: async (service: string) =>
      service === 'google_search_console'
        ? [
            ...read(service, ['list_sites', 'query_search_analytics', 'inspect_url']),
            { id: `${service}.delete_site`, side_effect: 'write' },
          ]
        : service === 'google_analytics'
          ? read(service, ['list_properties', 'run_report'])
          : [],
    issueToken: async (input: {
      assignment_id?: string
      allowed_actions: string[]
      allowed_connections: string[]
      kind: string
    }) => {
      issued.push(input)
      return { token: TOKEN }
    },
    revokeTokens: async (assignment_id: string) => {
      revoked.push(assignment_id)
    },
    execute: async (
      action_id: string,
      raw: unknown,
      opts: { token: string; connection?: string },
    ) => {
      const input = raw as Record<string, unknown>
      calls.push({
        action: action_id,
        input,
        token: opts.token,
        ...(opts.connection ? { connection: opts.connection } : {}),
      })
      const err = over.fail?.(action_id, input)
      if (err !== undefined) throw err
      const name = action_id.split('.').pop()
      if (name === 'list_sites')
        return {
          data: {
            sites: over.sites ?? [
              { siteUrl: 'sc-domain:example-shop.com', permissionLevel: 'siteOwner' },
            ],
          },
        }
      if (name === 'list_properties')
        return {
          data: {
            properties: over.properties ?? [{ propertyId: '3123', displayName: 'Shop' }],
            nextPageToken: null,
          },
        }
      if (name === 'inspect_url')
        return {
          data: {
            inspectionResult: {
              indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' },
            },
          },
        }
      if (name === 'run_report') {
        const dims = (input.dimensions as string[] | undefined) ?? []
        if (dims[0] === 'landingPage')
          return {
            data: {
              report: {
                rows: [
                  {
                    dimensions: { landingPage: '/products/magsafe-power-bank' },
                    metrics: {
                      sessions: '40',
                      keyEvents: '6',
                      ecommercePurchases: '5',
                      purchaseRevenue: '249.75',
                    },
                  },
                ],
                metadata: { currencyCode: 'USD' },
              },
            },
          }
        if (dims[0] === 'eventName')
          return {
            data: {
              report: {
                rows: [
                  {
                    dimensions: { eventName: 'purchase' },
                    metrics: { eventCount: '30', keyEvents: '30' },
                  },
                ],
              },
            },
          }
        return {
          data: {
            report: {
              rows: [
                {
                  dimensions: { dateRange: 'current' },
                  metrics: {
                    activeUsers: '1234',
                    sessions: '1500',
                    ecommercePurchases: '30',
                    purchaseRevenue: '1890',
                  },
                },
                {
                  dimensions: { dateRange: 'previous' },
                  metrics: {
                    activeUsers: '1100',
                    sessions: '1320',
                    ecommercePurchases: '24',
                    purchaseRevenue: '1512.4',
                  },
                },
              ],
            },
          },
        }
      }
      // query_search_analytics
      const dims = input.dimensions as string[]
      if (dims[0] === 'date')
        return {
          data: {
            rows: [
              { keys: ['2026-09-24'], clicks: 110, impressions: 8700, ctr: 0.0126, position: 11.3 },
            ],
            responseAggregationType: 'byProperty',
            metadata: { firstIncompleteDate: null, firstIncompleteHour: null },
          },
        }
      const thisWeek = input.startDate === '2026-09-18'
      return {
        data: {
          rows: thisWeek
            ? [
                row('magsafe power bank', '/products/magsafe-power-bank', 30, 700, 2.1),
                row(
                  'usb c charger for travel',
                  '/blogs/news/usb-c-charger-for-travel',
                  40,
                  900,
                  7.4,
                ),
              ]
            : [row('magsafe power bank', '/products/magsafe-power-bank', 60, 720, 1.9)],
          responseAggregationType: 'byPage',
          metadata: { firstIncompleteDate: null, firstIncompleteHour: null },
        },
      }
    },
  }
  return { connect, calls, issued, revoked }
}

function setup(opts: {
  services?: string[]
  connect: ReturnType<typeof fakeConnect>['connect']
  now?: { value: string }
  dir?: string
}) {
  const events: EventEnvelope[] = []
  const now = opts.now ?? { value: '2026-09-27T05:00:00.000Z' }
  const reads = createGoogleReads({
    workspace_id: 'ws_1',
    clock: { now: () => now.value },
    connections: () =>
      (opts.services ?? ['gsc', 'ga4']).map((service, i) => ({
        id: `conn_${i}`,
        service,
        status: 'active',
      })),
    connect: opts.connect,
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...(opts.dir === undefined ? {} : { dir: opts.dir }),
  })
  return { reads, events, now }
}

const queryCalls = (calls: Call[]) =>
  calls.filter((c) => c.action.endsWith('.query_search_analytics'))

describe('选哪个站点', () => {
  it('好几个站点又没选：不读数，说一句"选一下"；面板那几块说先选', async () => {
    const f = fakeConnect({
      sites: [
        { siteUrl: 'sc-domain:example-shop.com', permissionLevel: 'siteOwner' },
        { siteUrl: `${SITE}/`, permissionLevel: 'siteFullUser' },
      ],
    })
    const { reads } = setup({ services: ['gsc'], connect: f.connect })
    await expect(reads.searchConsole().rows({ end: '' })).rejects.toThrow(GSC_PICK_SITE)
    expect(queryCalls(f.calls)).toHaveLength(0)
    const view = await reads.sources()
    expect(view.gsc).toMatchObject({ connected: true, needs_pick: true })
    expect(view.gsc.options.map((o) => o.id)).toEqual(['sc-domain:example-shop.com', `${SITE}/`])
    expect(view.ga4).toEqual({ connected: false, options: [], needs_pick: false })
    expect(reads.deckData()?.gsc?.needs_pick).toBe(true)
  })

  it('选了立刻读；不在清单里的不认', async () => {
    const f = fakeConnect({
      sites: [
        { siteUrl: 'sc-domain:example-shop.com', permissionLevel: 'siteOwner' },
        { siteUrl: `${SITE}/`, permissionLevel: 'siteFullUser' },
      ],
    })
    const dir = mkdtempSync(join(tmpdir(), 'wp158-'))
    const { reads } = setup({ services: ['gsc'], connect: f.connect, dir })
    await expect(reads.select({ gsc_site: 'https://evil.example/' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    const out = await reads.select({ gsc_site: `${SITE}/` })
    expect(out.gsc_changed).toBe(true)
    expect(out.view.gsc).toMatchObject({ needs_pick: false, selected: `${SITE}/` })
    expect(queryCalls(f.calls).every((c) => c.input.siteUrl === `${SITE}/`)).toBe(true)
    expect(queryCalls(f.calls).length).toBeGreaterThan(0)
    // 选择落盘：只有站点与连接 id，没有任何令牌
    const saved = readFileSync(join(dir, 'google-reads.json'), 'utf8')
    expect(JSON.parse(saved)).toEqual({ gsc_site: `${SITE}/`, gsc_connection: 'conn_0' })
    expect(saved).not.toContain(TOKEN)
  })
})

describe('窗口、缓存、失败', () => {
  it('只有一个站点就自动选；按太平洋时间探出最新完整日，本周与上周各取一次', async () => {
    const f = fakeConnect({})
    const { reads } = setup({ services: ['gsc'], connect: f.connect })
    const rows = await reads.searchConsole().rows({ end: '' })
    expect(rows.find((r) => r.query === 'magsafe power bank')).toMatchObject({
      clicks: 30,
      clicks_prev_week: 60,
    })
    // 上周那一份翻完了：本周有、上周没有的那一对就是 0
    expect(rows.find((r) => r.query === 'usb c charger for travel')?.clicks_prev_week).toBe(0)
    const windows = queryCalls(f.calls).map((c) => [c.input.startDate, c.input.endDate])
    expect(windows).toContainEqual(['2026-09-18', '2026-09-24'])
    expect(windows).toContainEqual(['2026-09-11', '2026-09-17'])
    const pages = await reads.searchConsole().pages()
    expect(pages.find((p) => p.url.endsWith('/magsafe-power-bank'))).toMatchObject({
      kind: 'product',
      index_status: 'indexed',
    })
    expect(reads.deckData()?.gsc?.queries[0]?.key).toBe('usb c charger for travel')
  })

  it('同一天只读一次；过了一天再读', async () => {
    const f = fakeConnect({})
    const { reads, now } = setup({ services: ['gsc'], connect: f.connect })
    await reads.searchConsole().rows({ end: '' })
    const first = f.calls.length
    await reads.searchConsole().rows({ end: '' })
    await reads.ensureFresh()
    expect(f.calls.length).toBe(first)
    now.value = '2026-09-28T05:00:00.000Z'
    await reads.ensureFresh()
    expect(f.calls.length).toBeGreaterThan(first)
  })

  it('上游配额用尽：保留上一份、说人话、当天不再重试', async () => {
    let broken = false
    const f = fakeConnect({
      fail: (action) =>
        broken && action.endsWith('query_search_analytics')
          ? Object.assign(new Error(`429 RESOURCE_EXHAUSTED quota exceeded (Bearer ${TOKEN})`), {
              code: 'rate_limited',
            })
          : undefined,
    })
    const { reads, events, now } = setup({ services: ['gsc'], connect: f.connect })
    const before = await reads.searchConsole().rows({ end: '' })
    broken = true
    now.value = '2026-09-28T05:00:00.000Z'
    const port = reads.searchConsole()
    expect(await port.rows({ end: '' })).toEqual(before)
    expect(port.note?.()).toContain('额度用完了，先用上一份')
    const failed = events.find((e) => e.type === 'data.refresh_failed')
    expect(failed?.payload).toMatchObject({ source: 'gsc', reason: 'quota', kept_cached: true })
    const calls = f.calls.length
    await reads.ensureFresh()
    expect(f.calls.length).toBe(calls)
  })

  it('一开始就读不到：没有上一份就明说，不给空数组冒充"今天没数"', async () => {
    const f = fakeConnect({
      fail: (a) =>
        a.endsWith('query_search_analytics') ? new Error('502 bad gateway') : undefined,
    })
    const { reads } = setup({ services: ['gsc'], connect: f.connect })
    await expect(reads.searchConsole().rows({ end: '' })).rejects.toThrow('这一块先空着')
  })
})

describe('GA4', () => {
  it('没选媒体资源：说一句；只有一个就自动选上并读回落地页、总量、事件', async () => {
    const two = fakeConnect({
      properties: [
        { propertyId: '1', displayName: 'A' },
        { propertyId: '2', displayName: 'B' },
      ],
    })
    const pending = setup({ services: ['ga4'], connect: two.connect })
    expect(await pending.reads.ga4Conversions()).toBeUndefined()
    expect(pending.reads.ga4Note()).toContain('还没选是哪个媒体资源')

    const f = fakeConnect({})
    const { reads } = setup({ connect: f.connect })
    const conv = await reads.ga4Conversions()
    expect(conv).toEqual([
      {
        page: '/products/magsafe-power-bank',
        conversion_rate: 0.125,
        sessions: 40,
        purchases: 5,
        revenue: 249.75,
      },
    ])
    // GA4 问的是与 GSC 同一周
    const report = f.calls.find((c) => c.action.endsWith('.run_report'))
    expect(report?.input.dateRanges).toEqual([{ startDate: '2026-09-18', endDate: '2026-09-24' }])
    expect(report?.input.dimensionFilter).toMatchObject({
      filter: { fieldName: 'sessionDefaultChannelGroup' },
    })
    const deck = reads.deckData()?.ga4
    expect(deck).toMatchObject({
      current: { active_users: 1234 },
      previous: { active_users: 1100 },
      currency: 'USD',
    })
    expect(deck?.events).toEqual([{ event: 'purchase', count: 30, key_events: 30 }])
    expect(reads.ga4Note()).toBeUndefined()
  })
})

describe('令牌守卫', () => {
  it('只签只读令牌、只许读口与这一条连接、用完吊销；写口永远签不进去', async () => {
    const f = fakeConnect({})
    const { reads } = setup({ connect: f.connect })
    await reads.ensureFresh()
    expect(f.issued.length).toBeGreaterThan(0)
    for (const t of f.issued) {
      expect(t.kind).toBe('role-read')
      expect(t.allowed_actions.some((a) => a.endsWith('.delete_site'))).toBe(false)
      expect(t.allowed_connections).toHaveLength(1)
    }
    expect(f.revoked.length).toBe(f.issued.length)
    expect(f.calls.every((c) => c.token === TOKEN)).toBe(true)
    // 吊销按 assignment 一把全吊：每次读各用一个独有的，只吊自己签的那张（Fable 终审补）
    const ids = f.issued.map((t) => t.assignment_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...f.revoked].sort()).toEqual([...ids].sort())
  })

  it('令牌不进事件、不进卡上的人话、不进面板数据', async () => {
    let broken = false
    const f = fakeConnect({
      fail: (action) =>
        broken && action.endsWith('.run_report')
          ? new Error(`upstream said: access_token=${TOKEN} Bearer ya29.a0AfH6SMBxyz`)
          : undefined,
    })
    const { reads, events, now } = setup({ connect: f.connect })
    await reads.ensureFresh()
    broken = true
    now.value = '2026-09-28T05:00:00.000Z'
    await reads.ensureFresh()
    const everything = JSON.stringify({
      events,
      deck: reads.deckData(),
      view: await reads.sources(),
      note: reads.ga4Note(),
    })
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('ya29.')
    expect(events.some((e) => e.type === 'data.refresh_failed')).toBe(true)
    // 事件里只有条数，没有一个查询词
    expect(JSON.stringify(events)).not.toContain('magsafe')
  })

  it('抹令牌：执行令牌原样、Bearer、ya29、refresh token、token= 都抹掉', () => {
    const out = scrubDetail(
      new Error(
        `x ${TOKEN} Bearer abc.def ya29.QQ 1//0gABCDEFGHIJKLMNOPQRSTUV refresh_token: zzzzzzzzzz`,
      ),
      [TOKEN],
    )
    expect(out).not.toContain(TOKEN)
    expect(out).not.toMatch(/abc\.def|ya29\.QQ|1\/\/0g|zzzzzzzzzz/)
  })
})
