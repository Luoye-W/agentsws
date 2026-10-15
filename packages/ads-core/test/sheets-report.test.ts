/**
 * WP315：看数据——手写的样例导出（假名字、假编号）认成按天的表现行。
 * 样例照两家帮助页对导出格式的描述手写，没对真导出核过（真站首跑补别名，决策 619）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adsReportRows,
  adsRowKey,
  decodeExportBytes,
  exportFieldOf,
  parseAdsExport,
  parseExportDay,
  reportLevelOf,
  rollUpAdsRows,
  sumAdsMetrics,
} from '../src/index.js'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'ads-report', name), 'utf8')

describe('日期认法', () => {
  it('认几种常见写法，认不出不猜', () => {
    expect(parseExportDay('2026-10-14')).toBe('2026-10-14')
    expect(parseExportDay('2026/10/4')).toBe('2026-10-04')
    expect(parseExportDay('2026年10月14日')).toBe('2026-10-14')
    expect(parseExportDay('10/14/2026')).toBe('2026-10-14')
    expect(parseExportDay('Oct 14, 2026')).toBe('2026-10-14')
    expect(parseExportDay('14 Oct 2026')).toBe('2026-10-14')
    expect(parseExportDay('yesterday')).toBeUndefined()
    expect(parseExportDay('2026-13-01')).toBeUndefined()
  })
})

describe('Google 广告系列报表（标题行 + 合计行 + 按天）', () => {
  const parsed = parseAdsExport(fixture('google-campaign.csv'))
  const rows = adsReportRows(parsed)

  it('认出层级与平台，丢掉标题行与合计行', () => {
    expect(parsed.platform).toBe('google')
    expect(reportLevelOf(parsed)).toBe('campaign')
    expect(parsed.skipped).toEqual({ title_lines: 2, total_rows: 1 })
    expect(rows).toHaveLength(3)
  })

  it('每天一行；平台的 ROAS 列照抄，`--` 是没数不是 0', () => {
    const [a, b, c] = rows
    expect(a).toMatchObject({
      level: 'campaign',
      day: '2026-10-13',
      campaign: 'Spring Sale',
      campaign_id: '111',
      status: 'enabled',
      budget: 200,
      currency: 'USD',
      metrics: { cost: 1050, clicks: 400, conversions: 12, conversion_value: 2100, roas: 2 },
      roas_from: 'platform',
    })
    expect(b?.metrics.roas).toBe(0)
    expect(c?.status).toBe('paused')
    expect(c?.metrics).toEqual({})
    expect(adsRowKey(a as never)).toBe(adsRowKey(b as never))
  })

  it('跨天合计用合计重算 ROAS（平台的 ROAS 不能相加）', () => {
    expect(sumAdsMetrics(rows)).toEqual({
      cost: 1140,
      impressions: 21800,
      clicks: 430,
      conversions: 12,
      conversion_value: 2100,
      roas: 1.84,
    })
  })
})

describe('Google 搜索字词 / 中文界面的关键词报表', () => {
  it('搜索字词一层：带上触发它的关键词，没有状态', () => {
    const rows = adsReportRows(parseAdsExport(fixture('google-search-terms.csv')))
    expect(rows.map((r) => [r.level, r.search_term, r.keyword, r.status])).toEqual([
      ['search_term', 'magnetic tiles', 'magnetic tiles', 'unknown'],
      ['search_term', 'magnet toys for kids', 'magnet toys', 'unknown'],
    ])
    expect(rows[1]?.metrics.roas).toBe(0)
    expect(rows[1]?.roas_from).toBe('computed')
  })

  it('中文表头、中文状态、中文匹配方式、「总计」行', () => {
    const parsed = parseAdsExport(fixture('google-keyword-zh.csv'))
    expect(parsed.platform).toBe('google')
    expect(parsed.skipped.total_rows).toBe(1)
    const [row] = adsReportRows(parsed)
    expect(row).toMatchObject({
      level: 'keyword',
      day: '2026-10-14',
      campaign: '春季促销',
      ad_group: '磁力片',
      keyword: '磁力片',
      match: 'exact',
      status: 'enabled',
      metrics: { cost: 40, impressions: 600, clicks: 12 },
    })
    expect(exportFieldOf('点击量（全部）')).toBe('clicks')
    expect(exportFieldOf('已花费金额 (CNY)')).toBe('cost')
  })
})

describe('Meta 广告报表（一行一条广告）', () => {
  const parsed = parseAdsExport(fixture('meta-ads.csv'))
  const rows = adsReportRows(parsed)

  it('货币后缀、平台 ROAS、空 ROAS 用同一行算', () => {
    expect(parsed.platform).toBe('meta')
    expect(rows.map((r) => [r.level, r.ad, r.metrics.cost, r.metrics.roas, r.roas_from])).toEqual([
      ['ad', 'Video A', 30, 6, 'platform'],
      ['ad', 'Video B', 25.5, 0, 'computed'],
      ['ad', 'Carousel 1', 120, 0.33, 'platform'],
    ])
  })

  it('往上加到广告系列：同一天同一系列合成一行', () => {
    const up = rollUpAdsRows(rows, 'campaign')
    expect(up.map((r) => [r.campaign, r.metrics.cost, r.metrics.roas])).toEqual([
      ['Retargeting', 55.5, 3.24],
      ['Prospecting', 120, 0.33],
    ])
    expect(up.every((r) => r.status === 'unknown' && r.budget === undefined)).toBe(true)
  })

  it('UTF-16 的 Excel CSV 一样认（字节先解）', () => {
    const text = fixture('meta-ads.csv').replace(/,/g, '\t')
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i)
      bytes[2 + i * 2] = c & 0xff
      bytes[3 + i * 2] = c >> 8
    }
    expect(adsReportRows(parseAdsExport(decodeExportBytes(bytes)))).toHaveLength(3)
  })
})
