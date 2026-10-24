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
  // WP315（决策 619）：看数据要的几列
  | 'roas'
  | 'day_end'
  | 'account'
  | 'account_id'
  // WP452：素材疲劳要看的「频次」（Meta 等广告那一层的导出有；没有这一列就不判频次）
  | 'frequency'

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
    'Website purchases conversion value',
  ],
  roas: [
    'Conv. value / cost',
    'ROAS',
    'Purchase ROAS (return on ad spend)',
    'Purchase ROAS',
    'Website purchase ROAS (return on advertising spend)',
  ],
  day_end: ['Reporting ends'],
  account: ['Account', 'Account name'],
  account_id: ['Customer ID', 'Account ID'],
  frequency: ['Frequency'],
}

/**
 * WP315（决策 619）：后台是中文界面时导出的表头（两家都按界面语言出）。**没对真导出核过**——
 * 照两家中文帮助页与界面常见叫法写；认不出的列照样留在 `raw` 里。真站首跑拿真导出补。
 */
const ALIASES_ZH: Partial<Record<ExportField, readonly string[]>> = {
  campaign: ['广告系列', '广告系列名称'],
  campaign_id: ['广告系列 ID', '广告系列编号'],
  campaign_status: ['广告系列状态', '广告系列投放状态'],
  campaign_type: ['广告系列类型'],
  budget: ['预算', '广告系列预算', '日预算'],
  ad_group: ['广告组', '广告组名称'],
  ad_group_id: ['广告组 ID', '广告组编号'],
  ad_group_status: ['广告组状态', '广告组投放状态'],
  ad_group_daily_budget: ['广告组日预算'],
  ad: ['广告名称'],
  ad_id: ['广告 ID', '广告编号'],
  ad_status: ['广告状态', '广告投放状态'],
  keyword: ['关键字', '搜索关键字', '关键词'],
  match_type: ['匹配类型', '关键字匹配类型', '搜索字词匹配类型'],
  status: ['状态'],
  search_term: ['搜索字词'],
  day: ['天', '日', '日期', '报告开始日期'],
  day_end: ['报告结束日期'],
  currency: ['货币代码', '货币'],
  cost: ['费用', '花费', '已花费金额', '花费金额'],
  impressions: ['展示次数'],
  clicks: ['点击次数', '点击量（全部）', '链接点击量'],
  conversions: ['转化次数', '转化', '成效', '购物次数'],
  conversion_value: ['转化价值', '购物转化价值'],
  roas: ['转化价值/费用', '购物广告花费回报', '广告花费回报'],
  account: ['账号', '账户', '账户名称'],
  account_id: ['客户 ID', '账户编号'],
  frequency: ['频次'],
}

/** 归一：小写、只留字母数字（WP315：中日韩字也留，中文表头才认得出）。 */
const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '')

const ALIAS_INDEX: ReadonlyMap<string, ExportField> = (() => {
  const m = new Map<string, ExportField>()
  for (const table of [ALIASES, ALIASES_ZH])
    for (const [field, list] of Object.entries(table) as [ExportField, readonly string[]][])
      for (const a of list) if (!m.has(norm(a))) m.set(norm(a), field)
  return m
})()

/**
 * 一个表头归到哪个字段。带货币后缀的（Meta「Amount spent (USD)」）去掉括号再认。
 */
export function exportFieldOf(header: string): ExportField | undefined {
  const direct = ALIAS_INDEX.get(norm(header))
  if (direct !== undefined) return direct
  return ALIAS_INDEX.get(norm(header.replace(/[(（].*?[)）]/g, '')))
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
  if (
    h.some(
      (x) =>
        x.startsWith('adset') ||
        x.startsWith('amountspent') ||
        x === 'linkobjectid' ||
        x.startsWith('已花费金额') ||
        x === '成效' ||
        x === '报告开始日期',
    )
  )
    return 'meta'
  if (
    h.some(
      (x) =>
        x === 'adgroup' ||
        x === 'impr' ||
        x === 'campaignstate' ||
        x === 'adgroupid' ||
        x === 'searchterm' ||
        x === '费用' ||
        x === '搜索字词',
    )
  )
    return 'google'
  return 'unknown'
}

