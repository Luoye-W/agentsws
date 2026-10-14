/**
 * 解析两家后台的导出文件（docs/101 §5.1① 看数据、§5.1② 第 1 步改前快照与第 7 步读回核对）。
 *
 * 认的是**导出文件本身**，不是页面上的数（决策 560：只点官方导出按钮，不抓页面）。
 *
 * 处理的几件事：
 * - 分隔符（逗号 / 制表符）与 BOM；字节进来的先用 `decodeExportBytes` 解。
 * - Google 报表文件开头常有一两行标题 / 日期范围，结尾有「Total: …」合计行：
 *   按「这一行能认出几个已知列名」找表头，合计行丢掉。
 * - Meta 导出里以 `+ - = @` 开头的值前面有 `< >`（官方：不是错，别删）：解析时去掉，
 *   还原成原文（[导出广告](https://www.facebook.com/business/help/849477685213347)）。
 * - 列名不分大小写、不管空格和标点，按别名表归到统一的字段名。
 *
 * 别名表里的**报表指标列**（花费、展示、点击…）是两家常见写法，没逐列核实到官方页；
 * 认不出的列原样留在 `raw` 里，不丢。
 */

import { parseDelimited } from './csv.js'
import { META_FORMULA_PREFIX } from './meta-columns.js'
import type { SheetPlatform } from './types.js'

/** 统一的字段名。 */
export type ExportField =
  | 'campaign'
  | 'campaign_id'
  | 'campaign_status'
  | 'campaign_type'
  | 'campaign_objective'
  | 'budget'
  | 'ad_group'
  | 'ad_group_id'
  | 'ad_group_status'
  | 'ad_group_daily_budget'
  | 'ad_group_lifetime_budget'
  | 'ad'
  | 'ad_id'
  | 'ad_status'
  | 'keyword'
  | 'match_type'
  | 'status'
  | 'final_url'
  | 'headline_1'
  | 'title'
  | 'body'
  | 'search_term'
  | 'day'
  | 'currency'
  | 'cost'
  | 'impressions'
  | 'clicks'
  | 'conversions'
  | 'conversion_value'

/** 别名（比较前都先归一：小写、去掉空格与标点）。 */
const ALIASES: Record<ExportField, readonly string[]> = {
  campaign: ['Campaign', 'Campaign Name', 'Campaign name'],
  campaign_id: ['Campaign ID'],
  campaign_status: ['Campaign status', 'Campaign state', 'Campaign Status'],
  campaign_type: ['Campaign type', 'Campaign Type'],
  campaign_objective: ['Campaign Objective'],
  budget: ['Budget', 'Campaign daily budget', 'Daily budget'],
  ad_group: ['Ad group', 'Ad Group', 'Ad Set Name', 'Ad set name', 'Ad group name'],
  ad_group_id: ['Ad group ID', 'Ad Set ID'],
  ad_group_status: [
    'Ad group status',
    'Ad group state',
    'Ad Group Status',
    'Ad Set Status',
    'Ad Set Run Status',
  ],
  ad_group_daily_budget: ['Ad Set Daily Budget', 'Ad set budget'],
  ad_group_lifetime_budget: ['Ad Set Lifetime Budget'],
  ad: ['Ad Name', 'Ad name'],
  ad_id: ['Ad ID'],
  ad_status: ['Ad status', 'Ad state', 'Ad Status'],
  keyword: ['Keyword', 'Search keyword', 'Keyword text'],
  match_type: ['Match type', 'Criterion Type', 'Search keyword match type'],
  status: ['Status', 'Keyword status', 'Keyword state'],
  final_url: ['Final URL', 'Final URLs', 'Link', 'Website URL'],
  headline_1: ['Headline 1'],
  title: ['Title'],
  body: ['Body'],
  search_term: ['Search term'],
  day: ['Day', 'Date', 'Reporting starts'],
  currency: ['Currency code', 'Currency'],
  cost: ['Cost', 'Amount spent', 'Spend'],
  impressions: ['Impr.', 'Impressions'],
  clicks: ['Clicks', 'Link clicks', 'Clicks (all)'],
  conversions: ['Conversions', 'Conv.', 'Results', 'Purchases'],
  conversion_value: [
    'Conv. value',
    'Conversion value',
    'Conversions value',
    'Purchases conversion value',
    'Purchase conversion value',
  ],
}

const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '')

