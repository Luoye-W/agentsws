/**
 * WP401（决策 1090）：积木表格的通用筛选——**纯函数**那一半（判这一列怎么筛、一行留不留、本机记住什么）。
 *
 * 面板上的积木表格（`blocks/block-view.tsx`）与 AI 用 genui 画的表（`answer/genui/table-filter-node.tsx`）
 * 用的是同一份：三种筛法——搜文字（不分大小写，原值与屏上那几个字都算）、下拉多选（按原值比、按屏上的字显示）、
 * 日期范围（按本机的日子，起止都含）。几列一起筛 = 都得对上。
 *
 * 本机只记「怎么筛」（列 key → 搜的字 / 勾的值 / 起止日子），按表格 id 一份；存不下也照常筛，只是刷新后回到不筛。
 */
import { readString, writeString } from './ui-state'

export type TableFilterKind = 'search' | 'select' | 'date'
export type FilterCell = string | number | boolean | null | undefined

/** 列声明里的那一格（`TableResult` 的 `filter`）：`true` = 看数据定。 */
export type FilterDeclaration = true | TableFilterKind | undefined

/** 一列能怎么筛（画漏斗用）。`options` 只有下拉多选才有：原值，按屏上的字排好。 */
export interface FilterColumn {
  key: string
  label: string
  kind: TableFilterKind
  options: string[]
}

/** 一列筛到哪儿了。 */
export interface ColumnFilterValue {
  q?: string
  values?: string[]
  from?: string
  to?: string
}

export type TableFilterState = Record<string, ColumnFilterValue>

/** 下拉多选最多几种取值算「枚举」（再多就是一串字，改成搜）。 */
export const SELECT_MAX_OPTIONS = 8
/** 下拉多选的取值超过这么多，弹层里多一个搜框。 */
export const SELECT_SEARCH_AT = 9

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u
const NUM_RE = /^[-+]?[\d,]*\.?\d+%?$/u

const text = (v: FilterCell): string => (v === null || v === undefined ? '' : String(v))
const pad = (n: number): string => String(n).padStart(2, '0')

/** 一格 → 本机的那一天（`YYYY-MM-DD`）；不是日期 → undefined。 */
export function dayOf(v: FilterCell): string | undefined {
  const s = text(v).trim()
  if (s === '' || !DATE_RE.test(s)) return undefined
  if (DAY_RE.test(s)) return s
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) return undefined
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 看一列的数据判怎么筛：全是数 → 不筛；八成以上是日期 → 日期范围；取值不超过 8 种而且有重复 → 下拉多选；
 * 别的（一串字）→ 搜文字。整列空 → 不筛。
 */
export function inferFilterKind(values: readonly FilterCell[]): TableFilterKind | undefined {
  const filled = values.map(text).filter((s) => s.trim() !== '')
  if (filled.length === 0) return undefined
  if (values.every((v) => typeof v === 'number' || NUM_RE.test(text(v).trim()) || text(v) === ''))
    return undefined
  const dates = filled.filter((s) => dayOf(s) !== undefined).length
  if (dates / filled.length >= 0.8) return 'date'
  const distinct = new Set(filled)
  const short = filled.every((s) => s.length <= 24)
  if (short && distinct.size <= SELECT_MAX_OPTIONS && distinct.size < filled.length) return 'select'
  return 'search'
}

/**
 * 一张表能筛的列。`declared` = 面板积木：只看列声明（不写 `filter` 的列不出漏斗）；
 * `auto` = AI 画的表：每一列都看数据定。`display` 把原值念成屏上的字（选项按它排、搜也搜它）。
 */
export function filterColumns<Row>(
  columns: readonly { key: string; label: string; filter?: FilterDeclaration | false }[],
  rows: readonly Row[],
  cell: (row: Row, key: string) => FilterCell,
  mode: 'declared' | 'auto',
  display: (key: string, value: string) => string = (_k, v) => v,
): FilterColumn[] {
  const out: FilterColumn[] = []
  for (const c of columns) {
    if (c.filter === false) continue
    if (mode === 'declared' && c.filter === undefined) continue
    const values = rows.map((r) => cell(r, c.key))
    const kind = c.filter === true || c.filter === undefined ? inferFilterKind(values) : c.filter
    if (kind === undefined) continue
    const options =
      kind === 'select'
        ? [...new Set(values.map(text))].sort((a, b) =>
            a === '' ? 1 : b === '' ? -1 : display(c.key, a).localeCompare(display(c.key, b)),
          )
        : []
    out.push({ key: c.key, label: c.label, kind, options })
  }
  return out
}