const isTotalRow = (cells: readonly string[]): boolean =>
  cells.some((c, i) => i < 3 && /^\s*(total\b|总计|合计)/i.test(c))

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
  if (/pause|inactive|off\b|暂停|已停|关闭/.test(v)) return 'paused'
  if (/remov|delet|archiv|移除|删除|归档/.test(v)) return 'removed'
  if (/enabl|active|eligible|\bon\b|running|启用|投放中|有效|开启/.test(v)) return 'enabled'
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
    match:
      m.includes('exact') || m.includes('完全')
        ? 'exact'
        : m.includes('phrase') || m.includes('词组')
          ? 'phrase'
          : 'broad',
  }
}

/**
 * 把解析好的行认成对象。Meta 的导出一行同时带着广告系列、广告组、广告三层，
 * 所以**一行可以拆出好几个对象**（每层一个，按编号或名字去重）；各层用各自的状态列。
 * 花费等指标只记在这一行最细的那一层上（记在每一层就重复算了）。
 */
export function exportEntities(parsed: ParsedAdsExport): ExportEntity[] {
  const out: ExportEntity[] = []
  const seen = new Map<string, ExportEntity>()
  for (const row of parsed.rows) {
    const v = row.values
    const has: Record<ExportEntity['level'], boolean> = {
      campaign: v.campaign !== undefined || v.campaign_id !== undefined,
      ad_group: v.ad_group !== undefined || v.ad_group_id !== undefined,
      ad: v.ad_id !== undefined || v.ad !== undefined || v.headline_1 !== undefined,
      keyword: v.keyword !== undefined,
    }
    const levels = (['campaign', 'ad_group', 'ad', 'keyword'] as const).filter((l) => has[l])
    const finest = levels[levels.length - 1]
    const metrics: ExportEntity['metrics'] = {}
    for (const k of ['cost', 'impressions', 'clicks', 'conversions', 'conversion_value'] as const) {
      const n = parseExportNumber(v[k])
      if (n !== undefined) metrics[k] = n
    }
    const kw = v.keyword === undefined ? undefined : splitGoogleKeyword(v.keyword, v.match_type)
    for (const level of levels) {
      const own =
        level === 'campaign'
          ? v.campaign_status
          : level === 'ad_group'
            ? v.ad_group_status
            : level === 'ad'
              ? v.ad_status
              : undefined
      const status = normalizeStatus(own ?? (level === finest ? v.status : undefined))
      const e: ExportEntity = { level, status, metrics: level === finest ? metrics : {} }
      const put = (k: keyof ExportEntity, val: string | undefined): void => {
        if (val !== undefined) (e as unknown as Record<string, string>)[k] = val
      }
      put('campaign', v.campaign)
      put('campaign_id', v.campaign_id)
      if (level !== 'campaign') {
        put('ad_group', v.ad_group)
        put('ad_group_id', v.ad_group_id)
      }
      if (level === 'ad') {
        put('ad', v.ad)
        put('ad_id', v.ad_id)
        put('final_url', v.final_url)
        put('headline_1', v.headline_1 ?? v.title)
      }
      if (level === 'keyword' && kw !== undefined) {
        e.keyword = kw.text
        e.match = kw.match
      }
      const budget =
        level === 'campaign'
          ? parseExportNumber(v.budget)
          : level === 'ad_group'
            ? parseExportNumber(v.ad_group_daily_budget)
            : undefined
      if (budget !== undefined) e.budget = budget
      const key = [
        level,
        e.campaign_id ?? e.campaign,
        e.ad_group_id ?? e.ad_group,
        e.ad_id ?? e.ad ?? e.headline_1,
        e.keyword,
        e.match,
      ].join('\u0000')
      const prev = seen.get(key)
      if (prev === undefined) {
        seen.set(key, e)
        out.push(e)
      } else if (level === finest) {
        // 同一个对象出现在多行（按天拆的报表）：指标累加
        for (const [k, n] of Object.entries(metrics) as [keyof ExportEntity['metrics'], number][])
          prev.metrics[k] = (prev.metrics[k] ?? 0) + n
      }
    }
  }
  return out
}
