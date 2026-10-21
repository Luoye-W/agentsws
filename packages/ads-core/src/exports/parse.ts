/**
 * WP447（docs/109 §6.2）：读六个新平台**官方导出**的报表 → 按天的表现行（与 Google / Meta 那份同一个形状
 * `AdsReportRow`，进同一个看数据的库）。
 *
 * 列名对照全在 `columns.ts`（数据），这里只管文件的样子：
 * - 表头之前的说明行（Microsoft 有「Report Name: …」「Report Time: …」「Time Zone: …」几行）：读出日期范围、
 *   时区、币种，不当数据；
 * - 表尾的版权行（Microsoft「©2026 Microsoft Corporation. All rights reserved.」）与合计行：丢掉，照实记几行；
 * - 币种：有「Currency」列用列；没有看表头后缀「Spend (USD)」；再没有看说明行；都没有就是没有（卡上说「没写币种」）；
 * - 时区：说明行写了用说明行；没写用那家官方说的默认（LinkedIn = UTC）；都没有就是没有；
 * - ROAS：Microsoft 是百分数（官方：收入 ÷ 花费，以百分数表示），带 `%` 的一律 ÷ 100；
 * - 没有名字列的（只按天的账户合计）：记成一条「账户合计」，不丢。
 *
 * 纯函数、零依赖、不碰磁盘：.xlsx 由宿主先读成格子（`parsePlatformExportGrid`），CSV / TSV 直接给文字。
 */

import { parseDelimited } from '../sheets/csv.js'
import type { ExportField, ParsedAdsExport, ParsedExportRow } from '../sheets/parse.js'
import {
  type AdsReportLevel,
  type AdsReportRow,
  adsReportRows,
  parseExportDay,
} from '../sheets/report.js'
import { EXPORT_FORMATS, EXPORT_PLATFORMS, type ExportPlatform } from './columns.js'

/** 没有名字列的账户合计行，记在这个名字下（不是哪一条真的广告系列）。 */
export const ACCOUNT_TOTAL_CAMPAIGN = '（账户合计）'

export interface PlatformExport {
  platform: ExportPlatform | 'unknown'
  /** 平台是怎么认出来的。 */
  detected_by?: 'given' | 'columns' | 'file_name'
  rows: AdsReportRow[]
  level?: AdsReportLevel
  currency?: string
  timezone?: string
  /** 这份表覆盖的日期（本地日期 `YYYY-MM-DD`）。 */
  since?: string
  until?: string
  /** 表里有没有按天拆。 */
  by_day: boolean
  /** 认出来了、但官方页没写这一列叫什么、是按通用写法认的那几列（原表头）。 */
  unverified_columns: string[]
  /** 一列都没认出来的原表头（原样留在行里，不丢）。 */
  unknown_columns: string[]
  skipped: { title_lines: number; total_rows: number; footer_rows: number }
  /** 认不出时的一句人话（有它就没有行）。 */
  problem?: string
}

/** 归一：小写、只留字母数字与中文。 */
const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9㐀-鿿]/g, '')
/** 去掉表头里的括号后缀（「Spend (USD)」→「Spend」）。 */
const bare = (h: string): string => h.replace(/[(（][^)）]*[)）]/g, '').trim()

interface FieldHit {
  field: ExportField
  /** 在这个字段的别名表里排第几（越小越优先）。 */
  rank: number
  verified: boolean
}

/** 一家的别名索引：归一后的列名 → 字段。 */
function aliasIndex(platform: ExportPlatform): Map<string, FieldHit> {
  const m = new Map<string, FieldHit>()
  const cols = EXPORT_FORMATS[platform].columns
  for (const [field, col] of Object.entries(cols) as [ExportField, (typeof cols)[ExportField]][]) {
    if (col === undefined) continue
    const list = [
      ...(col.verified ?? []).map((n) => ({ n, verified: true })),
      ...(col.generic ?? []).map((n) => ({ n, verified: false })),
    ]
    list.forEach(({ n, verified }, rank) => {
      const k = norm(n)
      if (!m.has(k)) m.set(k, { field, rank, verified })
    })
  }
  return m
}

const INDEX: Readonly<Record<ExportPlatform, Map<string, FieldHit>>> = Object.fromEntries(
  EXPORT_PLATFORMS.map((p) => [p, aliasIndex(p)]),
) as Record<ExportPlatform, Map<string, FieldHit>>

function hitOf(platform: ExportPlatform, header: string): FieldHit | undefined {
  const idx = INDEX[platform]
  return idx.get(norm(header)) ?? idx.get(norm(bare(header)))
}

/** 一行像不像表头：能认出至少两列。 */
function headerScore(platform: ExportPlatform, cells: readonly string[]): number {
  return new Set(cells.map((c) => hitOf(platform, c)?.field).filter((f) => f !== undefined)).size
}

const MAX_HEADER_SEARCH = 20

