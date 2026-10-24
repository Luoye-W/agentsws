/**
 * WP509：飞书表格**截住复制**读回来的东西 → 表头（带列类型 / 单选项）+ 数据行。
 *
 * 和 WP493 `ego-read/sheet.ts` 的 `copiedGrid` 同一份来源（`text/plain` = TSV、`text/bitable` = HTML 转义过的 JSON 表头），
 * 区别是这里要**列类型与单选选项**（同步要知道哪一列是单选、哪一列是公式写不进），而且**空行不丢**——
 * 写的那一跳按行号走格子，丢一行就整张表错一行。
 *
 * - 多维表格（`/base/`）：TSV 不带表头，表头来自 `text/bitable`（字段名、类型、选项）。
 * - 电子表格（`/sheets/`）：没有 `text/bitable`，TSV 第一行就是表头，列一律当文字。
 */

import type { SyncTableColumn } from '@agentsws/kol-core'
import { unescapeEntities } from '../ego-read/sheet.js'

export type SyncTableKind = 'bitable' | 'sheet'

export interface SyncTable {
  kind: SyncTableKind
  columns: SyncTableColumn[]
  header: string[]
  /** 数据行（空行保留；每行补齐到列数）。 */
  rows: string[][]
}

/** 链接 → 哪种表（知识库 `/wiki/` 里的认不出，读回来再看有没有 `text/bitable`）。 */
export function syncKindOfUrl(raw: string): SyncTableKind | undefined {
  try {
    const u = new URL(raw.trim())
    if (/\/base\/[\w-]{6,}/u.test(u.pathname)) return 'bitable'
    if (/\/sheets\/[\w-]{6,}/u.test(u.pathname)) return 'sheet'
  } catch {
    // 认不出
  }
  return undefined
}

/** 飞书的一个链接是不是能同步的表（多维表格 / 电子表格 / 知识库里的表）。 */
export function isFeishuTableUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (!/(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/u.test(u.hostname))
      return false
    return /\/(base|sheets|wiki)\/[\w-]{6,}/u.test(u.pathname)
  } catch {
    return false
  }
}

/** TSV → 格子，**空行保留**（末尾那个换行不算一行）。Excel 同款引号。 */
export function parseTsvKeep(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const t = text.replace(/\r\n?/gu, '\n')
  let i = 0
  while (i < t.length) {
    const c = t[i] as string
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (c === '"') quoted = false
      else cell += c
      i += 1
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === '\t') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
    i += 1
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** 飞书多维表格字段类型（开放平台同一套编号；复制出来的表头里也是它）→ 我们的列类型。 */
export function bitableColumnType(raw: unknown): SyncTableColumn['type'] {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(n))
    switch (n) {
      case 1:
      case 13:
        return 'text'
      case 2:
        return 'number'
      case 3:
        return 'select'
      case 4:
        return 'multi_select'
      case 5:
        return 'date'
      case 7:
        return 'checkbox'
      case 15:
        return 'url'
      default:
        // 人员、附件、关联、查找引用、公式、创建时间 / 人、自动编号、地理位置、群组……粘不进去
        return 'readonly'
    }
  const s = String(raw ?? '').toLowerCase()
  if (s === '' || s === 'text' || s === 'phone') return 'text'
  if (s === 'number' || s === 'currency' || s === 'progress' || s === 'rating') return 'number'
  if (s === 'singleselect' || s === 'single_select' || s === 'select') return 'select'
  if (s === 'multiselect' || s === 'multi_select') return 'multi_select'
  if (s === 'datetime' || s === 'date') return 'date'
  if (s === 'checkbox') return 'checkbox'
  if (s === 'url') return 'url'
  return 'readonly'
}

interface BitableHeaderField {
  name?: unknown
  type?: unknown
  property?: { options?: { name?: unknown }[] } | null
}

/** `text/bitable` → 带类型 / 选项的表头（认不出 = undefined）。 */
export function bitableColumns(raw: string): SyncTableColumn[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(unescapeEntities(raw))
  } catch {
    return undefined
  }
  if (j === null || typeof j !== 'object') return undefined
  const o = j as Record<string, unknown>
  const fields = (
    Array.isArray(o.header) ? o.header : Array.isArray(o.fields) ? o.fields : []
  ) as BitableHeaderField[]
  if (fields.length === 0) return undefined
  return fields.map((f, i) => {
    const name = typeof f?.name === 'string' && f.name.trim() !== '' ? f.name : `列${i + 1}`
    const options = (f?.property?.options ?? [])
      .map((x) => x?.name)
      .filter((n): n is string => typeof n === 'string')
    const type = f?.type === undefined && options.length > 0 ? 'select' : bitableColumnType(f?.type)
    return { name, type, ...(options.length === 0 ? {} : { options }) }
  })
}

/** 截住的复制内容 → 一张表（读不出 = undefined）。`kind` 不给就看有没有 `text/bitable`。 */
export function syncTableOf(
  copied: readonly (readonly [string, string])[],
  kind?: SyncTableKind,
): SyncTable | undefined {
  const of = (re: RegExp) =>
    [...copied].reverse().find(([type, v]) => re.test(type) && v.trim() !== '')?.[1]
  const bit = of(/^text\/bitable/iu)
  // 全是空行的表复制出来只有制表符和换行：照样是一张表
  const plain = [...copied]
    .reverse()
    .find(([type, v]) => /^text\/plain/iu.test(type) && v !== '')?.[1]
  const cols = bit === undefined ? undefined : bitableColumns(bit)
  const grid = plain === undefined ? [] : parseTsvKeep(plain)
  const k: SyncTableKind = kind ?? (cols === undefined ? 'sheet' : 'bitable')
  if (k === 'bitable') {
    if (cols === undefined) return undefined
    const width = cols.length
    return {
      kind: k,
      columns: cols,
      header: cols.map((c) => c.name),
      rows: grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    }
  }
  const head = grid[0]
  if (head === undefined) return undefined
  let width = head.length
  while (width > 0 && (head[width - 1] ?? '').trim() === '') width -= 1
  if (width === 0) return undefined
  const header = head.slice(0, width).map((h, i) => (h.trim() === '' ? `列${i + 1}` : h.trim()))
  return {
    kind: k,
    columns: header.map((name) => ({ name, type: 'text' as const })),
    header,
    rows: grid.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
  }
}
