/**
 * 日历（37 C3 + §2.5）：**一个日历，多图层**。WP469（决策 1521）起它是「日历与待办」的**日历**那一面，
 * 地址 `/planner?view=calendar`（老地址 `/calendar` 自动转过来，`?layers=` / `?role=` 照旧认，决策 1526）。
 *
 * 1. 壳是 Schedule-X（`components/calendar/unified-calendar.tsx`），日 / 周 / 月 / 议程四个视图；
 * 2. 左边两张卡：「还没排期的」（WP469 换掉了小月历——要跳日子点标题「2026 年 10 月」）和「显示」（图层开关）；
 * 3. **从哪儿进来决定默认开哪几层**（`?layers=`）；「定时任务」默认关（决策 1527）；
 * 4. 待办分三档（决策 1522）：没日子在左边、有日子没钟点在那天「全天」、有钟点是时间格里一块；
 *    拖动就是换档；「帮我排进空档」只画虚线候选，人点「采用」才排上；
 * 5. 做完的待办划掉变淡仍显示（决策 1524），「显示」里有一个「做完的待办」开关。
 *
 * 图层、视图、做完的开不开都记在本机（`lib/ui-state`）：纯界面偏好，换台电脑重新勾一次没有任何损失。
 */
import type { CalendarItem, CalendarSource, Todo } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Plus,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalTodoHead } from '@/components/cal-todo/cal-todo-head'
import { UnscheduledRail } from '@/components/cal-todo/unscheduled-rail'
import { useOpenTodos, useTodoAct, useTodoRefresh } from '@/components/cal-todo/use-todos'
import { MiniMonth } from '@/components/calendar/mini-month'
import { UnifiedCalendar } from '@/components/calendar/unified-calendar'
import { Segmented } from '@/components/design/segmented'
import { Popover } from '@/components/messages/popover'
import { MeetDialog } from '@/components/secretary/meet-dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositions, listPeople, proposeTodoSlots, updateTodo } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  aiBusy,
  type DropTarget,
  dropPatch,
  type Ghost,
  loadShowDone,
  nextOption,
  saveShowDone,
  unscheduled,
} from '@/lib/cal-todo'
import {
  CALENDAR_VIEWS,
  type CalendarView,
  countByLayer,
  defaultLayersFor,
  LAYER_COLOR,
  LAYERS,
  loadLayers,
  loadView,
  parseLayers,
  saveLayers,
  saveView,
  toggleLayer,
} from '@/lib/calendar-layers'
import { countKey, monthTitle, visibleRange, withinRange } from '@/lib/calendar-view'
import { apiErrorText } from '@/lib/error-text'
import { addDays } from '@/lib/work'

/** 翻一页 = 翻多少天（议程跟月同档：它画的就是一个月）。 */
const PAGE_DAYS: Record<CalendarView, number> = { day: 1, week: 7, month: 30, agenda: 30 }

