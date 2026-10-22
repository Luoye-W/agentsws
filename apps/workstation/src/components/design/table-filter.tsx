/**
 * WP401（决策 1090）：积木表格的筛选控件——表头一个小漏斗，点开才出选项（界面少字）。
 *
 * - `ColumnFilter`：表头那一格的漏斗（面板积木表格用）；
 * - `TableFilterMenu`：一张表一个漏斗、点开每列一段（AI 用 genui 画的表用——表头是插件画的，伸不进去）；
 * - `FilteredLine`：在筛的时候表下一行「3 / 10 行 · 清空」；
 * - `useTableFilters`：筛法按表格 id 记在本机（`lib/table-filter.ts`）。
 *
 * 弹层走 Radix Popover（挂到 body 上）：表格外面那层横向滚动会把绝对定位的弹层裁掉。
 */
import { Check, Filter } from 'lucide-react'
import { Popover } from 'radix-ui'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '@/lib/app-context'
import {
  type ColumnFilterValue,
  type FilterColumn,
  isColumnActive,
  readTableFilters,
  SELECT_SEARCH_AT,
  type TableFilterState,
  writeTableFilters,
} from '@/lib/table-filter'

type Display = (key: string, value: string) => string
const same: Display = (_k, v) => v

/** 一张表的筛法：有 id 就从本机读、改了就写回去；没 id 只在这一屏里记着。 */
export function useTableFilters(tableId: string | undefined): {
  state: TableFilterState
  setColumn(key: string, value: ColumnFilterValue | undefined): void
  clear(): void
} {
  const [state, setState] = useState<TableFilterState>(() =>
    tableId === undefined ? {} : readTableFilters(tableId),
  )
  const [loadedFor, setLoadedFor] = useState(tableId)
  if (loadedFor !== tableId) {
    setLoadedFor(tableId)
    setState(tableId === undefined ? {} : readTableFilters(tableId))
  }
  useEffect(() => {
    if (tableId !== undefined && loadedFor === tableId) writeTableFilters(tableId, state)
  }, [tableId, loadedFor, state])
  const setColumn = useCallback((key: string, value: ColumnFilterValue | undefined): void => {
    setState((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  }, [])
  const clear = useCallback((): void => setState({}), [])
  return { state, setColumn, clear }
}

const toggle = (list: readonly string[], v: string): string[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

const FIELD =
  'h-7 w-full rounded-md border border-ws-line bg-ws-card px-2 text-xs text-ws-ink outline-none focus-visible:border-ws-brand'

/** 一列的那一个控件（搜框 / 勾选列表 / 起止两个日子）。 */
function FilterControl({
  col,
  value,
  onChange,
  display,
}: {
  col: FilterColumn
  value: ColumnFilterValue | undefined
  onChange(v: ColumnFilterValue | undefined): void
  display: Display
}): ReactNode {
  const { t } = useApp()
  const [find, setFind] = useState('')
  if (col.kind === 'search')
    return (
      <input
        type="search"
        className={FIELD}
        data-testid={`table-filter-q-${col.key}`}
        aria-label={t('table.filter.col', { col: col.label })}
        placeholder={t('table.filter.search')}
        value={value?.q ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : { q: e.target.value })}
      />
    )
  if (col.kind === 'date')
    return (
      <div className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
        <input
          type="date"
          className={FIELD}
          data-testid={`table-filter-from-${col.key}`}
          aria-label={t('table.filter.from')}
          value={value?.from ?? ''}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
        <span aria-hidden>–</span>
        <input
          type="date"
          className={FIELD}
          data-testid={`table-filter-to-${col.key}`}
          aria-label={t('table.filter.to')}
          value={value?.to ?? ''}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </div>
    )
  const picked = value?.values ?? []
  const needle = find.trim().toLowerCase()
  const shown =
    needle === ''
      ? col.options
      : col.options.filter((o) => display(col.key, o).toLowerCase().includes(needle))
  return (
    <div className="flex flex-col gap-1">
      {col.options.length >= SELECT_SEARCH_AT ? (
        <input
          type="search"
          className={FIELD}
          aria-label={t('table.filter.find')}
          placeholder={t('table.filter.find')}
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      ) : null}
      <div className="flex max-h-56 flex-col overflow-y-auto">
        {shown.map((o) => {
          const on = picked.includes(o)
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              data-testid={`table-filter-opt-${col.key}`}
              data-value={o}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-ws-surface"
              onClick={() => {
                const next = toggle(picked, o)
                onChange(next.length === 0 ? undefined : { values: next })
              }}
            >
              <span
                className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-ws-line ${on ? 'border-ws-brand bg-ws-brand text-ws-brand-fg' : ''}`}
              >
                {on ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
              </span>
              <span className="truncate">
                {o === '' ? t('table.filter.empty') : display(col.key, o)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Funnel({ active, label, testId }: { active: boolean; label: string; testId: string }) {
  return (
    <Popover.Trigger asChild>
      <button
        type="button"
        aria-label={label}
        title={label}
        data-testid={testId}
        data-active={active ? 'true' : 'false'}
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-ws-surface ${active ? 'text-ws-brand' : 'text-ws-muted-fg/70 hover:text-ws-muted-fg'}`}
      >
        <Filter aria-hidden className="size-3" fill={active ? 'currentColor' : 'none'} />
      </button>
    </Popover.Trigger>
  )
}

const PANEL =
  'z-50 flex w-60 flex-col gap-2 rounded-[12px] border border-ws-line bg-ws-card p-2.5 text-ws-ink shadow-ws'

function ClearButton({ onClick, testId }: { onClick(): void; testId: string }): ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      data-testid={testId}
      className="self-end text-xs text-ws-muted-fg hover:text-ws-ink hover:underline"
      onClick={onClick}
    >
      {t('table.filter.clear')}
    </button>
  )
}

/** 表头那一格的漏斗。 */
export function ColumnFilter({
  col,
  value,
  onChange,
  display = same,
}: {
  col: FilterColumn
  value: ColumnFilterValue | undefined
  onChange(v: ColumnFilterValue | undefined): void
  display?: Display
}): ReactNode {
  const { t } = useApp()
  const active = isColumnActive(col, value)
  return (
    <Popover.Root>
      <Funnel
        active={active}
        label={t('table.filter.col', { col: col.label })}
        testId={`table-filter-${col.key}`}
      />
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={PANEL}
          data-testid={`table-filter-panel-${col.key}`}
        >
          <FilterControl col={col} value={value} onChange={onChange} display={display} />
          {active ? (
            <ClearButton
              testId={`table-filter-clear-${col.key}`}
              onClick={() => onChange(undefined)}
            />
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 一张表一个漏斗：点开每一列一段（AI 画的表用）。 */
export function TableFilterMenu({
  cols,
  state,
  onChange,
  onClear,
  display = same,
}: {
  cols: readonly FilterColumn[]
  state: TableFilterState
  onChange(key: string, v: ColumnFilterValue | undefined): void
  onClear(): void
  display?: Display
}): ReactNode {
  const { t } = useApp()
  const active = cols.some((c) => isColumnActive(c, state[c.key]))
  return (
    <Popover.Root>
      <Funnel active={active} label={t('table.filter')} testId="table-filter-menu" />
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className={`${PANEL} max-h-[70vh] overflow-y-auto`}
          data-testid="table-filter-menu-panel"
        >
          {cols.map((c) => (
            <fieldset key={c.key} className="flex flex-col gap-1">
              <legend className="mb-1 text-xs text-ws-muted-fg">{c.label}</legend>
              <FilterControl
                col={c}
                value={state[c.key]}
                onChange={(v) => onChange(c.key, v)}
                display={display}
              />
            </fieldset>
          ))}
          {active ? <ClearButton testId="table-filter-clear" onClick={onClear} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 在筛的时候表下那一行：「3 / 10 行 · 清空」；一行都没对上就说一声。 */
export function FilteredLine({
  shown,
  total,
  onClear,
}: {
  shown: number
  total: number
  onClear(): void
}): ReactNode {
  const { t } = useApp()
  return (
    <p
      className="flex items-center gap-1 pt-2 text-xs text-ws-muted-fg"
      data-testid="table-filtered"
    >
      {shown === 0 ? t('table.filter.none') : t('table.filter.shown', { shown, total })}
      {' · '}
      <button
        type="button"
        className="font-medium text-ws-brand hover:underline"
        data-testid="table-filtered-clear"
        onClick={onClear}
      >
        {t('table.filter.clear')}
      </button>
    </p>
  )
}
