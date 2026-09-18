/**
 * 服务端分页 / 排序的表（TanStack Table 只做列定义与渲染，数据是后端给的那一页）。
 *
 * **关掉它所有的客户端模型**：`manualPagination` / `manualSorting` / `manualFiltering`。
 * 两个旧后台都踩过同一个坑——表上看着有排序箭头，点下去只排了当前这一页的
 * 五十行，而用户以为自己看到了全表最大的那几笔。
 *
 * 分页状态在 URL 里（`useTableState`），所以"把这一页发给同事"是可行的。
 */

import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/utils'
import { Empty, Spinner, WsCard } from './design'

export interface TableState {
  limit: number
  offset: number
  sort: string | undefined
  order: 'asc' | 'desc'
  q: string | undefined
  get(key: string): string | undefined
  set(patch: Record<string, string | number | undefined>): void
}

/**
 * URL 就是这一页的状态。
 *
 * 换筛选时**把 offset 归零**：留在第 7 页再换一个筛选，多半会落到一页空白上，
 * 而那看起来像"没有数据"。
 */
export function useTableState(defaults: { limit?: number } = {}): TableState {
  const [params, setParams] = useSearchParams()
  const limit = Number(params.get('limit') ?? defaults.limit ?? 25)
  const offset = Number(params.get('offset') ?? 0)
  return {
    limit: Number.isFinite(limit) ? limit : 25,
    offset: Number.isFinite(offset) ? offset : 0,
    sort: params.get('sort') ?? undefined,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    q: params.get('q') ?? undefined,
    get: (key) => params.get(key) ?? undefined,
    set(patch) {
      const next = new URLSearchParams(params)
      let resetOffset = false
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'offset') resetOffset = true
        if (value === undefined || value === '') next.delete(key)
        else next.set(key, String(value))
      }
      if (resetOffset && patch.offset === undefined) next.delete('offset')
      setParams(next, { replace: true })
    },
  }
}

export interface ServerTableProps<T> {
  columns: ColumnDef<T, unknown>[]
  rows: T[] | undefined
  total: number
  state: TableState
  loading: boolean
  /** 点一行开右侧抽屉（不做独立详情页——两个旧后台都是抽屉，理由是不丢上下文）。 */
  onRowClick?: (row: T) => void
  /** 哪几列能排（服务端支持的那几个 key）。 */
  sortable?: string[]
  rowKey: (row: T) => string
  selectedKey?: string | undefined
}

export function ServerTable<T>({
  columns,
  rows,
  total,
  state,
  loading,
  onRowClick,
  sortable = [],
  rowKey,
  selectedKey,
}: ServerTableProps<T>): React.ReactNode {
  const { t } = useApp()
  const table = useReactTable({
    data: rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  })

  const from = total === 0 ? 0 : state.offset + 1
  const to = Math.min(state.offset + state.limit, total)

  return (
    <WsCard className="overflow-hidden">
      <div className="max-h-[calc(100vh-280px)] overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const id = header.column.id
                  const can = sortable.includes(id)
                  const active = state.sort === id
                  return (
                    <th key={header.id} className="ws-th">
                      {can ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-ws-ink"
                          onClick={() => {
                            state.set({
                              sort: id,
                              order: active && state.order === 'desc' ? 'asc' : 'desc',
                            })
                          }}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {active &&
                            (state.order === 'desc' ? (
                              <ChevronDown className="size-3" aria-hidden />
                            ) : (
                              <ChevronUp className="size-3" aria-hidden />
                            ))}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-testid="row"
                className={cn(
                  'ws-tr',
                  onRowClick !== undefined && 'cursor-pointer',
                  selectedKey !== undefined && rowKey(row.original) === selectedKey && 'bg-ws-tint',
                )}
                onClick={() => onRowClick?.(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="ws-td">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <Spinner label={t('loading')} />}
        {!loading && (rows?.length ?? 0) === 0 && <Empty label={t('empty')} />}
      </div>
      <div className="flex items-center justify-between gap-3 border-ws-line border-t px-3 py-2">
        <span className="ws-num text-xs text-ws-muted-fg">{t('page.of', { from, to, total })}</span>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg bg-ws-surface px-2.5 py-1 text-xs text-ws-ink disabled:opacity-40"
            disabled={state.offset <= 0}
            onClick={() => {
              state.set({ offset: Math.max(0, state.offset - state.limit) })
            }}
          >
            {t('page.prev')}
          </button>
          <button
            type="button"
            className="rounded-lg bg-ws-surface px-2.5 py-1 text-xs text-ws-ink disabled:opacity-40"
            disabled={state.offset + state.limit >= total}
            onClick={() => {
              state.set({ offset: state.offset + state.limit })
            }}
          >
            {t('page.next')}
          </button>
        </div>
      </div>
    </WsCard>
  )
}