const ALIAS_INDEX: ReadonlyMap<string, ExportField> = (() => {
  const m = new Map<string, ExportField>()
  for (const [field, list] of Object.entries(ALIASES) as [ExportField, readonly string[]][])
    for (const a of list) if (!m.has(norm(a))) m.set(norm(a), field)
  return m
})()

/**
 * 一个表头归到哪个字段。带货币后缀的（Meta「Amount spent (USD)」）去掉括号再认。
 */
export function exportFieldOf(header: string): ExportField | undefined {
  const direct = ALIAS_INDEX.get(norm(header))
  if (direct !== undefined) return direct
  return ALIAS_INDEX.get(norm(header.replace(/\(.*?\)/g, '')))
}

/** 去掉 Meta 导出加的 `< >` 前缀（只在后面跟着 `+ - = @` 时去）。 */
export function stripMetaFormulaPrefix(value: string): string {
  const p = META_FORMULA_PREFIX
  if (!value.startsWith(p)) return value
  const rest = value.slice(p.length).replace(/^ /, '')
  return /^[+\-=@]/.test(rest) ? rest : value
}

/**
 * 报表里的数：去千分位、货币符号、百分号；`--` / 空 → `undefined`（不是 0——
 * 「没数」和「0」在止损那里是两回事，见 budget.ts 文件头第 3 条）。
 */
export function parseExportNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const t = value.trim()
  if (t === '' || t === '--' || t === '-' || t === '—') return undefined
  const cleaned = t.replace(/[,\s%]/g, '').replace(/^[^\d\-.]+/, '')
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return undefined
  return Number(cleaned)
}

export interface ParsedExportRow {
  /** 原表头 → 原值（去过 `< >` 前缀）。认不出的列也在这里。 */
  raw: Record<string, string>
  /** 认出来的字段。 */
  values: Partial<Record<ExportField, string>>
}

export interface ParsedAdsExport {
  /** 按列名猜的；猜不出是 `unknown`。 */
  platform: SheetPlatform | 'unknown'
  headers: string[]
  /** 与 `headers` 一一对应：这一列认成了哪个字段。 */
  fields: (ExportField | undefined)[]
  rows: ParsedExportRow[]
  /** 丢掉了什么（照实说，不静默）。 */
  skipped: { title_lines: number; total_rows: number }
}

const KNOWN_MIN = 2

function guessPlatform(headers: readonly string[]): SheetPlatform | 'unknown' {
  const h = headers.map(norm)
  if (h.some((x) => x.startsWith('adset') || x.startsWith('amountspent') || x === 'linkobjectid'))
    return 'meta'
  if (h.some((x) => x === 'adgroup' || x === 'impr' || x === 'campaignstate' || x === 'adgroupid'))
    return 'google'
  return 'unknown'
}

const isTotalRow = (cells: readonly string[]): boolean =>
  cells.some((c, i) => i < 3 && /^\s*total\b/i.test(c))

/**
 * 解析一份导出（CSV / 制表符文字，Meta「导出为文字」也是它）。
 * 认不出表头（前 10 行里没有一行能认出 2 个已知列）就回空表，`platform: 'unknown'`。
 */
export function parseAdsExport(
  text: string,
  options: { platform?: SheetPlatform } = {},
): ParsedAdsExport {
  const grid = parseDelimited(text)
  let headerAt = -1
  for (let i = 0; i < Math.min(grid.length, 10); i += 1) {
    const known = (grid[i] ?? []).filter((c) => exportFieldOf(c) !== undefined).length
    if (known >= KNOWN_MIN) {
      headerAt = i
      break
    }
  }
  if (headerAt < 0)
    return {
      platform: options.platform ?? 'unknown',
      headers: [],
      fields: [],
      rows: [],
      skipped: { title_lines: grid.length, total_rows: 0 },
    }
  const headers = (grid[headerAt] ?? []).map((h) => h.trim())
  const fields = headers.map(exportFieldOf)
  const rows: ParsedExportRow[] = []
  let totals = 0
  for (const cells of grid.slice(headerAt + 1)) {
    if (isTotalRow(cells)) {
      totals += 1
      continue
    }
    const raw: Record<string, string> = {}
    const values: Partial<Record<ExportField, string>> = {}
    headers.forEach((h, i) => {
      const v = stripMetaFormulaPrefix((cells[i] ?? '').trim())
      raw[h] = v
      const f = fields[i]
      if (f !== undefined && v !== '' && values[f] === undefined) values[f] = v
    })
    rows.push({ raw, values })
  }
  return {
    platform: options.platform ?? guessPlatform(headers),
    headers,
    fields,
    rows,
    skipped: { title_lines: headerAt, total_rows: totals },
  }
}

