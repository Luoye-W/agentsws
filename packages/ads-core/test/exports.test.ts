/**
 * WP447（docs/109 §6.2）：六个新平台导出报表的解析与体检。
 *
 * `fixtures/ads-export/` 里的样本是**照官方帮助页上的列名手工录的**（10-21 读，出处见 `src/exports/columns.ts`），
 * 不是哪个真账户的导出：官方页写了列名的用官方写法，没写的用通用写法（Campaign name 之类）——
 * 那几列解析出来会落在 `unverified_columns` 里。Microsoft 那份的说明行 / 版权行照官方 Reports 指南的样子录。
 * 真导出拿到之后按它补（报告「未完成」）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_TOTAL_CAMPAIGN,
  APP_ONLY_NOTE,
  auditSkeleton,
  decodeExportBytes,
  detectExportPlatform,
  EXPORT_FORMATS,
  EXPORT_PLATFORMS,
  parsePlatformExport,
  parsePlatformExportGrid,
  runAdsAudit,
} from '../src/index.js'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'ads-export', name), 'utf8')

describe('Microsoft 广告：说明行、版权行、百分数 ROAS', () => {
  const out = parsePlatformExport(fixture('microsoft-campaign.csv'), {
    fileName: 'Campaign_performance.csv',
  })

  it('按列名认出是 Microsoft，说明行读出时区，版权行丢掉并记一笔', () => {
    expect(out.platform).toBe('microsoft')
    expect(out.detected_by).toBe('columns')
    expect(out.timezone).toContain('Pacific Time')
    expect(out.skipped.footer_rows).toBe(1)
    expect(out.skipped.title_lines).toBe(9)
    expect(out.problem).toBeUndefined()
  })

  it('三行、按天、币种 USD、千分位去掉、ROAS 300% → 3', () => {
    expect(out.rows).toHaveLength(3)
    expect(out.by_day).toBe(true)
    expect(out.since).toBe('2026-10-18')
    expect(out.until).toBe('2026-10-19')
    expect(out.currency).toBe('USD')
    const first = out.rows[0]
    expect(first).toMatchObject({
      level: 'campaign',
      day: '2026-10-18',
      campaign: 'Brand Search',
      campaign_id: '500001',
      account: 'Demo Store',
      account_id: 'F123ABCD',
      status: 'enabled',
      roas_from: 'platform',
    })
    expect(first?.metrics).toEqual({
      cost: 1050.25,
      impressions: 4200,
      clicks: 180,
      conversions: 14,
      conversion_value: 3150.75,
      roas: 3,
    })
    expect(out.rows[2]?.metrics.roas).toBeCloseTo(1.3187, 4)
    expect(out.rows[2]?.status).toBe('paused')
    // 这份全是官方核过的列名
    expect(out.unverified_columns).toEqual([])
    expect(out.unknown_columns).toEqual([])
  })

  it('界面帮助页的写法（Campaign / Spend / Revenue）也认', () => {
    const ui = parsePlatformExport(
      'Date,Campaign,Campaign ID,Currency,Spend,Impressions,Clicks,Conversions,Revenue\n2026-10-19,A,1,EUR,10,100,5,1,20\n',
      { platform: 'microsoft' },
    )
    expect(ui.rows[0]?.metrics).toMatchObject({ cost: 10, conversion_value: 20, roas: 2 })
    expect(ui.currency).toBe('EUR')
  })
})

describe('其余五家', () => {
  it('Pinterest：Spend / Pin clicks 是官方列；名字列按通用写法认并照实记下', () => {
    const out = parsePlatformExport(fixture('pinterest-campaign.csv'), {
      fileName: 'pinterest-ads.csv',
    })
    expect(out.platform).toBe('pinterest')
    expect(out.rows).toHaveLength(3)
    expect(out.rows[0]?.metrics).toEqual({ cost: 120.4, impressions: 58000, clicks: 640 })
    expect(out.unverified_columns).toEqual(['Campaign name', 'Campaign ID', 'Date'])
    // 「Outbound clicks」认不成字段，但原样留着，不丢
    expect(out.unknown_columns).toEqual(['Outbound clicks'])
    // 没写币种 / 时区：照实没有，不编
    expect(out.currency).toBeUndefined()
    expect(out.timezone).toBeUndefined()
  })

  it('Reddit：Amount spent / Total value / ROAS 认；Total results 不当转化', () => {
    const out = parsePlatformExport(fixture('reddit-campaign.csv'))
    expect(out.platform).toBe('reddit')
    expect(out.rows[0]?.metrics).toEqual({
      cost: 150,
      impressions: 25000,
      clicks: 310,
      conversion_value: 420,
      roas: 2.8,
    })
    expect(out.unknown_columns).toContain('Total results')
  })

  it('LinkedIn：Spent 是花费；表头前一行标题跳过；没写时区按官方的 UTC', () => {
    const out = parsePlatformExport(fixture('linkedin-campaign.csv'), {
      fileName: 'linkedin_export.csv',
    })
    expect(out.platform).toBe('linkedin')
    expect(out.skipped.title_lines).toBe(1)
    expect(out.timezone).toBe('UTC')
    expect(out.rows[0]).toMatchObject({ day: '2026-10-19', campaign: 'Decision makers - US' })
    expect(out.rows[0]?.metrics).toMatchObject({
      cost: 310,
      conversions: 2,
      conversion_value: 4000,
      roas: 12.9,
    })
  })

  it('LinkedIn：UTF-16 + 制表符的文件也读得出（按 BOM 解）', () => {
    const text = fixture('linkedin-campaign.csv').replaceAll(',', '\t')
    const body = new Uint8Array(text.length * 2 + 2)
    body[0] = 0xff
    body[1] = 0xfe
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i)
      body[2 + i * 2] = c & 0xff
      body[3 + i * 2] = c >> 8
    }
    const out = parsePlatformExport(decodeExportBytes(body), { platform: 'linkedin' })
    expect(out.rows).toHaveLength(2)
    expect(out.rows[1]?.metrics.cost).toBe(90)
  })

  it('Snapchat：Amount Spent / Paid Impressions / Purchases Value；有广告组列就是广告组那一层', () => {
    const out = parsePlatformExport(fixture('snapchat-campaign.csv'))
    expect(out.platform).toBe('snapchat')
    expect(out.level).toBe('ad_group')
    expect(out.rows[0]).toMatchObject({ ad_group: 'Lookalike 1%', campaign: 'Gen Z Summer' })
    expect(out.rows[0]?.metrics).toEqual({
      cost: 75,
      impressions: 30000,
      conversions: 3,
      conversion_value: 180,
      roas: 2.4,
    })
  })

  it('Apple（.xlsx 读成格子再给）：Taps 当点击、安装当转化、没有转化金额', () => {
    const grid = [
      [
        'Day',
        'Campaign Name',
        'Spend',
        'Impressions',
        'Taps',
        'TTR',
        'Installs (Tap-Through)',
        'Installs (Total)',
      ],
      ['2026-10-19', 'Brand - US', '55.00', '2000', '120', '6%', '30', '34'],
    ]
    const out = parsePlatformExportGrid(grid, { fileName: 'Apple Ads report.xlsx' })
    expect(out.platform).toBe('apple')
    expect(out.rows[0]?.metrics).toEqual({
      cost: 55,
      impressions: 2000,
      clicks: 120,
      conversions: 34,
    })
  })

  it('只按天、没有名字列的账户合计也收（记成「账户合计」）', () => {
    const out = parsePlatformExport('Date,Spend,Impressions,Pin clicks\n2026-10-19,10,100,4\n', {
      platform: 'pinterest',
    })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.campaign).toBe(ACCOUNT_TOTAL_CAMPAIGN)
  })
})

describe('认不出就照实说', () => {
  it('Meta / Google 的导出不会被认成这六家（交回老的那条路）', () => {
    expect(
      detectExportPlatform(['Campaign name', 'Amount spent (USD)', 'Impressions', 'Purchases']),
    ).toBeUndefined()
    expect(detectExportPlatform(['Campaign', 'Cost', 'Impr.', 'Conv. value'])).toBeUndefined()
  })

  it('老的 Google / Meta 样本一份都不会被认成这六家', () => {
    for (const name of [
      'google-campaign.csv',
      'google-keyword-zh.csv',
      'google-search-terms.csv',
      'meta-ads.csv',
    ]) {
      const text = readFileSync(join(import.meta.dirname, 'fixtures', 'ads-report', name), 'utf8')
      expect(parsePlatformExport(text, { fileName: name }).platform, name).toBe('unknown')
    }
  })

  it('认不出表头 / 认不出哪一家 → 一句话、零行', () => {
    expect(parsePlatformExport('hello\nworld\n').problem).toContain('表头')
    const odd = parsePlatformExport('Campaign name,Spend,Impressions\nA,1,2\n')
    expect(odd.rows).toEqual([])
    expect(odd.problem).toContain('哪一家')
  })

  it('合计行丢掉', () => {
    const out = parsePlatformExport('Campaign name,Spend,Pin clicks\nA,1,2\nTotal,1,2\n', {
      platform: 'pinterest',
    })
    expect(out.rows).toHaveLength(1)
    expect(out.skipped.total_rows).toBe(1)
  })
})

describe('列名对照是数据：六家都在、官方核过的都带出处', () => {
  it('六家', () => {
    expect([...EXPORT_PLATFORMS]).toEqual([
      'microsoft',
      'pinterest',
      'reddit',
      'linkedin',
      'snapchat',
      'apple',
    ])
  })
  it('写了官方列名的必带出处；没写的标 unknown，不编官方列名', () => {
    for (const p of EXPORT_PLATFORMS)
      for (const col of Object.values(EXPORT_FORMATS[p].columns)) {
        if (col === undefined) continue
        if (col.status === 'verified') {
          expect(col.verified?.length).toBeGreaterThan(0)
          expect(col.source).toMatch(/^https:\/\//)
        } else expect(col.verified).toBeUndefined()
      }
  })
})

describe('体检', () => {
  const ms = parsePlatformExport(fixture('microsoft-campaign.csv'))

  it('拿报表能判的照数判；后台那几项一律「未知」并说去哪看', () => {
    const r = runAdsAudit({
      platform: 'microsoft',
      rows: ms.rows,
      latest: { currency: 'USD', timezone: 'PT', since: '2026-10-18', until: '2026-10-19' },
      today: '2026-10-20',
    })
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
    expect(by.fresh_data?.status).toBe('ok')
    expect(by.currency_stated?.status).toBe('ok')
    expect(by.conversions_tracked?.status).toBe('ok')
    expect(by.zero_conversion_spenders?.status).toBe('ok')
    expect(by.uet_tag?.status).toBe('unknown')
    expect(by.uet_tag?.note).toContain('转化跟踪')
    expect(r.items.length).toBe(auditSkeleton('microsoft').length)
  })

  it('没证据标未知：一份报表都没有时报表那几项也是未知', () => {
    const r = runAdsAudit({ platform: 'pinterest', rows: [], today: '2026-10-20' })
    expect(r.items.every((i) => i.status === 'unknown')).toBe(true)
  })

  it('旧数、没币种、花了钱没转化 → 要看一眼', () => {
    const rows = parsePlatformExport(fixture('reddit-campaign.csv')).rows
    const r = runAdsAudit({
      platform: 'reddit',
      rows,
      latest: { until: '2026-10-01' },
      today: '2026-10-20',
    })
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
    expect(by.fresh_data?.status).toBe('look')
    expect(by.currency_stated?.status).toBe('look')
    // Reddit 的导出里没有转化数那一列（Total results 不当转化）：未知，不猜
    expect(by.conversions_tracked?.status).toBe('unknown')
  })

  it('Apple：没有 App 的品牌整张就一句「这条只适合推 App」，不出空表', () => {
    const none = runAdsAudit({ platform: 'apple', rows: [], today: '2026-10-20' })
    expect(none.app_only).toBe(APP_ONLY_NOTE)
    expect(none.items).toEqual([])
    const told = runAdsAudit({ platform: 'apple', rows: [], today: '2026-10-20', has_app: false })
    expect(told.app_only).toContain('只适合推 App')
    const grid = [
      ['Day', 'Campaign Name', 'Spend', 'Taps', 'Installs (Total)'],
      ['2026-10-19', 'Brand', '10', '5', '2'],
    ]
    const withApp = runAdsAudit({
      platform: 'apple',
      rows: parsePlatformExportGrid(grid, { platform: 'apple' }).rows,
      today: '2026-10-20',
    })
    expect(withApp.app_only).toBeUndefined()
    const value = withApp.items.find((i) => i.id === 'conversion_value')
    expect(value?.status).toBe('not_applicable')
  })
})
