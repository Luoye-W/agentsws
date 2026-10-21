/**
 * WP315：查看数据的库（纯函数）——给「查广告数据」工具用。
 *
 * 只做数：时间窗、平台、层级、排序、合计、按天合计。**不写结论**：哪条算差、要不要止损、日报怎么写，
 * 是到点那次运行里 AI 按用户的要求定的（能力不是功能）。数字原样端出去，没数的格子不补 0。
 */
import {
  type AdsMetrics,
  type AdsReportLevel,
  type AdsReportRow,
  adsRowKey,
  rollUpAdsRows,
  sumAdsMetrics,
} from '@agentsws/ads-core'
import type { AdsDataRow, AdsStoredPlatform } from './store.js'

export const ADS_PERIODS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'this_month',
] as const
export type AdsPeriod = (typeof ADS_PERIODS)[number]

export const ADS_SORTS = [
  'cost',
  'roas',
  'conversions',
  'conversion_value',
  'clicks',
  'impressions',
] as const
export type AdsSort = (typeof ADS_SORTS)[number]

export interface AdsWindow {
  since: string
  until: string
  label: string
}

const shift = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const DAY = /^\d{4}-\d{2}-\d{2}$/u

/** 时间窗（本地日期，含首尾）。给了 since / until 以它们为准；认不出回一句话。 */
export function resolveAdsWindow(
  input: { period?: string; since?: string; until?: string },
  today: string,
): AdsWindow | { problem: string } {
  if (input.since !== undefined || input.until !== undefined) {
    const since = input.since?.slice(0, 10) ?? input.until?.slice(0, 10) ?? today
    const until = input.until?.slice(0, 10) ?? today
    if (!DAY.test(since) || !DAY.test(until) || since > until)
      return { problem: 'since / until 要写成 YYYY-MM-DD，且起不晚于止。' }
    return { since, until, label: since === until ? since : `${since} – ${until}` }
  }
  const p = (input.period ?? 'last_7_days') as AdsPeriod
  switch (p) {
    case 'today':
      return { since: today, until: today, label: `今天（${today}）` }
    case 'yesterday': {
      const y = shift(today, -1)
      return { since: y, until: y, label: `昨天（${y}）` }
    }
    case 'last_7_days':
    case 'last_14_days':
    case 'last_30_days': {
      const n = p === 'last_7_days' ? 7 : p === 'last_14_days' ? 14 : 30
      const since = shift(today, -(n - 1))
      return { since, until: today, label: `最近 ${n} 天（${since} – ${today}，含今天）` }
    }
    case 'this_month': {
      const since = `${today.slice(0, 8)}01`
      return { since, until: today, label: `本月（${since} – ${today}）` }
    }
    default:
      return { problem: `不认识这个时间窗：${String(p)}` }
  }
}

/** 一个对象在窗口里的合计（给模型看的一行）。 */
export interface AdsEntityView {
  platform: AdsStoredPlatform
  level: AdsReportLevel
  name: string
  campaign?: string
  campaign_id?: string
  ad_group?: string
  ad?: string
  keyword?: string
  match?: string
  search_term?: string
  status?: string
  budget?: number
  currency?: string
  metrics: AdsMetrics
  /** 窗口里有几天有数。 */
  days: number
  /** 最新那一天的花费（看「昨天 / 今天」的变化用）。 */
  latest_day?: string
  latest_cost?: number
}

/** 这一层的行（Meta 没有广告系列 / 广告组那一层的行就由广告加上去）。 */
export function levelRows(
  rows: readonly AdsDataRow[],
  level: AdsReportLevel,
): (AdsReportRow & { platform: AdsStoredPlatform; account: string })[] {
  const out: (AdsReportRow & { platform: AdsStoredPlatform; account: string })[] = []
  for (const platform of new Set(rows.map((r) => r.platform)))
    for (const account of new Set(
      rows.filter((r) => r.platform === platform).map((r) => r.account),
    )) {
      const mine = rows.filter((r) => r.platform === platform && r.account === account)
      const direct = mine.filter((r) => r.level === level)
      const list =
        direct.length > 0 || (level !== 'campaign' && level !== 'ad_group')
          ? direct
          : rollUpAdsRows(mine, level)
      for (const r of list) out.push({ ...r, platform, account })
    }
  return out
}

