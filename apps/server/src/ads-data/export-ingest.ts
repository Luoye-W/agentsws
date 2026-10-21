/**
 * WP447（docs/109 §6.2）：六个新平台（Microsoft / Pinterest / Reddit / LinkedIn / Snapchat / Apple）
 * 的报表——用户从平台后台点「导出」、把文件拖进对话——读成按天的表现行，进**同一个看数据的库**
 * （`ads-data.sqlite`，与插件每天导的 Google / Meta 同一张表）。
 *
 * 解析全用 `@agentsws/ads-core` 的 `parsePlatformExport*`（列名对照是数据）；.xlsx 先用
 * `@agentsws/knowledge` 的 `readSpreadsheet` 读成格子（带 zip 炸弹闸、行列上限，与 FAQ 导入同一份）。
 *
 * 卡上照写：币种、时区、日期范围——报表里没写的就说没写，不编。
 */
import {
  ACCOUNT_TOTAL_CAMPAIGN,
  adsRowKey,
  decodeExportBytes,
  type ExportPlatform,
  isExportPlatform,
  type PlatformExport,
  parsePlatformExport,
  parsePlatformExportGrid,
} from '@agentsws/ads-core'
import { adsPlatformSpec } from '@agentsws/contracts'
import { readSpreadsheet } from '@agentsws/knowledge'
import { ADS_EXPORT_MAX_BYTES, accountKey, localDayOf } from './ingest.js'
import type { AdsDataImport, AdsDataRow, AdsDataSource } from './store.js'

/** 这几种扩展名才当报表试一试（别的附件一概不碰）。 */
export const ADS_EXPORT_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'zip'] as const

const extOf = (name: string): string => {
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at + 1).toLowerCase()
}

/** 平台的界面名（`Pinterest 广告`）。 */
export const exportPlatformLabel = (p: ExportPlatform): string => adsPlatformSpec(p)?.zh ?? p

export interface ParseExportFileInput {
  id: string
  bytes: Uint8Array
  name: string
  /** 在哪条职责里拖进来的就是哪一家；不给按列名 + 文件名认。 */
  platform?: ExportPlatform
  source: AdsDataSource
  at: string
  tzOffsetMinutes: number
}

export type ParseExportFileResult =
  | {
      ok: true
      platform: ExportPlatform
      import: AdsDataImport
      rows: AdsDataRow[]
      parsed: PlatformExport
    }
  | { ok: false; message: string; platform?: ExportPlatform }

/** 一份文件 → 格子 / 文字 → 解析。认不出照实说。 */
export function parseExportFile(input: ParseExportFileInput): ParseExportFileResult {
  const ext = extOf(input.name)
  if (input.bytes.byteLength === 0) return { ok: false, message: '文件是空的。' }
  if (input.bytes.byteLength > ADS_EXPORT_MAX_BYTES)
    return { ok: false, message: '文件太大，不像一份报表导出。' }
  if (ext === 'zip')
    return {
      ok: false,
      message: '这是压缩包（Microsoft 广告下载的报表是 .zip）：先解压，把里面那份 .csv 拖进来。',
    }
  const opts = {
    fileName: input.name,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  }
  let parsed: PlatformExport
  if (ext === 'xlsx') {
    let grids: { rows: string[][] }[]
    try {
      grids = readSpreadsheet('xlsx', input.bytes)
    } catch {
      return { ok: false, message: '这份表格读不了（加了密，或者不是 .xlsx）。' }
    }
    const grid = grids.find((g) => g.rows.some((r) => r.some((c) => c.trim() !== '')))
    if (grid === undefined) return { ok: false, message: '这份表格是空的。' }
    parsed = parsePlatformExportGrid(grid.rows, opts)
  } else parsed = parsePlatformExport(decodeExportBytes(input.bytes), opts)

  if (parsed.problem !== undefined || parsed.platform === 'unknown')
    return {
      ok: false,
      message: parsed.problem ?? '认不出是哪一家的报表，没入库。',
      ...(parsed.platform === 'unknown' ? {} : { platform: parsed.platform }),
    }
  const platform = parsed.platform
  const fallbackDay = parsed.until ?? localDayOf(input.at, input.tzOffsetMinutes)
  const rows: AdsDataRow[] = parsed.rows.map((r) => ({
    ...r,
    platform,
    account: accountKey(r.account_id ?? r.account ?? 'default'),
    day: r.day ?? fallbackDay,
    key: adsRowKey(r),
    import_id: input.id,
  }))
  const notes: string[] = []
  if (parsed.skipped.total_rows > 0) notes.push(`跳过 ${parsed.skipped.total_rows} 行合计。`)
  if (!parsed.by_day)
    notes.push(
      parsed.since !== undefined && parsed.until !== undefined
        ? `表里没按天拆：这是 ${parsed.since} 到 ${parsed.until} 的合计，记在 ${fallbackDay}。`
        : `表里没按天拆，也没写日期范围，按 ${fallbackDay} 记。`,
    )
  if (parsed.unverified_columns.length > 0)
    notes.push(`这几列官方页没写叫什么，按通用写法认的：${parsed.unverified_columns.join('、')}。`)
  if (parsed.rows.some((r) => r.campaign === ACCOUNT_TOTAL_CAMPAIGN))
    notes.push('表里没有广告系列名，记成「账户合计」。')
  const accounts = [...new Set(rows.map((r) => r.account))]
  return {
    ok: true,
    platform,
    parsed,
    rows,
    import: {
      id: input.id,
      platform,
      account: accounts.length === 1 ? (accounts[0] as string) : 'default',
      source: input.source,
      name: input.name.split(/[\\/]/u).pop() ?? input.name,
      ...(parsed.level === undefined ? {} : { level: parsed.level }),
      rows: rows.length,
      days: [...new Set(rows.map((r) => r.day))].sort(),
      at: input.at,
      notes,
      ...(parsed.currency === undefined ? {} : { currency: parsed.currency }),
      ...(parsed.timezone === undefined ? {} : { timezone: parsed.timezone }),
      ...(parsed.since === undefined ? {} : { since: parsed.since }),
      ...(parsed.until === undefined ? {} : { until: parsed.until }),
      ...(parsed.by_day ? {} : { summary_only: true }),
    },
  }
}

/** 入库之后那一句（附件上、工具回的都是它）：几行、哪几天、币种、时区，没写的说没写。 */
export function exportImportNote(imp: AdsDataImport): string {
  const label = isExportPlatform(imp.platform) ? exportPlatformLabel(imp.platform) : imp.platform
  const range =
    imp.since !== undefined && imp.until !== undefined
      ? imp.since === imp.until
        ? imp.since
        : `${imp.since} 到 ${imp.until}`
      : '日期没写'
  return [
    `已入库：${label}的报表「${imp.name}」，${imp.rows} 行，${range}`,
    `币种 ${imp.currency ?? '没写'}`,
    `时区 ${imp.timezone ?? '没写'}`,
  ]
    .join('，')
    .concat('。', imp.notes.join(''))
}

/** 这个文件值不值得当报表试一试（扩展名）。 */
export function looksLikeAdsExport(name: string): boolean {
  return (ADS_EXPORT_EXTENSIONS as readonly string[]).includes(extOf(name))
}
