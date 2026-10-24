/**
 * WP315（docs/101 §5.1① 看数据，决策 560）：把两家后台**导出的报表文件**认成一行一行的表现数。
 *
 * 和 `exportEntities`（读回核对用：一行拆好几层、按天累加）不同，这里**保留每一天**、只认这一行最细的那一层，
 * 并多认一层「搜索字词」：看数据要按天存（平台会回补转化，最近几天的数每天重导一次覆盖），
 * 汇总到哪一层由查数那一跳按需加。
 *
 * ROAS：表里有平台自己那一列就用它（`roas_from: 'platform'`）；没有就用**同一行**的转化价值 ÷ 花费
 * （`'computed'`，两样都是平台口径的数，没有跨平台混算）。跨天汇总一律用合计重算（平台的 ROAS 不能相加）。
 */

import {
  type EntityStatus,
  type ExportField,
  normalizeStatus,
  type ParsedAdsExport,
  parseExportNumber,
  splitGoogleKeyword,
} from './parse.js'

/** 看数据的五层（Meta 没有关键词 / 搜索字词）。 */
export type AdsReportLevel = 'campaign' | 'ad_group' | 'ad' | 'keyword' | 'search_term'

export const ADS_REPORT_LEVELS: readonly AdsReportLevel[] = [
  'campaign',
  'ad_group',
  'ad',
  'keyword',
  'search_term',
]

export interface AdsMetrics {
  cost?: number
  impressions?: number
  clicks?: number
  conversions?: number
  conversion_value?: number
  roas?: number
  /** WP452：频次（展示 ÷ 覆盖人数，平台给的那个数；是比例，跨天 / 跨行不相加）。 */
  frequency?: number
}

export interface AdsReportRow {
  level: AdsReportLevel
  /** 本地日期 `YYYY-MM-DD`（表里没有按天拆就没有这一格）。 */
  day?: string
  account?: string
  account_id?: string
  currency?: string
  campaign?: string
  campaign_id?: string
  ad_group?: string
  ad_group_id?: string
  ad?: string
  ad_id?: string
  keyword?: string
  match?: 'broad' | 'phrase' | 'exact'
  search_term?: string
  /** 这一层自己的状态（搜索字词没有状态）。 */
  status: EntityStatus
  /** 广告系列 / 广告组的日预算（账户币种）。 */
  budget?: number
  metrics: AdsMetrics
  roas_from?: 'platform' | 'computed'
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number): string | undefined =>
  y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : undefined

/**
 * 表里的日期 → `YYYY-MM-DD`。认 `2026-10-14`、`2026/10/14`、`2026年10月14日`、`10/14/2026`、
 * `Oct 14, 2026`、`14 Oct 2026`；认不出回 `undefined`（不猜）。
 */
export function parseExportDay(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const t = value.trim()
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u.exec(t)
  if (m !== null) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(t)
  if (m !== null) return ymd(Number(m[3]), Number(m[1]), Number(m[2]))
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/iu.exec(t)
  if (m !== null)
    return ymd(Number(m[3]), MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1, Number(m[2]))
  m = /^(\d{1,2}) ([a-z]{3})[a-z]*\.? (\d{4})$/iu.exec(t)
  if (m !== null)
    return ymd(Number(m[3]), MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1, Number(m[1]))
  return undefined
}

const has = (fields: readonly (ExportField | undefined)[], f: ExportField): boolean =>
  fields.includes(f)

/** 这份表是哪一层（按表头里最细的那一列认）。认不出回 `undefined`。 */
export function reportLevelOf(parsed: ParsedAdsExport): AdsReportLevel | undefined {
  const f = parsed.fields
  if (has(f, 'search_term')) return 'search_term'
  if (has(f, 'keyword')) return 'keyword'
  if (has(f, 'ad') || has(f, 'ad_id') || has(f, 'headline_1')) return 'ad'
  if (has(f, 'ad_group') || has(f, 'ad_group_id')) return 'ad_group'
  if (has(f, 'campaign') || has(f, 'campaign_id')) return 'campaign'
  return undefined
}

const METRIC_FIELDS = ['cost', 'impressions', 'clicks', 'conversions', 'conversion_value'] as const

/** ROAS：两样都有、花费 > 0 才算（花费 0 时「没有 ROAS」，不是 0 也不是无穷）。 */
export function roasOf(m: AdsMetrics): number | undefined {
  if (m.cost === undefined || m.conversion_value === undefined || m.cost <= 0) return undefined
  return Math.round((m.conversion_value / m.cost) * 100) / 100
}

/**
 * 解析好的导出 → 一行一行（这一行最细的那一层）。认不出层级回空数组。
 * `level` 给了就按它认（文件名 / 步骤表知道是哪一层时），不给按表头猜。
 */
