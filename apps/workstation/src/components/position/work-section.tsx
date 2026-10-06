/**
 * WP241 岗位页「工作」（docs/54 §7）：**AI 在做什么、做到哪**——不放决定按钮。
 *
 * Notion Database 那样一条视图栏：列表（默认）/ 看板 / 日历 / 表格，后面是这个岗位职责
 * 自带的快捷视图；工具栏：筛选（职责 / 状态 / 截止 / 来源）、分组、排序、选列、加待办。
 * 选了什么记在这个岗位上（本机，`lib/position-work.ts` 的 `saveWorkPrefs`）。
 *
 * 数据只有一份：`GET /v1/positions/:id/work`。筛选 / 分组 / 排序是看法，不另取数。
 */
import {
  POSITION_WORK_GROUPS,
  POSITION_WORK_SOURCES,
  type PositionWorkGroup,
  type PositionWorkSource,
} from '@agentsws/contracts'
import {
  ArrowUpDown,
  CalendarDays,
  Columns3,
  Filter,
  KanbanSquare,
  List,
  Rows3,
  Table2,
} from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import type { PositionWorkData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  ALL_COLUMNS,
  activeFilterCount,
  BASE_VIEWS,
  type BaseView,
  DUE_FILTERS,
  filterItems,
  GROUP_BYS,
  NO_FILTERS,
  type QuickView,
  quickLabelNeedsDuty,
  SORT_BYS,
  sortItems,
  type WorkPrefs,
} from '@/lib/position-work'
import { QuickViewPanel, quickLabel } from './quick-views'
import { Pop, PopOption } from './work-bits'
import { WorkBoard } from './work-board'
import { WorkCalendar } from './work-calendar'
import { AddTodo, WorkList } from './work-list'
import { WorkTable } from './work-table'

const VIEW_ICON: Record<BaseView, typeof List> = {
  list: List,
  board: KanbanSquare,
  calendar: CalendarDays,
  table: Table2,
}

const toggle = <T,>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