/** 状态归一（两家的写法五花八门：Enabled / ACTIVE / Paused / Campaign paused / Removed / DELETED…）。 */
export type EntityStatus = 'enabled' | 'paused' | 'removed' | 'unknown'

export function normalizeStatus(value: string | undefined): EntityStatus {
  if (value === undefined || value.trim() === '') return 'unknown'
  const v = value.toLowerCase()
  if (/pause|inactive|off\b/.test(v)) return 'paused'
  if (/remov|delet|archiv/.test(v)) return 'removed'
  if (/enabl|active|eligible|\bon\b|running/.test(v)) return 'enabled'
  return 'unknown'
}

/** 一行导出代表的那个对象（读回核对、看数据用）。 */
export interface ExportEntity {
  level: 'campaign' | 'ad_group' | 'ad' | 'keyword'
  campaign?: string
  campaign_id?: string
  ad_group?: string
  ad_group_id?: string
  ad?: string
  ad_id?: string
  keyword?: string
  match?: 'broad' | 'phrase' | 'exact'
  /** 这一层自己的状态。 */
  status: EntityStatus
  /** Google：广告系列日预算；Meta：广告组日预算。 */
  budget?: number
  final_url?: string
  headline_1?: string
  metrics: {
    cost?: number
    impressions?: number
    clicks?: number
    conversions?: number
    conversion_value?: number
  }
}

/** 关键词列里的匹配符号拆出来：`[x]` 完全、`"x"` 词组、其余广泛（或看 Match type 列）。 */
export function splitGoogleKeyword(
  text: string,
  matchColumn?: string,
): { text: string; match: 'broad' | 'phrase' | 'exact' } {
  const t = text.trim()
  if (/^\[.*\]$/.test(t)) return { text: t.slice(1, -1).trim(), match: 'exact' }
  if (/^".*"$/.test(t)) return { text: t.slice(1, -1).trim(), match: 'phrase' }
  const m = (matchColumn ?? '').toLowerCase()
  return {
    text: t,
    match: m.includes('exact') ? 'exact' : m.includes('phrase') ? 'phrase' : 'broad',
  }
}

/** 把解析好的每一行认成一个对象（层级按「最细的那一格有没有值」定）。 */
export function exportEntities(parsed: ParsedAdsExport): ExportEntity[] {
  return parsed.rows.map((row) => {
    const v = row.values
    const level: ExportEntity['level'] =
      v.keyword !== undefined
        ? 'keyword'
        : v.ad_id !== undefined || v.ad !== undefined || v.headline_1 !== undefined
          ? 'ad'
          : v.ad_group !== undefined || v.ad_group_id !== undefined
            ? 'ad_group'
            : 'campaign'
    const ownStatus =
      level === 'campaign'
        ? (v.campaign_status ?? v.status)
        : level === 'ad_group'
          ? (v.ad_group_status ?? v.status)
          : level === 'ad'
            ? (v.ad_status ?? v.status)
            : v.status
    const budget =
      parseExportNumber(v.ad_group_daily_budget) ??
      (level === 'campaign' || parsed.platform === 'google'
        ? parseExportNumber(v.budget)
        : undefined)
    const metrics: ExportEntity['metrics'] = {}
    for (const k of ['cost', 'impressions', 'clicks', 'conversions', 'conversion_value'] as const) {
      const n = parseExportNumber(v[k])
      if (n !== undefined) metrics[k] = n
    }
    const kw = v.keyword === undefined ? undefined : splitGoogleKeyword(v.keyword, v.match_type)
    const e: ExportEntity = { level, status: normalizeStatus(ownStatus), metrics }
    const copy = {
      campaign: v.campaign,
      campaign_id: v.campaign_id,
      ad_group: v.ad_group,
      ad_group_id: v.ad_group_id,
      ad: v.ad,
      ad_id: v.ad_id,
      final_url: v.final_url,
      headline_1: v.headline_1 ?? v.title,
    }
    for (const [k, val] of Object.entries(copy))
      if (val !== undefined) (e as unknown as Record<string, string>)[k] = val
    if (kw !== undefined) {
      e.keyword = kw.text
      e.match = kw.match
    }
    if (budget !== undefined) e.budget = budget
    return e
  })
}
