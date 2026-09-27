import { describe, expect, it } from 'vitest'
import {
  classifyGoogleError,
  countSignals,
  dateInZone,
  detectSignals,
  ga4Events,
  ga4LandingRows,
  ga4PropertyOptions,
  ga4Totals,
  googleFailureText,
  gscRollup,
  gscSiteOptions,
  gscWeeks,
  indexStatusOf,
  joinWeeks,
  latestFinalDate,
  pageKindOf,
  pageRevenue,
  pageTargets,
  searchAnalyticsRows,
  sitePagesFrom,
} from '../src/index.js'
import {
  DATE_PROBE,
  GA4_EVENTS,
  GA4_LANDING,
  GA4_LANDING_RAW,
  GA4_TOTALS,
  INSPECT,
  LAST_WEEK,
  LIST_PROPERTIES,
  LIST_SITES,
  THIS_WEEK,
} from './google-fixtures.js'

const QP = ['query', 'page'] as const
/** 北京时间 09-27 13:00 = 太平洋时间 09-26 22:00（夏令时）。 */
const NOW = Date.parse('2026-09-27T05:00:00Z')

describe('窗口与时区（GSC 按太平洋时间）', () => {
  it('太平洋时间的"今天"与 UTC / 北京时间不是同一天', () => {
    expect(dateInZone(NOW, 'America/Los_Angeles')).toBe('2026-09-26')
    expect(dateInZone(NOW, 'Asia/Shanghai')).toBe('2026-09-27')
    expect(dateInZone(NOW, 'Not/AZone')).toBe('2026-09-27')
  })

  it('以探出来的最新完整日为终点：本周 7 天、上周 7 天、首尾相接', () => {
    const latest = latestFinalDate(DATE_PROBE)
    expect(latest).toBe('2026-09-24')
    expect(gscWeeks({ now_ms: NOW, latest_final: latest })).toEqual({
      current: { start: '2026-09-18', end: '2026-09-24' },
      previous: { start: '2026-09-11', end: '2026-09-17' },
    })
  })

  it('没探到就按太平洋时间往前退 3 天；探到的日子比昨天还新就不认', () => {
    expect(gscWeeks({ now_ms: NOW }).current).toEqual({ start: '2026-09-17', end: '2026-09-23' })
    expect(gscWeeks({ now_ms: NOW, latest_final: '2026-09-26' }).current.end).toBe('2026-09-23')
  })

  it('`firstIncompleteDate` 之后的日子不算完整日；没曝光的日子也不算', () => {
    const probe = {
      ...DATE_PROBE,
      rows: [
        ...DATE_PROBE.rows,
        { keys: ['2026-09-25'], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      ],
      metadata: { firstIncompleteDate: '2026-09-24', firstIncompleteHour: null },
    }
    expect(latestFinalDate(probe)).toBe('2026-09-23')
    expect(latestFinalDate({ data: DATE_PROBE })).toBe('2026-09-24')
    expect(latestFinalDate({ nope: true })).toBeUndefined()
  })
})

describe('Search Console 的行', () => {
  const current = searchAnalyticsRows(THIS_WEEK, QP)
  const previous = searchAnalyticsRows(LAST_WEEK, QP)

  it('按请求的维度顺序认 keys；缺数的行丢掉', () => {
    expect(current).toHaveLength(7)
    expect(current[0]?.keys).toEqual({
      query: 'usb c charger for travel',
      page: 'https://www.example-shop.com/blogs/news/usb-c-charger-for-travel',
    })
    expect(searchAnalyticsRows({ rows: [{ keys: ['x'], clicks: 'n/a' }] }, ['query'])).toEqual([])
  })

  it('上周翻完了：没出现的对填 0；没翻完：不写（不知道 ≠ 0）', () => {
    const done = joinWeeks(current, previous, true)
    const bank = done.find((r) => r.query === 'magsafe power bank')
    expect(bank?.clicks_prev_week).toBe(60)
    expect(done.find((r) => r.query === 'anker vs ugreen')?.clicks_prev_week).toBe(0)
    const partial = joinWeeks(current, previous, false)
    expect(partial.find((r) => r.query === 'anker vs ugreen')).not.toHaveProperty(
      'clicks_prev_week',
    )
    expect(joinWeeks(current, undefined, true)[0]).not.toHaveProperty('clicks_prev_week')
  })

  it('按页面汇总：点击相加、平均排名按曝光加权', () => {
    const rows = joinWeeks(current, previous, true)
    const tips = gscRollup(rows, 'page').find((r) => r.key.endsWith('/travel-tips'))
    // (12 × 300 + 30 × 60) / 360 = 15
    expect(tips).toMatchObject({ clicks: 7, impressions: 360, position: 15 })
    expect(gscRollup(rows, 'query')[0]?.key).toBe('example shop charger')
  })
})

describe('六个信号在真形状数据上', () => {
  const rows = joinWeeks(
    searchAnalyticsRows(THIS_WEEK, QP),
    searchAnalyticsRows(LAST_WEEK, QP),
    true,
  )
  const pages = sitePagesFrom(rows, {
    'https://www.example-shop.com/collections/cables': 'canonical_mismatch',
  })
  const hits = detectSignals(rows, pages, { brand_terms: ['Example Shop', 'example-shop'] })
  const of = (signal: string) => hits.filter((h) => h.signal === signal).map((h) => h.row.query)

  it('页面种类按 Shopify 路径认；收录状况带上', () => {
    expect(pages.map((p) => p.kind).sort()).toEqual(
      ['article', 'article', 'collection', 'home', 'product', 'product'].sort(),
    )
    expect(pages.find((p) => p.url.endsWith('/cables'))?.index_status).toBe('canonical_mismatch')
    expect(pageKindOf('https://x.com/en-us/products/a')).toBe('product')
    expect(pageKindOf('https://x.com/search?q=a')).toBe('other')
  })

  it('每个信号都在它该响的那一行上响', () => {
    expect(of('almost_there')).toEqual(['usb c charger for travel', 'charger that works in europe'])
    expect(of('no_clicks')).toEqual(['fast charging cable'])
    expect(of('decaying')).toEqual(['magsafe power bank'])
    expect(of('untargeted')).toEqual(['charger that works in europe'])
    expect(of('wrong_intent')).toEqual(['anker vs ugreen'])
    expect(of('ai_mode')).toEqual(['what is the best charger to bring on a long flight'])
  })

  it('品牌词一条都不响（除了与品牌无关的那几条信号）', () => {
    expect(hits.filter((h) => h.row.query === 'example shop charger')).toEqual([])
    expect(countSignals(hits)).toMatchObject({ almost_there: 2, decaying: 1 })
  })

  it('没有标题时按网址 handle 认"专门写这个词的页"', () => {
    expect(
      pageTargets(
        { url: 'https://x.com/blogs/news/usb-c-charger-for-travel', kind: 'article' },
        'USB C charger for travel',
      ),
    ).toBe(true)
    expect(pageTargets({ url: 'https://x.com/', kind: 'home' }, 'charger')).toBe(false)
  })
})

describe('站点属性、网址检查', () => {
  it('域名属性与网址前缀都列；没验证的不列', () => {
    expect(gscSiteOptions({ data: LIST_SITES })).toEqual([
      {
        site_url: 'sc-domain:example-shop.com',
        kind: 'domain',
        label: 'example-shop.com（整个域名）',
      },
      {
        site_url: 'https://www.example-shop.com/',
        kind: 'url_prefix',
        label: 'https://www.example-shop.com/',
      },
    ])
    expect(gscSiteOptions({})).toEqual([])
  })

  it('收录状况：已收录 / 跳转 / 规范网址 / 没收录；认不出回 undefined', () => {
    expect(indexStatusOf(INSPECT.indexed)).toBe('indexed')
    expect(indexStatusOf(INSPECT.redirect)).toBe('redirect')
    expect(indexStatusOf(INSPECT.canonical)).toBe('canonical_mismatch')
    expect(indexStatusOf(INSPECT.not_indexed)).toBe('not_indexed')
    expect(indexStatusOf({ inspectionResult: {} })).toBeUndefined()
  })
})

describe('GA4', () => {
  it('媒体资源列表：id 缺了从资源名里认', () => {
    expect(ga4PropertyOptions(LIST_PROPERTIES)).toEqual([
      { property_id: '312345678', label: 'Example Shop – GA4（Example Shop）' },
      { property_id: '400000001', label: 'Staging' },
    ])
  })

  it('落地页：字符串转数、算转化率、丢掉 (not set)；也认 Google 原样', () => {
    const out = ga4LandingRows(GA4_LANDING)
    expect(out.currency).toBe('USD')
    expect(out.rows).toEqual([
      {
        page: '/blogs/news/usb-c-charger-for-travel',
        sessions: 52,
        key_events: 4,
        purchases: 2,
        revenue: 118.5,
        conversion_rate: 0.0385,
      },
      {
        page: '/products/magsafe-power-bank',
        sessions: 40,
        key_events: 6,
        purchases: 5,
        revenue: 249.75,
        conversion_rate: 0.125,
      },
    ])
    expect(ga4LandingRows(GA4_LANDING_RAW).rows[0]).toMatchObject({
      page: '/collections/cables',
      sessions: 20,
      purchases: 1,
      conversion_rate: 0.05,
    })
  })

  it('总量分本周 / 上周；事件表', () => {
    expect(ga4Totals(GA4_TOTALS)).toEqual({
      current: { active_users: 1234, sessions: 1500, purchases: 30, revenue: 1890 },
      previous: { active_users: 1100, sessions: 1320, purchases: 24, revenue: 1512.4 },
      currency: 'USD',
    })
    expect(ga4Events(GA4_EVENTS)[2]).toEqual({ event: 'purchase', count: 30, key_events: 30 })
  })

  it('GA4 口径与 Shopify 口径并排：主口径的订单与收入不被 GA4 改掉', () => {
    const landing = ga4LandingRows(GA4_LANDING).rows
    const out = pageRevenue({
      gsc: joinWeeks(searchAnalyticsRows(THIS_WEEK, QP), undefined, false),
      orders: [
        { id: 'o1', landing_site: '/products/magsafe-power-bank', total: 59.9, currency: 'USD' },
      ],
      ga4: landing,
      options: { currency: 'USD', shop_host: 'www.example-shop.com' },
    })
    const bank = out.rows.find((r) => r.page.endsWith('/magsafe-power-bank'))
    expect(bank).toMatchObject({
      orders: 1,
      revenue: 59.9,
      conversion_rate: 0.125,
      ga4_sessions: 40,
      ga4_purchases: 5,
      ga4_revenue: 249.75,
    })
  })
})

describe('出错了怎么说', () => {
  it('配额（429 / quota）、授权、权限、其它', () => {
    const coded = (code: string, message = '') => Object.assign(new Error(message), { code })
    expect(classifyGoogleError(coded('rate_limited'))).toBe('quota')
    expect(classifyGoogleError(new Error('403 Forbidden: quotaExceeded'))).toBe('quota')
    expect(classifyGoogleError(new Error('RESOURCE_EXHAUSTED: tokens per hour'))).toBe('quota')
    expect(classifyGoogleError(coded('unauthenticated'))).toBe('auth')
    expect(classifyGoogleError(new Error('invalid_grant'))).toBe('auth')
    expect(classifyGoogleError(new Error('User does not have sufficient permission'))).toBe(
      'permission',
    )
    expect(classifyGoogleError(new Error('502 bad gateway'))).toBe('other')
  })

  it('人话里说清先用哪一份', () => {
    expect(googleFailureText('gsc', 'quota', true)).toContain('额度用完了，先用上一份')
    expect(googleFailureText('ga4', 'permission', false)).toContain('媒体资源')
    expect(googleFailureText('gsc', 'other', false)).toContain('这一块先空着')
  })
})