export function adsReportRows(
  parsed: ParsedAdsExport,
  options: { level?: AdsReportLevel } = {},
): AdsReportRow[] {
  const level = options.level ?? reportLevelOf(parsed)
  if (level === undefined) return []
  const out: AdsReportRow[] = []
  for (const row of parsed.rows) {
    const v = row.values
    const metrics: AdsMetrics = {}
    for (const k of METRIC_FIELDS) {
      const n = parseExportNumber(v[k])
      if (n !== undefined) metrics[k] = n
    }
    const frequency = parseExportNumber(v.frequency)
    if (frequency !== undefined) metrics.frequency = frequency
    const platformRoas = parseExportNumber(v.roas)
    const computed = roasOf(metrics)
    if (platformRoas !== undefined) metrics.roas = platformRoas
    else if (computed !== undefined) metrics.roas = computed
    // 一行一个数都没有、也没有名字的（空行 / 小计行）不要
    const named =
      v.campaign ?? v.campaign_id ?? v.ad_group ?? v.ad ?? v.ad_id ?? v.keyword ?? v.search_term
    if (named === undefined) continue
    const own =
      level === 'campaign'
        ? v.campaign_status
        : level === 'ad_group'
          ? v.ad_group_status
          : level === 'ad'
            ? v.ad_status
            : undefined
    const r: AdsReportRow = {
      level,
      status: level === 'search_term' ? 'unknown' : normalizeStatus(own ?? v.status),
      metrics,
    }
    if (platformRoas !== undefined) r.roas_from = 'platform'
    else if (computed !== undefined) r.roas_from = 'computed'
    const put = <K extends keyof AdsReportRow>(k: K, val: AdsReportRow[K] | undefined): void => {
      if (val !== undefined) r[k] = val
    }
    put('day', parseExportDay(v.day))
    put('account', v.account)
    put('account_id', v.account_id)
    put('currency', v.currency)
    put('campaign', v.campaign)
    put('campaign_id', v.campaign_id)
    if (level !== 'campaign') {
      put('ad_group', v.ad_group)
      put('ad_group_id', v.ad_group_id)
    }
    if (level === 'ad') {
      put('ad', v.ad ?? v.headline_1 ?? v.title)
      put('ad_id', v.ad_id)
    }
    if (level === 'keyword' || (level === 'search_term' && v.keyword !== undefined)) {
      const kw = splitGoogleKeyword(v.keyword ?? '', v.match_type)
      if (kw.text !== '') {
        r.keyword = kw.text
        if (level === 'keyword') r.match = kw.match
      }
    }
    if (level === 'search_term') put('search_term', v.search_term)
    const budget =
      level === 'campaign'
        ? parseExportNumber(v.budget)
        : level === 'ad_group'
          ? parseExportNumber(v.ad_group_daily_budget ?? v.budget)
          : undefined
    put('budget', budget)
    out.push(r)
  }
  return out
}

/** 一行代表的那个对象（不含日期）：同一对象不同天的行键相同。编号优先，没有编号用名字。 */
export function adsRowKey(row: AdsReportRow): string {
  return [
    row.level,
    row.campaign_id ?? row.campaign ?? '',
    row.level === 'campaign' ? '' : (row.ad_group_id ?? row.ad_group ?? ''),
    row.level === 'ad' ? (row.ad_id ?? row.ad ?? '') : '',
    row.level === 'keyword' ? `${row.keyword ?? ''}|${row.match ?? ''}` : '',
    row.level === 'search_term' ? (row.search_term ?? '') : '',
  ].join('\u0000')
}

/** 几行加起来（缺的不补 0：一行都没有这一格就还是没有）；ROAS 用合计重算。 */
export function sumAdsMetrics(rows: readonly { metrics: AdsMetrics }[]): AdsMetrics {
  const out: AdsMetrics = {}
  for (const r of rows)
    for (const k of METRIC_FIELDS) {
      const n = r.metrics[k]
      if (n !== undefined) out[k] = Math.round(((out[k] ?? 0) + n) * 100) / 100
    }
  const roas = roasOf(out)
  if (roas !== undefined) out.roas = roas
  return out
}

/**
 * 往上加一层（Meta 的报表一行就是一条广告：要看广告系列 / 广告组就把同一天的广告加起来）。
 * 只在「广告系列 ← 广告组 ← 广告」这一条线上加；关键词与搜索字词加起来不等于广告系列（还有别的流量），不加。
 * 加出来的行没有状态与预算（表里那一格属于更细的那一层）。
 */
export function rollUpAdsRows(
  rows: readonly AdsReportRow[],
  to: 'campaign' | 'ad_group',
): AdsReportRow[] {
  const from = rows.filter((r) => r.level === 'ad' || (to === 'campaign' && r.level === 'ad_group'))
  const groups = new Map<string, AdsReportRow[]>()
  for (const r of from) {
    const lifted: AdsReportRow = { ...r, level: to }
    const key = `${r.day ?? ''}\u0001${adsRowKey(lifted)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: AdsReportRow[] = []
  for (const list of groups.values()) {
    const first = list[0] as AdsReportRow
    const r: AdsReportRow = { level: to, status: 'unknown', metrics: sumAdsMetrics(list) }
    if (r.metrics.roas !== undefined) r.roas_from = 'computed'
    for (const k of [
      'day',
      'account',
      'account_id',
      'currency',
      'campaign',
      'campaign_id',
    ] as const)
      if (first[k] !== undefined) r[k] = first[k]
    if (to === 'ad_group') {
      if (first.ad_group !== undefined) r.ad_group = first.ad_group
      if (first.ad_group_id !== undefined) r.ad_group_id = first.ad_group_id
    }
    out.push(r)
  }
  return out
}