export function CalendarPage({ switcher }: { switcher?: ReactNode } = {}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [params] = useSearchParams()

  /**
   * 开哪几层：URL 上写了就听 URL（从岗位页 / 职责页跳进来的那一下），
   * 否则听上一次（本机存的那一份），再否则按 `role` 给一份默认。
   */
  const roleHint = params.get('role') ?? undefined
  const [layers, setLayers] = useState<CalendarSource[]>(
    () => parseLayers(params.get('layers')) ?? loadLayers() ?? defaultLayersFor(roleHint),
  )
  // WP419（自查 U6）：第一次直接进日历（URL 没写、本机也没记）——担着社媒职责就把「社媒排期」勾上
  const [firstVisit] = useState(
    () => parseLayers(params.get('layers')) === undefined && loadLayers() === undefined,
  )
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: getPositions,
    staleTime: 60_000,
    enabled: firstVisit && roleHint === undefined,
  })
  useEffect(() => {
    if (!firstVisit || roleHint !== undefined || positions.data === undefined) return
    const held = (positions.data.instances ?? []).flatMap((p) =>
      p.roles.filter((r) => r.my_assignment_id !== undefined).map((r) => r.role_id),
    )
    setLayers(defaultLayersFor(undefined, held))
  }, [firstVisit, roleHint, positions.data])
  const [view, setView] = useState<CalendarView>(() => loadView() ?? 'week')
  const [anchor, setAnchor] = useState(() => new Date())
  const [picking, setPicking] = useState(false)
  const [showDone, setShowDone] = useState(loadShowDone)
  // 41 §1.2：约别人 = 向对方的代理发一张卡，对方点头才进双方日历
  const [meeting, setMeeting] = useState(false)
  /** 取回来的全部项（窗口比这一屏宽）；数字只数这一屏画着的那一段 */
  const [fetched, setFetched] = useState<CalendarItem[]>([])
  const counts = useMemo(
    () => countByLayer(withinRange(fetched, visibleRange(view, anchor))),
    [fetched, view, anchor],
  )

  // URL 换了（在日历页上又点了一次别处过来的链接）就跟着换
  const urlLayers = params.get('layers')
  useEffect(() => {
    const next = parseLayers(urlLayers)
    if (next !== undefined) setLayers(next)
  }, [urlLayers])

  useEffect(() => {
    saveLayers(layers)
  }, [layers])
  useEffect(() => {
    saveView(view)
  }, [view])
  useEffect(() => {
    saveShowDone(showDone)
  }, [showDone])

  const people = useQuery({
    queryKey: ['secretary', 'people'],
    enabled: meeting,
    queryFn: listPeople,
  })

  /* ── 待办：三档、拖动换档、勾选框（WP469） ── */
  const open = useOpenTodos()
  const openTodos = useMemo(() => open.data?.todos ?? [], [open.data])
  const byId = useMemo(() => new Map(openTodos.map((x) => [x.id, x])), [openTodos])
  const [note, setNote] = useState<string | undefined>()
  const act = useTodoAct((e) => {
    setNote(apiErrorText(e, t))
  })
  const refresh = useTodoRefresh()
  const focus = params.get('focus') ?? undefined
  const [selected, setSelected] = useState<Set<string>>(() =>
    focus === undefined ? new Set() : new Set([focus]),
  )
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [unplaced, setUnplaced] = useState(0)

  /** 拖到哪儿了 → 换档（落回原处什么都不改）；AI 在做的那件不让挪。 */
  const onTodoDrop = (id: string, target: DropTarget): void => {
    const todo: Todo | undefined = byId.get(id)
    if (todo === undefined) return
    if (aiBusy(todo)) {
      setNote(t('caltodo.drop.ai'))
      return
    }
    const patch = dropPatch(todo, target)
    if (patch === undefined) return
    setNote(undefined)
    setGhosts((g) => g.filter((x) => x.todo_id !== id))
    act.mutate({ id, op: 'patch', patch })
  }

  const propose = useMutation({
    mutationFn: async (ids: string[]) => {
      const now = new Date()
      const week = visibleRange('week', view === 'week' || view === 'day' ? anchor : now)
      const thisWeek = week.to.getTime() > now.getTime() ? week : visibleRange('week', now)
      const from = new Date(Math.max(thisWeek.from.getTime(), now.getTime()))
      return proposeTodoSlots({
        todo_ids: ids,
        from: from.toISOString(),
        to: thisWeek.to.toISOString(),
        tz_offset_minutes: -now.getTimezoneOffset(),
      })
    },
    onSuccess: (out) => {
      setGhosts(out.proposals.map((p) => ({ ...p, at: 0 })))
      setUnplaced(out.unplaced.length)
      if (out.proposals.length > 0 && view !== 'week' && view !== 'day') {
        setView('week')
        setAnchor(new Date())
      }
      if (out.proposals.length === 0) setNote(t('caltodo.ai.none'))
    },
    onError: (e: Error) => {
      setNote(apiErrorText(e, t))
    },
  })

  const runPropose = (): void => {
    const u = unscheduled(openTodos)
    const ids =
      selected.size > 0
        ? [...selected].filter((id) => byId.has(id))
        : u.week.filter((x) => !aiBusy(x)).map((x) => x.id)
    if (ids.length === 0) return
    setNote(undefined)
    propose.mutate(ids)
  }

  const take = useMutation({
    mutationFn: async (list: Ghost[]) => {
      for (const g of list) {
        const opt = g.options[g.at]
        if (opt !== undefined) await updateTodo(g.todo_id, { scheduled: opt })
      }
      return list
    },
    onSuccess: (list) => {
      const ids = new Set(list.map((g) => g.todo_id))
      setGhosts((g) => g.filter((x) => !ids.has(x.todo_id)))
      setSelected((s) => new Set([...s].filter((id) => !ids.has(id))))
      setNote(
        list.length === 1
          ? t('caltodo.ai.took', { title: list[0]?.title ?? '' })
          : t('caltodo.ai.took_n', { n: list.length }),
      )
    },
    onError: (e: Error) => {
      setNote(apiErrorText(e, t))
    },
    onSettled: refresh,
  })

  const onGhost = (id: string, what: 'take' | 'swap'): void => {
    const g = ghosts.find((x) => x.todo_id === id)
    if (g === undefined) return
    if (what === 'take') {
      take.mutate([g])
      return
    }
    setGhosts((all) => all.map((x) => (x.todo_id === id ? { ...x, at: nextOption(x, all) } : x)))
  }

  /** 页头那句"本周 N 项"：开着的图层加起来（关掉的不算——它这一屏没画）。 */
  const total = LAYERS.filter((l) => layers.includes(l)).reduce((n, l) => n + counts[l], 0)
  const weekUndated = unscheduled(openTodos).week.length

  const top =
    ghosts.length > 0 ? (
      <div
        className="flex items-center gap-2 border-b border-ws-line bg-ws-tint px-4 py-2 text-[13px] text-ws-ink"
        data-testid="caltodo-ai-bar"
      >
        <Sparkles className="size-4 shrink-0 text-ws-brand" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {t('caltodo.ai.bar', { n: ghosts.length })}
          {unplaced > 0 ? ` ${t('caltodo.ai.unplaced', { n: unplaced })}` : ''}
        </span>
        <button
          type="button"
          className="ws-btn ws-btn-primary ws-btn-sm"
          data-testid="caltodo-ai-all"
          disabled={take.isPending}
          onClick={() => {
            take.mutate(ghosts)
          }}
        >
          {t('caltodo.ai.all')}
        </button>
        <button
          type="button"
          className="ws-btn ws-btn-ghost ws-btn-sm"
          data-testid="caltodo-ai-none"
          onClick={() => {
            setGhosts([])
            setUnplaced(0)
            setSelected(new Set())
          }}
        >
          {t('caltodo.ai.dismiss')}
        </button>
      </div>
    ) : (view === 'week' || view === 'day') && weekUndated > 0 ? (
      <div
        className="flex items-center gap-2 border-b border-ws-line px-4 py-2 text-[13px] text-ws-body"
        data-testid="caltodo-strip"
      >
        <ListTodo className="size-4 shrink-0 text-ws-brand" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('caltodo.strip', { n: weekUndated })}</span>
        <button
          type="button"
          className="ws-link-muted shrink-0 text-xs"
          data-testid="caltodo-strip-go"
          onClick={runPropose}
        >
          {t('caltodo.strip.go')}
        </button>
      </div>
    ) : undefined

  return (
    <div className="flex flex-col gap-4" data-testid="calendar" data-view={view}>
      {/*
        WP456-T5（§2.6 页头 / §3.6）：标题就是「2026 年 10 月」，后面跟一句灰字「本周 22 项」；
        右边依次是 今天 → 翻页 → 日周月议程（一个分段切换）→「安排一件事」（小号主按钮，这一页唯一的主按钮）。
        WP469：最左边是「清单 / 日历」分段；点标题弹小月历（左边那张小月历让给了「还没排期的」）。
      */}
      <CalTodoHead
        switcher={switcher}
        testId="calendar-head"
        title={
          <Popover
            open={picking}
            onOpenChange={setPicking}
            testId="calendar-pick-month"
            trigger={
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md hover:bg-ws-hover"
                aria-expanded={picking}
                onClick={() => {
                  setPicking((v) => !v)
                }}
              >
                <span data-testid="calendar-title">{monthTitle(anchor, lang)}</span>
                <ChevronDown className="size-4 text-ws-faint" aria-hidden />
              </button>
            }
          >
            <div className="w-64 p-1">
              <MiniMonth
                anchor={anchor}
                highlightWeek={view === 'week'}
                onPick={(d) => {
                  setAnchor(d)
                  setPicking(false)
                }}
                onShiftMonth={(delta) => {
                  setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
                }}
              />
            </div>
          </Popover>
        }
        sub={<span data-testid="calendar-range">{t(countKey(view), { n: total })}</span>}
        actions={
          <>
            <button
              type="button"
              className="ws-btn ws-btn-secondary ws-btn-sm"
              onClick={() => {
                setAnchor(new Date())
              }}
            >
              {t('calendar.today')}
            </button>
            <span className="flex">
              <button
                type="button"
                className="ws-btn ws-btn-ghost ws-btn-sm px-1.5"
                aria-label={t('calendar.prev')}
                onClick={() => {
                  setAnchor(addDays(anchor, -PAGE_DAYS[view]))
                }}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-ghost ws-btn-sm px-1.5"
                aria-label={t('calendar.next')}
                onClick={() => {
                  setAnchor(addDays(anchor, PAGE_DAYS[view]))
                }}
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </span>
            {/* 分段切换（§2.6 第 11 条；int/1026 换成 WP456-T2 的 Segmented，样子同一份） */}
            <Segmented
              size="sm"
              label={t('calendar.title')}
              testId="calendar-views"
              value={view}
              options={CALENDAR_VIEWS.map((v) => ({ value: v, label: t(`calendar.${v}`) }))}
              onChange={setView}
            />
            <button
              type="button"
              className="ws-btn ws-btn-primary ws-btn-sm"
              data-testid="calendar-meet"
              aria-pressed={meeting}
              onClick={() => {
                setMeeting(!meeting)
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('calendar.schedule')}
            </button>
          </>
        }
      />

      {meeting ? (
        <Card data-testid="calendar-meet-panel">
          <CardHeader>
            <CardTitle className="text-sm">{t('secretary.meet.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {people.data === undefined ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <MeetDialog
                people={people.data}
                onSent={() => {
                  void client.invalidateQueries({ queryKey: ['secretary', 'meets'] })
                }}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-5 md:flex-row">
        {/* 左栏：还没排期的 → 显示（图层；WP469 小月历挪进了标题的弹层） */}
        <aside className="flex shrink-0 flex-col gap-3 md:w-[300px]">
          <UnscheduledRail
            open={openTodos}
            selected={selected}
            ghosts={ghosts}
            busy={propose.isPending}
            focus={focus}
            onToggleSelect={(id) => {
              setSelected((s) => {
                const next = new Set(s)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }}
            onCheck={(id) => {
              act.mutate({ id, op: 'done' })
            }}
            onDropBack={(id, horizon) => {
              onTodoDrop(id, { kind: 'rail', horizon })
            }}
            onPropose={runPropose}
          />
          <LayerColumn
            layers={layers}
            counts={counts}
            showDone={showDone}
            onToggleDone={() => {
              setShowDone((v) => !v)
            }}
            onToggle={(l) => {
              setLayers(toggleLayer(layers, l))
            }}
            {...(roleHint === undefined
              ? {}
              : {
                  onOnlyThis: () => {
                    setLayers(defaultLayersFor(roleHint))
                  },
                })}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <UnifiedCalendar
            layers={layers}
            view={view}
            anchor={anchor}
            onItems={setFetched}
            heightClass="h-[calc(100vh-150px)] min-h-[520px]"
            responsive={false}
            includeDone={showDone}
            onTodoDrop={onTodoDrop}
            onTodoCheck={(id, done) => {
              act.mutate({ id, op: done ? 'done' : 'undone' })
            }}
            ghosts={ghosts}
            onGhost={onGhost}
            top={top}
          />
          {note === undefined ? null : (
            <p className="text-xs text-ws-muted-fg" role="status" data-testid="caltodo-note">
              {note}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 图层列（左栏下半）：勾选框 + 颜色方块 + 图层名 + 数量，顶上一个"只看这个岗位"。
 *
 * WP456-T5（§3.6）：勾选框和颜色分开——没勾是灰框、勾上是品牌色，**颜色只在后面那个小方块上**
 * （原来颜色方块就是勾选框，没勾的是红框、黄框，看着像出了事）。
 * 「勾掉的那一层还在，只是这一屏不画它」进标题旁边的问号，不再常驻一行。
 * WP469（决策 1524）：最后一行「做完的待办」——默认开，划掉、变淡。
 */
function LayerColumn({
  layers,
  counts,
  showDone,
  onToggleDone,
  onToggle,
  onOnlyThis,
}: {
  layers: readonly CalendarSource[]
  counts: Record<CalendarSource, number>
  showDone: boolean
  onToggleDone(): void
  onToggle(layer: CalendarSource): void
  /** 从岗位 / 职责页带着 `?role=` 进来才有：一键回到"只看这个岗位相关的那几层" */
  onOnlyThis?: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    // 一组勾选框，所以是 fieldset / legend——标题本来就是它的名字
    <fieldset data-testid="calendar-layers" className="ws-card flex flex-col py-2">
      <div className="flex w-full items-center gap-1.5 px-3.5 pt-1 pb-1.5">
        <legend className="text-xs text-ws-faint">{t('calendar.layers')}</legend>
        <Hint
          text={t('calendar.layers.hint')}
          testId="calendar-layers-help"
          className="text-ws-faint"
        />
        <span className="flex-1" />
        {onOnlyThis === undefined ? null : (
          <button
            type="button"
            data-testid="calendar-only-this"
            onClick={onOnlyThis}
            className="ws-link text-xs text-ws-brand"
          >
            {t('calendar.layers.only_this')}
          </button>
        )}
      </div>
      {LAYERS.map((layer) => (
        <LayerRow
          key={layer}
          layer={layer}
          on={layers.includes(layer)}
          label={t(`calendar.source.${layer}`)}
          count={counts[layer]}
          color={LAYER_COLOR[layer]}
          onToggle={() => {
            onToggle(layer)
          }}
        />
      ))}
      <div className="mx-3.5 my-1 h-px bg-ws-line" aria-hidden />
      <LayerRow
        layer="done"
        on={showDone}
        label={t('caltodo.layer.done')}
        onToggle={onToggleDone}
      />
    </fieldset>
  )
}

function LayerRow({
  layer,
  on,
  label,
  count,
  color,
  onToggle,
}: {
  layer: string
  on: boolean
  label: string
  count?: number
  color?: string
  onToggle(): void
}): ReactNode {
  return (
    <label
      data-testid={layer === 'done' ? 'calendar-layer-done' : 'calendar-layer'}
      data-layer={layer}
      data-on={on ? 'true' : 'false'}
      className="flex min-h-8.5 cursor-pointer items-center gap-2.5 px-3.5 text-ws-ui text-ws-ink hover:bg-ws-hover"
    >
      <input type="checkbox" checked={on} className="peer sr-only" onChange={onToggle} />
      <span
        aria-hidden
        data-testid="calendar-layer-check"
        className={`inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-[1.5px] peer-focus-visible:outline-2 peer-focus-visible:outline-ring ${
          on
            ? 'border-ws-brand bg-ws-brand text-ws-brand-fg'
            : 'border-ws-line-strong bg-transparent'
        }`}
      >
        {on ? <Check className="size-3" strokeWidth={2.5} aria-hidden /> : null}
      </span>
      {color === undefined ? (
        <span aria-hidden className="ws-cal-swatch border border-ws-line-strong" />
      ) : (
        <span aria-hidden className="ws-cal-swatch" style={{ background: color }} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="ws-num text-ws-note text-ws-faint" data-testid="calendar-layer-count">
          {count === 0 ? '' : count}
        </span>
      )}
    </label>
  )
}