function findHeader(grid: readonly (readonly string[])[], platforms: readonly ExportPlatform[]) {
  for (let i = 0; i < Math.min(grid.length, MAX_HEADER_SEARCH); i += 1) {
    const cells = grid[i] ?? []
    if (platforms.some((p) => headerScore(p, cells) >= 2)) return i
  }
  return -1
}

/**
 * 认是哪一家：表头里出现几个这家**官方核过**的特征列 + 文件名里的词。只有一家最高分才算认出来，
 * 打平或零分回 `undefined`（不猜——卡上会说「认不出是哪一家」，请人在那条职责里拖）。
 */
export function detectExportPlatform(
  headers: readonly string[],
  fileName = '',
  /** 表头之外的字（说明行、版权行），小写不小写都行。 */
  otherText = '',
): { platform: ExportPlatform; by: 'columns' | 'file_name' } | undefined {
  const hs = new Set(headers.map((h) => norm(bare(h))))
  const name = fileName.toLowerCase()
  const text = otherText.toLowerCase()
  const scores = EXPORT_PLATFORMS.map((p) => {
    const f = EXPORT_FORMATS[p]
    const cols =
      new Set(f.signature_headers.map((s) => norm(bare(s))).filter((s) => hs.has(s))).size +
      ((f.text_hints ?? []).some((w) => text.includes(w)) ? 1 : 0)
    const file = f.file_name_hints.some((w) => name.includes(w)) ? 1 : 0
    return { p, cols, file, total: cols * 2 + file }
  })
  const best = Math.max(...scores.map((s) => s.total))
  if (best <= 0) return undefined
  const top = scores.filter((s) => s.total === best)
  if (top.length !== 1) return undefined
  const one = top[0] as (typeof scores)[number]
  return { platform: one.p, by: one.cols > 0 ? 'columns' : 'file_name' }
}

const DATE_TOKEN =
  /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3}[a-z]*\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3}[a-z]*\.? \d{4}/g

/** 一段字里的日期（按出现顺序）。 */
function datesIn(text: string): string[] {
  return [...text.matchAll(DATE_TOKEN)]
    .map((m) => parseExportDay(m[0]))
    .filter((d): d is string => d !== undefined)
}

interface Meta {
  since?: string
  until?: string
  timezone?: string
  currency?: string
}

/** 表头之前那几行说明。 */
function readMeta(lines: readonly (readonly string[])[]): Meta {
  const out: Meta = {}
  for (const cells of lines) {
    const line = cells.filter((c) => c.trim() !== '').join(', ')
    const tz = /time ?zone\s*[:：]\s*(.+)$/i.exec(line)
    if (tz !== null && out.timezone === undefined) out.timezone = (tz[1] ?? '').trim()
    const cur = /currency(?: code)?\s*[:：]\s*([A-Z]{3})\b/i.exec(line)
    if (cur !== null && out.currency === undefined) out.currency = (cur[1] ?? '').toUpperCase()
    if (
      /report time|date range|reporting (?:period|range)|time range|日期范围|报告时间/i.test(line)
    ) {
      const ds = datesIn(line)
      if (ds.length > 0 && out.since === undefined) {
        out.since = ds[0] as string
        out.until = ds[ds.length - 1] as string
      }
    }
  }
  return out
}

const isFooter = (cells: readonly string[]): boolean =>
  cells.some((c, i) => i < 2 && /^\s*(©|@\d{4}|\(c\)\s*\d{4})|all rights reserved/i.test(c))
const isTotal = (cells: readonly string[]): boolean =>
  cells.some((c, i) => i < 3 && /^\s*(total|totals|grand total|总计|合计)\b/i.test(c))

/** .xlsx 里的日期常是 Excel 序号（1899-12-30 起的天数）：认成 `YYYY-MM-DD`；不像序号的原样回。 */
export function excelSerialDay(value: string): string {
  const t = value.trim()
  if (!/^\d{5}(\.\d+)?$/.test(t)) return value
  const n = Math.floor(Number(t))
  if (n < 30000 || n > 80000) return value
  return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10)
}

/** ROAS 一格：带 `%` 的、或这家官方说是百分数的，÷ 100。 */
function roasCell(value: string, percent: boolean): string {
  const t = value.trim()
  const n = Number(t.replace(/[,\s%]/g, ''))
  if (t === '' || Number.isNaN(n)) return value
  return percent || t.endsWith('%') ? String(Math.round(n * 100) / 10000) : value
}

/**
 * 读一份已经拆成格子的导出（CSV 拆好的、.xlsx 读出来的都行）。
 * `platform` 给了就按它认（在 `ads.pinterest` 那条职责里拖进来的就是 Pinterest），不给按列名 + 文件名猜。
 */
