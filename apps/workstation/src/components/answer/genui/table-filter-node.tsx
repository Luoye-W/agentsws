/**
 * WP401（决策 1090）：AI 用 genui 画的表**自动带筛选**——宿主在插件画之前把每一张 `table` 包进一个 `ws-table`，
 * 这一块在表上面放一个小漏斗（每列怎么筛看数据：一串字搜、几种取值勾、日期选起止；全是数的列不筛），
 * 筛完把剩下的行交回插件照原样画（排序、合计、导出、展开明细都还是插件的）。
 *
 * 与面板积木表格用同一份筛法（`lib/table-filter.ts`）与同一套控件（`design/table-filter.tsx`）。
 * 筛法按表格记在本机：表上写了 `id` 用它，没写按列名 + 行内容算指纹（同一张表刷新还认得，别的表不串）。
 * 不到 3 行的表不出漏斗。
 */
import { type ReactNode, useMemo } from 'react'
import { FilteredLine, TableFilterMenu, useTableFilters } from '@/components/design/table-filter'
import {
  activeFilterCount,
  type FilterCell,
  filterColumns,
  matchesRow,
  tableFingerprint,
} from '@/lib/table-filter'
import type { HostGenuiProps } from './primitives-shim'

export const TABLE_HOST_TYPE = 'ws-table'
/** 少于这么多行的表不出漏斗。 */
export const FILTER_MIN_ROWS = 3
/** 这几种格子画成图（条 / 环 / 小折线 / 序号），不拿来筛。 */
const VISUAL_TYPES = new Set(['index', 'spark', 'bar', 'ring'])

type Cell = string | number
interface TableLike {
  type: 'table'
  id?: string
  columns: string[]
  rows: Cell[][]
  types?: string[]
  details?: unknown[]
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
const isTable = (x: Record<string, unknown>): boolean =>
  x.type === 'table' && Array.isArray(x.columns) && Array.isArray(x.rows)

/** 插件校验过的描述 → 每一张表外面包一层 `ws-table`（明细里的表也包；已经包过的不再包）。 */
export function wrapGenuiTables<T>(spec: T): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk)
    if (!isObj(x)) return x
    if (x.type === TABLE_HOST_TYPE) return x
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x)) copy[k] = walk(v)
    return isTable(copy) ? { type: TABLE_HOST_TYPE, table: copy } : copy
  }
  return walk(spec) as T
}

/** 分组表（`types[0] === 'group'`）里的组头：第一格有字、别的格全空。 */
const isGroupHeader = (row: Cell[], types: readonly string[] | undefined): boolean =>
  types?.[0] === 'group' &&
  String(row[0] ?? '') !== '' &&
  row.slice(1).every((c) => String(c ?? '') === '')

export function TableFilterNode({ node, renderChildren }: HostGenuiProps): ReactNode {
  const table = (isObj(node.table) ? node.table : undefined) as TableLike | undefined
  const columns = table?.columns ?? []
  const rows = table?.rows ?? []
  const types = table?.types
  const tableId = useMemo(
    () =>
      table === undefined
        ? undefined
        : `genui.${typeof table.id === 'string' && table.id !== '' ? table.id : tableFingerprint(columns, rows)}`,
    [table, columns, rows],
  )
  const { state, setColumn, clear } = useTableFilters(tableId)
  const dataRows = useMemo(() => rows.filter((r) => !isGroupHeader(r, types)), [rows, types])
  const cols = useMemo(
    () =>
      filterColumns(
        columns.map((label, i) => ({
          key: String(i),
          label,
          ...(VISUAL_TYPES.has(types?.[i] ?? '') ? { filter: false as const } : {}),
        })),
        dataRows,
        (r, k): FilterCell => r[Number(k)],
        'auto',
      ),
    [columns, dataRows, types],
  )
  const filtering = activeFilterCount(cols, state) > 0
  const shown = useMemo(() => {
    if (table === undefined || !filtering) return table
    // 逐行判；组头只在它下面还有留下的行时才留
    const keep = rows.map((r) =>
      isGroupHeader(r, types) ? false : matchesRow(cols, state, (k) => r[Number(k)]),
    )
    for (let i = rows.length - 1, childKept = false; i >= 0; i -= 1) {
      const r = rows[i] as Cell[]
      if (isGroupHeader(r, types)) {
        keep[i] = childKept
        childKept = false
      } else if (keep[i] === true) childKept = true
    }
    const out: TableLike = { ...table, rows: rows.filter((_r, i) => keep[i]) }
    if (Array.isArray(table.details)) out.details = table.details.filter((_d, i) => keep[i])
    return out
  }, [table, filtering, rows, types, cols, state])
  if (table === undefined || shown === undefined) return null
  const body = renderChildren([shown], '0') as ReactNode
  if (cols.length === 0 || dataRows.length < FILTER_MIN_ROWS) return body
  const shownCount = shown.rows.filter((r) => !isGroupHeader(r, types)).length
  return (
    <div className="flex flex-col" data-testid="genui-table-filter">
      <div className="-mb-1 flex justify-end">
        <TableFilterMenu cols={cols} state={state} onChange={setColumn} onClear={clear} />
      </div>
      {body}
      {filtering ? (
        <FilteredLine shown={shownCount} total={dataRows.length} onClear={clear} />
      ) : null}
    </div>
  )
}