export interface AdsQueryInput {
  level?: AdsReportLevel
  sort?: AdsSort
  order?: 'asc' | 'desc'
  limit?: number
  status?: 'enabled' | 'paused' | 'any'
  search?: string
}

export interface AdsQueryResult {
  level: AdsReportLevel
  /** 每家在窗口里的合计（按广告系列那一层算；币种各算各的，不跨家相加）。 */
  totals: { platform: AdsStoredPlatform; currency?: string; metrics: AdsMetrics }[]
  /** 每家每天的合计（看走势、昨天比前天）。 */
  by_day: { day: string; platform: AdsStoredPlatform; metrics: AdsMetrics }[]
  rows: AdsEntityView[]
  /** 筛完一共几条（`rows` 只列前 `limit` 条）。 */
  count: number
}

const nameOf = (r: AdsReportRow): string =>
  r.search_term ?? r.keyword ?? r.ad ?? r.ad_group ?? r.campaign ?? r.campaign_id ?? ''

/** 窗口里的行（已按时间窗与平台筛好）→ 合计、按天、排好序的一张表。 */
export function queryAdsRows(rows: readonly AdsDataRow[], input: AdsQueryInput): AdsQueryResult {
  const level = input.level ?? 'campaign'
  const campaigns = levelRows(rows, 'campaign')
  const platforms = [...new Set(campaigns.map((r) => r.platform))].sort()
  const totals = platforms.map((platform) => {
    const mine = campaigns.filter((r) => r.platform === platform)
    const currencies = new Set(mine.map((r) => r.currency).filter((c) => c !== undefined))
    return {
      platform,
      ...(currencies.size === 1 ? { currency: [...currencies][0] as string } : {}),
      metrics: sumAdsMetrics(mine),
    }
  })
  const dayKeys = new Map<string, typeof campaigns>()
  for (const r of campaigns) {
    const k = `${r.day ?? ''}|${r.platform}`
    dayKeys.set(k, [...(dayKeys.get(k) ?? []), r])
  }
  const by_day = [...dayKeys.entries()]
    .map(([k, list]) => {
      const [day, platform] = k.split('|') as [string, AdsStoredPlatform]
      return { day, platform, metrics: sumAdsMetrics(list) }
    })
    .sort((a, b) =>
      a.day === b.day ? a.platform.localeCompare(b.platform) : a.day < b.day ? -1 : 1,
    )

  const groups = new Map<string, ReturnType<typeof levelRows>>()
  for (const r of levelRows(rows, level)) {
    const k = `${r.platform}|${r.account}|${adsRowKey(r)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const needle = input.search?.trim().toLowerCase()
  let views: AdsEntityView[] = [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? -1 : 1))
    const last = sorted[sorted.length - 1] as (typeof list)[number]
    const v: AdsEntityView = {
      platform: last.platform,
      level,
      name: nameOf(last),
      metrics: sumAdsMetrics(list),
      days: new Set(list.map((r) => r.day)).size,
    }
    for (const k of [
      'campaign',
      'campaign_id',
      'ad_group',
      'ad',
      'keyword',
      'match',
      'search_term',
      'budget',
      'currency',
    ] as const) {
      const val = last[k]
      if (val !== undefined) (v as unknown as Record<string, unknown>)[k] = val
    }
    if (last.status !== 'unknown') v.status = last.status
    if (last.day !== undefined) v.latest_day = last.day
    if (last.metrics.cost !== undefined) v.latest_cost = last.metrics.cost
    return v
  })
  if (input.status === 'enabled' || input.status === 'paused')
    views = views.filter((v) => v.status === input.status)
  if (needle !== undefined && needle !== '')
    views = views.filter((v) =>
      [v.name, v.campaign, v.ad_group, v.keyword, v.search_term]
        .filter((x): x is string => x !== undefined)
        .some((x) => x.toLowerCase().includes(needle)),
    )
  const sort = input.sort ?? 'cost'
  const dir = input.order === 'asc' ? 1 : -1
  // 没有这一格的排在最后（不当 0 比）
  views.sort((a, b) => {
    const x = a.metrics[sort]
    const y = b.metrics[sort]
    if (x === undefined && y === undefined) return a.name.localeCompare(b.name)
    if (x === undefined) return 1
    if (y === undefined) return -1
    return x === y ? a.name.localeCompare(b.name) : (x - y) * dir
  })
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200)
  return { level, totals, by_day, rows: views.slice(0, limit), count: views.length }
}