export function parsePlatformExportGrid(
  grid: readonly (readonly string[])[],
  options: { platform?: ExportPlatform; fileName?: string } = {},
): PlatformExport {
  const empty = (
    problem: string,
    platform: PlatformExport['platform'] = 'unknown',
  ): PlatformExport => ({
    platform,
    rows: [],
    by_day: false,
    unverified_columns: [],
    unknown_columns: [],
    skipped: { title_lines: 0, total_rows: 0, footer_rows: 0 },
    problem,
  })
  const rows = grid.map((r) => r.map((c) => String(c ?? '')))
  const headerAt = findHeader(
    rows,
    options.platform === undefined ? EXPORT_PLATFORMS : [options.platform],
  )
  if (headerAt < 0) return empty('认不出这张表的表头，没入库。', options.platform)
  const headers = (rows[headerAt] ?? []).map((h) => h.trim())
  let platform: ExportPlatform
  let detected_by: PlatformExport['detected_by']
  if (options.platform !== undefined) {
    platform = options.platform
    detected_by = 'given'
  } else {
    const around = [...rows.slice(0, headerAt), ...rows.slice(-3)]
      .map((r) => r.join(' '))
      .join('\n')
    const d = detectExportPlatform(headers, options.fileName, around)
    if (d === undefined)
      return empty('认不出是哪一家的报表，没入库。在那个平台的职责里拖进来就认得。')
    platform = d.platform
    detected_by = d.by
  }
  const format = EXPORT_FORMATS[platform]

  // 每个字段只认一列：别名表里排得最前的那一列（Apple「Installs (Total)」优先于「Installs (Tap-Through)」）
  const hits = headers.map((h) => hitOf(platform, h))
  const chosen = new Map<ExportField, number>()
  hits.forEach((hit, i) => {
    if (hit === undefined) return
    const prev = chosen.get(hit.field)
    if (prev === undefined || (hits[prev] as FieldHit).rank > hit.rank) chosen.set(hit.field, i)
  })
  const fields: (ExportField | undefined)[] = headers.map((_, i) => {
    const hit = hits[i]
    return hit !== undefined && chosen.get(hit.field) === i ? hit.field : undefined
  })
  const unverified_columns = headers.filter(
    (_, i) => fields[i] !== undefined && hits[i]?.verified === false,
  )
  const unknown_columns = headers.filter((h, i) => fields[i] === undefined && h !== '')

  const meta = readMeta(rows.slice(0, headerAt))
  const costHeader = headers[fields.indexOf('cost')]
  const suffixCurrency = /\(([A-Z]{3})\)/.exec(costHeader ?? '')?.[1]

  let totals = 0
  let footers = 0
  const parsedRows: ParsedExportRow[] = []
  for (const cells of rows.slice(headerAt + 1)) {
    if (isFooter(cells)) {
      footers += 1
      continue
    }
    if (isTotal(cells)) {
      totals += 1
      continue
    }
    const raw: Record<string, string> = {}
    const values: Partial<Record<ExportField, string>> = {}
    headers.forEach((h, i) => {
      const val = (cells[i] ?? '').trim()
      raw[h] = val
      const f = fields[i]
      if (f === undefined || val === '') return
      values[f] =
        f === 'roas'
          ? roasCell(val, format.roas_is_percent === true)
          : f === 'day' || f === 'day_end'
            ? excelSerialDay(val)
            : val
    })
    parsedRows.push({ raw, values })
  }

  // 没有任何名字列（只按天的账户合计）：记成「账户合计」一条，不丢
  const named: ExportField[] = ['campaign', 'campaign_id', 'ad_group', 'ad_group_id', 'ad', 'ad_id']
  const noNames = !named.some((f) => fields.includes(f))
  const finalFields = noNames ? [...fields, 'campaign' as const] : fields
  if (noNames)
    for (const r of parsedRows)
      if (Object.keys(r.values).length > 0) r.values.campaign = ACCOUNT_TOTAL_CAMPAIGN

  const parsed: ParsedAdsExport = {
    platform: 'unknown',
    headers: noNames ? [...headers, ACCOUNT_TOTAL_CAMPAIGN] : headers,
    fields: finalFields,
    rows: parsedRows,
    skipped: { title_lines: headerAt, total_rows: totals },
  }
  const out = adsReportRows(parsed)
  if (out.length === 0) return { ...empty('这张表一行数据都没有，没入库。', platform), detected_by }

  const currency =
    out.find((r) => r.currency !== undefined)?.currency ?? suffixCurrency ?? meta.currency
  if (currency !== undefined)
    for (const r of out) if (r.currency === undefined) r.currency = currency
  const days = out
    .map((r) => r.day)
    .filter((d): d is string => d !== undefined)
    .sort()
  const by_day = days.length > 0
  const since = by_day ? days[0] : meta.since
  const until = by_day ? days[days.length - 1] : meta.until
  const timezone = meta.timezone ?? format.default_timezone
  return {
    platform,
    detected_by,
    rows: out,
    level: (out[0] as AdsReportRow).level,
    ...(currency === undefined ? {} : { currency }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    by_day,
    unverified_columns,
    unknown_columns,
    skipped: { title_lines: headerAt, total_rows: totals, footer_rows: footers },
  }
}

/** 读一份 CSV / TSV 文字（字节先过 `decodeExportBytes`）。 */
export function parsePlatformExport(
  text: string,
  options: { platform?: ExportPlatform; fileName?: string } = {},
): PlatformExport {
  return parsePlatformExportGrid(parseDelimited(text), options)
}