/** 这一列真在筛（搜的字非空 / 勾了还在的值 / 起止有一头）。 */
export function isColumnActive(col: FilterColumn, v: ColumnFilterValue | undefined): boolean {
  if (v === undefined) return false
  if (col.kind === 'search') return (v.q ?? '').trim() !== ''
  if (col.kind === 'select') return (v.values ?? []).some((x) => col.options.includes(x))
  return (v.from ?? '') !== '' || (v.to ?? '') !== ''
}

export function activeFilterCount(cols: readonly FilterColumn[], state: TableFilterState): number {
  return cols.filter((c) => isColumnActive(c, state[c.key])).length
}

/** 一行留不留：每一列在筛的都得对上。 */
export function matchesRow(
  cols: readonly FilterColumn[],
  state: TableFilterState,
  get: (key: string) => FilterCell,
  display: (key: string, value: string) => string = (_k, v) => v,
): boolean {
  for (const c of cols) {
    const v = state[c.key]
    if (!isColumnActive(c, v) || v === undefined) continue
    const raw = text(get(c.key))
    if (c.kind === 'search') {
      const needle = (v.q ?? '').trim().toLowerCase()
      if (!`${raw}\n${display(c.key, raw)}`.toLowerCase().includes(needle)) return false
    } else if (c.kind === 'select') {
      const picked = (v.values ?? []).filter((x) => c.options.includes(x))
      if (!picked.includes(raw)) return false
    } else {
      const day = dayOf(raw)
      if (day === undefined) return false
      if ((v.from ?? '') !== '' && day < (v.from as string)) return false
      if ((v.to ?? '') !== '' && day > (v.to as string)) return false
    }
  }
  return true
}

export function applyFilters<Row>(
  rows: readonly Row[],
  cols: readonly FilterColumn[],
  state: TableFilterState,
  cell: (row: Row, key: string) => FilterCell,
  display?: (key: string, value: string) => string,
): Row[] {
  if (activeFilterCount(cols, state) === 0) return [...rows]
  return rows.filter((r) => matchesRow(cols, state, (k) => cell(r, k), display))
}

// ── 本机记住 ────────────────────────────────────────────────────────────
export const TABLE_FILTER_KEY_PREFIX = 'agentsws.table_filter.'

const strings = (x: unknown): string[] | undefined =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)

/** 读一张表记住的筛法（存坏了 / 不是那个形状 → 当没筛）。 */
export function readTableFilters(tableId: string): TableFilterState {
  const raw = readString(TABLE_FILTER_KEY_PREFIX + tableId)
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: TableFilterState = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) continue
      const o = v as Record<string, unknown>
      const one: ColumnFilterValue = {}
      const q = str(o.q)
      const values = strings(o.values)
      const from = str(o.from)
      const to = str(o.to)
      if (q !== undefined) one.q = q
      if (values !== undefined) one.values = values
      if (from !== undefined && (from === '' || DAY_RE.test(from))) one.from = from
      if (to !== undefined && (to === '' || DAY_RE.test(to))) one.to = to
      out[k] = one
    }
    return out
  } catch {
    return {}
  }
}

/** 只留真有内容的列；一列都没有就记成空串（等于忘掉）。 */
export function compactFilters(state: TableFilterState): TableFilterState {
  const out: TableFilterState = {}
  for (const [k, v] of Object.entries(state)) {
    const one: ColumnFilterValue = {}
    if ((v.q ?? '') !== '') one.q = v.q as string
    if ((v.values ?? []).length > 0) one.values = v.values as string[]
    if ((v.from ?? '') !== '') one.from = v.from as string
    if ((v.to ?? '') !== '') one.to = v.to as string
    if (Object.keys(one).length > 0) out[k] = one
  }
  return out
}

export function writeTableFilters(tableId: string, state: TableFilterState): void {
  const compact = compactFilters(state)
  writeString(
    TABLE_FILTER_KEY_PREFIX + tableId,
    Object.keys(compact).length === 0 ? '' : JSON.stringify(compact),
  )
}

/** AI 画的表没有 id：按列名 + 行内容算一个短指纹（同一张表刷新后还认得，换一张表不串）。 */
export function tableFingerprint(columns: readonly string[], rows: readonly unknown[]): string {
  const src = `${columns.join('\u0001')}\u0002${JSON.stringify(rows)}`
  let h = 0x811c9dc5
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