export function WorkSection({
  data,
  pending,
  error,
  quickViews,
  prefs,
  onPrefs,
  onJump,
  onRefresh,
  now: nowProp,
}: {
  data: PositionWorkData | undefined
  pending: boolean
  error: Error | null
  quickViews: readonly QuickView[]
  prefs: WorkPrefs
  onPrefs(next: WorkPrefs): void
  onJump(card_id: string): void
  onRefresh(): void
  /** 「今天 / 过期」按哪一刻算；不给就用这份工作出来的那一刻（服务端时钟，测试里也稳） */
  now?: Date
}): ReactNode {
  const { t } = useApp()
  const now = useMemo(
    () => nowProp ?? (data === undefined ? new Date() : new Date(data.generated_at)),
    [nowProp, data],
  )
  const quick = quickViews.find((q) => q.id === prefs.view)
  const view: BaseView | 'quick' =
    quick !== undefined
      ? 'quick'
      : (BASE_VIEWS as readonly string[]).includes(prefs.view)
        ? (prefs.view as BaseView)
        : 'list'
  const set = (patch: Partial<WorkPrefs>): void => {
    onPrefs({ ...prefs, ...patch })
  }
  const setFilters = (patch: Partial<WorkPrefs['filters']>): void => {
    set({ filters: { ...prefs.filters, ...patch } })
  }
  const items = useMemo(
    () => sortItems(filterItems(data?.items ?? [], prefs.filters, now), prefs.sort),
    [data, prefs.filters, prefs.sort, now],
  )
  const filterCount = activeFilterCount(prefs.filters)
  const total = data?.items.length ?? 0

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="work-section"
      data-view={quick?.id ?? view}
    >
      <div className="flex items-center gap-2">
        <h3 className="ws-display text-[17px]">{t('pos2.work.title')}</h3>
        {data === undefined ? null : (
          <span className="ws-num text-xs text-ws-muted-fg" data-testid="work-count">
            {t('pos2.work.count', { n: total })}
          </span>
        )}
        <Hint text={t('pos2.work.hint')} testId="work-hint" />
      </div>

      {/* 视图栏：四种基本视图，后面是职责快捷视图（#74：发帖排期排最前） */}
      <div
        className="flex flex-wrap items-center gap-1 border-b pb-1.5"
        role="tablist"
        aria-label={t('pos2.views')}
      >
        {BASE_VIEWS.map((v) => {
          const Icon = VIEW_ICON[v]
          const on = view === v
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`work-view-${v}`}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] ${on ? 'bg-card font-medium shadow-xs' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => {
                set({ view: v })
              }}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(`pos2.view.${v}`)}
            </button>
          )
        })}
        {quickViews.length === 0 ? null : <span className="mx-1 h-4 w-px bg-border" aria-hidden />}
        {quickViews.map((q) => {
          const on = quick?.id === q.id
          return (
            <button
              key={q.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid="work-quick"
              data-quick={q.id}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] ${on ? 'bg-card font-medium shadow-xs' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => {
                set({ view: q.id })
              }}
            >
              {quickLabel(t, q, quickLabelNeedsDuty(quickViews, q))}
            </button>
          )
        })}
      </div>

      {view === 'quick' || data === undefined ? null : (
        <div className="flex flex-wrap items-center justify-end gap-1" data-testid="work-toolbar">
          <Pop
            label={
              filterCount === 0 ? t('pos2.filter') : t('pos2.filter.active', { n: filterCount })
            }
            icon={<Filter className="size-3.5" aria-hidden />}
            testId="work-filter"
            active={filterCount > 0}
          >
            <div className="flex flex-col gap-2">
              {data.duties.length > 1 ? (
                <fieldset>
                  <legend className="px-2 text-[11px] text-ws-muted-fg">
                    {t('pos2.filter.duty')}
                  </legend>
                  {data.duties.map((d) => (
                    <PopOption
                      key={d.role_id}
                      testId="work-filter-duty"
                      selected={prefs.filters.duty.includes(d.role_id)}
                      onClick={() => {
                        setFilters({ duty: toggle(prefs.filters.duty, d.role_id) })
                      }}
                    >
                      {d.role_name}
                    </PopOption>
                  ))}
                </fieldset>
              ) : null}
              <fieldset>
                <legend className="px-2 text-[11px] text-ws-muted-fg">
                  {t('pos2.filter.group')}
                </legend>
                {POSITION_WORK_GROUPS.map((g) => (
                  <PopOption
                    key={g}
                    testId={`work-filter-group-${g}`}
                    selected={prefs.filters.group.includes(g)}
                    onClick={() => {
                      setFilters({ group: toggle<PositionWorkGroup>(prefs.filters.group, g) })
                    }}
                  >
                    {t(`pos2.group.${g}`)}
                  </PopOption>
                ))}
              </fieldset>
              <fieldset>
                <legend className="px-2 text-[11px] text-ws-muted-fg">
                  {t('pos2.filter.due')}
                </legend>
                {DUE_FILTERS.map((d) => (
                  <PopOption
                    key={d}
                    testId={`work-filter-due-${d}`}
                    selected={prefs.filters.due === d}
                    onClick={() => {
                      setFilters({ due: d })
                    }}
                  >
                    {t(`pos2.due.${d}`)}
                  </PopOption>
                ))}
              </fieldset>
              <fieldset>
                <legend className="px-2 text-[11px] text-ws-muted-fg">
                  {t('pos2.filter.source')}
                </legend>
                {POSITION_WORK_SOURCES.map((s) => (
                  <PopOption
                    key={s}
                    testId={`work-filter-source-${s}`}
                    selected={prefs.filters.source.includes(s)}
                    onClick={() => {
                      setFilters({ source: toggle<PositionWorkSource>(prefs.filters.source, s) })
                    }}
                  >
                    {t(`pos2.source.${s}`)}
                  </PopOption>
                ))}
              </fieldset>
              {filterCount === 0 ? null : (
                <button
                  type="button"
                  data-testid="work-filter-clear"
                  className="rounded-md px-2 py-1 text-left text-xs text-ws-brand hover:bg-accent"
                  onClick={() => {
                    set({ filters: NO_FILTERS })
                  }}
                >
                  {t('pos2.filter.clear')}
                </button>
              )}
            </div>
          </Pop>
          {view === 'list' ? (
            <Pop
              label={t(`pos2.groupby.${prefs.groupBy}`)}
              icon={<Rows3 className="size-3.5" aria-hidden />}
              testId="work-groupby"
            >
              {GROUP_BYS.map((g) => (
                <PopOption
                  key={g}
                  testId={`work-groupby-${g}`}
                  selected={prefs.groupBy === g}
                  onClick={() => {
                    set({ groupBy: g })
                  }}
                >
                  {t(`pos2.groupby.${g}`)}
                </PopOption>
              ))}
            </Pop>
          ) : null}
          {view === 'calendar' ? null : (
            <Pop
              label={t(`pos2.sort.${prefs.sort}`)}
              icon={<ArrowUpDown className="size-3.5" aria-hidden />}
              testId="work-sort"
            >
              {SORT_BYS.map((s) => (
                <PopOption
                  key={s}
                  testId={`work-sort-${s}`}
                  selected={prefs.sort === s}
                  onClick={() => {
                    set({ sort: s })
                  }}
                >
                  {t(`pos2.sort.${s}`)}
                </PopOption>
              ))}
            </Pop>
          )}
          {view === 'table' ? (
            <Pop
              label={t('pos2.columns')}
              icon={<Columns3 className="size-3.5" aria-hidden />}
              testId="work-columns"
            >
              {ALL_COLUMNS.map((c) => (
                <PopOption
                  key={c}
                  testId={`work-column-${c}`}
                  selected={prefs.columns.includes(c)}
                  onClick={() => {
                    const next = toggle(prefs.columns, c)
                    // 保持固定的列序（按 ALL_COLUMNS），不按点的先后
                    set({ columns: ALL_COLUMNS.filter((x) => next.includes(x)) })
                  }}
                >
                  {t(`pos2.col.${c}`)}
                </PopOption>
              ))}
            </Pop>
          ) : null}
          <AddTodo duties={data.duties} onAdded={onRefresh} compact />
        </div>
      )}

      {quick !== undefined ? (
        <QuickViewPanel view={quick} />
      ) : pending ? (
        <Skeleton className="h-48 w-full" />
      ) : error !== null || data === undefined ? (
        <p role="alert" className="text-sm text-muted-foreground" data-testid="work-error">
          {t('pos2.work.error', { message: error?.message ?? '—' })}
        </p>
      ) : total === 0 ? (
        <WorkEmpty data={data} onRefresh={onRefresh} />
      ) : items.length === 0 ? (
        <p
          className="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground"
          data-testid="work-no-match"
        >
          {t('pos2.work.no_match')}
        </p>
      ) : view === 'board' ? (
        <WorkBoard items={items} now={now} onJump={onJump} onMoved={onRefresh} />
      ) : view === 'calendar' ? (
        <WorkCalendar
          items={items}
          mode={prefs.calendar}
          now={now}
          onMode={(calendar) => {
            set({ calendar })
          }}
        />
      ) : view === 'table' ? (
        <WorkTable
          items={items}
          columns={prefs.columns}
          now={now}
          onJump={onJump}
          onSortTitle={() => {
            set({ sort: prefs.sort === 'title' ? 'due' : 'title' })
          }}
        />
      ) : (
        <WorkList
          items={items}
          groupBy={prefs.groupBy}
          data={data}
          now={now}
          onJump={onJump}
          onAdded={onRefresh}
        />
      )}
    </section>
  )
}

/** 一件都还没有：三行灰条示意 + 一句话 + 加一个待办（`position-v2-empty.html`）。 */
function WorkEmpty({ data, onRefresh }: { data: PositionWorkData; onRefresh(): void }): ReactNode {
  const { t } = useApp()
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl border bg-card px-4 py-8 text-center"
      data-testid="work-empty"
    >
      <div className="flex w-full max-w-sm flex-col gap-2" aria-hidden>
        <span className="h-2.5 rounded-full bg-ws-surface" />
        <span className="h-2.5 w-3/4 rounded-full bg-ws-surface" />
        <span className="h-2.5 w-4/5 rounded-full bg-ws-surface" />
      </div>
      <p className="text-sm text-muted-foreground">{t('pos2.work.empty')}</p>
      <AddTodo duties={data.duties} onAdded={onRefresh} compact />
    </div>
  )
}
