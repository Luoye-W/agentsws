/**
 * 日历（37 C3 + §2.5）：**一个日历，多图层**。
 *
 * 左栏那一项"日历"点开就是这一页。这一版三件事变了：
 *
 * 1. 壳换成 Schedule-X（`components/calendar/unified-calendar.tsx`），日 / 周 / 月 / 议程
 *    四个视图，拖得动；
 * 2. 左侧一列**图层开关**：七层各一个勾、一个颜色点、一个数字。勾掉的那一层还在，
 *    只是这一屏不画它——所以数字要照数，看不出"关掉的那层里有东西"的开关是没用的；
 * 3. **从哪儿进来决定默认开哪几层**（`?layers=`）。从社媒运营的职责页点进来，
 *    默认看到的应该是社媒排期与自己的待办，而不是七层一起糊在一屏上。
 *
 * 记忆落在本机（`lib/ui-state`，与左右栏折叠态同一处）：它不是工作数据，
 * 换台电脑重新勾一次没有任何损失，所以不占服务端一张表、也不占一条路由。
 */
import type { CalendarItem, CalendarSource } from '@agentsws/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MiniMonth } from '@/components/calendar/mini-month'
import { UnifiedCalendar } from '@/components/calendar/unified-calendar'
import { MeetDialog } from '@/components/secretary/meet-dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositions, listPeople } from '@/lib/api'
import { useApp } from '@/lib/app-context'
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
import { addDays } from '@/lib/work'

/** 翻一页 = 翻多少天（议程跟月同档：它画的就是一个月）。 */
const PAGE_DAYS: Record<CalendarView, number> = { day: 1, week: 7, month: 30, agenda: 30 }

export function CalendarPage(): React.ReactNode {
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

  const people = useQuery({
    queryKey: ['secretary', 'people'],
    enabled: meeting,
    queryFn: listPeople,
  })

  /** 页头那句"本周 N 项"：开着的图层加起来（关掉的不算——它这一屏没画）。 */
  const total = LAYERS.filter((l) => layers.includes(l)).reduce((n, l) => n + counts[l], 0)

  return (
    <div className="flex flex-col gap-4" data-testid="calendar" data-view={view}>
      {/*
        WP456-T5（§2.6 页头 / §3.6）：标题就是「2026 年 10 月」，后面跟一句灰字「本周 22 项」；
        右边依次是 今天 → 翻页 → 日周月议程（一个分段切换）→「安排一件事」（小号主按钮，这一页唯一的主按钮）。
      */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="calendar-head">
        <h1 className="ws-display text-ws-page" data-testid="calendar-title">
          {monthTitle(anchor, lang)}
        </h1>
        <span className="ws-num mt-1 text-ws-ui text-ws-muted-fg" data-testid="calendar-range">
          {t(countKey(view), { n: total })}
        </span>
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
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
          {/* 分段切换（§2.6 第 11 条）：灰底，选中的那一格卡底加一点小阴影 */}
          <div
            className="inline-flex items-center gap-0.5 rounded-md bg-ws-secondary p-0.5"
            data-testid="calendar-views"
          >
            {CALENDAR_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v)
                }}
                className={`h-6.5 rounded-sm px-2.5 text-xs ${
                  view === v
                    ? 'bg-ws-card font-semibold text-ws-ink shadow-xs dark:bg-ws-hover'
                    : 'text-ws-muted-fg hover:text-ws-ink'
                }`}
              >
                {t(`calendar.${v}`)}
              </button>
            ))}
          </div>
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
        </div>
      </header>

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
        {/* 左栏：小月历 → 图层勾选（「安排一件事」挪到页头右边了） */}
        <aside className="flex shrink-0 flex-col gap-3 md:w-[232px]">
          <MiniMonth
            anchor={anchor}
            highlightWeek={view === 'week'}
            onPick={(d) => {
              setAnchor(d)
            }}
            onShiftMonth={(delta) => {
              setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
            }}
          />
          <LayerColumn
            layers={layers}
            counts={counts}
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
        <UnifiedCalendar
          layers={layers}
          view={view}
          anchor={anchor}
          onItems={setFetched}
          heightClass="h-[calc(100vh-140px)] min-h-[520px]"
          responsive={false}
        />
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
 */
function LayerColumn({
  layers,
  counts,
  onToggle,
  onOnlyThis,
}: {
  layers: readonly CalendarSource[]
  counts: Record<CalendarSource, number>
  onToggle(layer: CalendarSource): void
  /** 从岗位 / 职责页带着 `?role=` 进来才有：一键回到"只看这个岗位相关的那几层" */
  onOnlyThis?: () => void
}): React.ReactNode {
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
      {LAYERS.map((layer) => {
        const on = layers.includes(layer)
        return (
          <label
            key={layer}
            data-testid="calendar-layer"
            data-layer={layer}
            data-on={on ? 'true' : 'false'}
            className="flex min-h-8.5 cursor-pointer items-center gap-2.5 px-3.5 text-ws-ui text-ws-ink hover:bg-ws-hover"
          >
            <input
              type="checkbox"
              checked={on}
              className="peer sr-only"
              onChange={() => {
                onToggle(layer)
              }}
            />
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
            <span
              aria-hidden
              className="ws-cal-swatch"
              style={{ background: LAYER_COLOR[layer] }}
            />
            <span className="min-w-0 flex-1 truncate">{t(`calendar.source.${layer}`)}</span>
            <span className="ws-num text-ws-note text-ws-faint" data-testid="calendar-layer-count">
              {counts[layer] === 0 ? '' : counts[layer]}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}
