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
import type { CalendarSource } from '@agentsws/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MiniMonth } from '@/components/calendar/mini-month'
import { UnifiedCalendar } from '@/components/calendar/unified-calendar'
import { MeetDialog } from '@/components/secretary/meet-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { listPeople } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  CALENDAR_VIEWS,
  type CalendarView,
  countByLayer,
  defaultLayersFor,
  LAYER_COLOR,
  LAYER_ICON,
  LAYERS,
  loadLayers,
  loadView,
  parseLayers,
  saveLayers,
  saveView,
  toggleLayer,
} from '@/lib/calendar-layers'
import { addDays } from '@/lib/work'

/** 翻一页 = 翻多少天（议程跟月同档：它画的就是一个月）。 */
const PAGE_DAYS: Record<CalendarView, number> = { day: 1, week: 7, month: 30, agenda: 30 }

export function CalendarPage(): React.ReactNode {
  const { t } = useApp()
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
  const [view, setView] = useState<CalendarView>(() => loadView() ?? 'week')
  const [anchor, setAnchor] = useState(() => new Date())
  // 41 §1.2：约别人 = 向对方的代理发一张卡，对方点头才进双方日历
  const [meeting, setMeeting] = useState(false)
  const [counts, setCounts] = useState(() => countByLayer([]))

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

  /** 顶栏那句"本周 N 项"：开着的图层加起来（关掉的不算——它这一屏没画）。 */
  const total = LAYERS.filter((l) => layers.includes(l)).reduce((n, l) => n + counts[l], 0)

  const title = useMemo(
    () => `${anchor.getFullYear()}-${`${anchor.getMonth() + 1}`.padStart(2, '0')}`,
    [anchor],
  )

  return (
    <div className="flex flex-col gap-4" data-testid="calendar" data-view={view}>
      {/*
        WP96 画布《日历 · 新风格》顶栏：今天 → 翻页 → 范围与统计 → 日周月议程分段。
        分段是一块浅底里的四个钮（不是四个独立按钮），因为它们是"四选一"。
      */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setAnchor(new Date())
          }}
        >
          {t('calendar.today')}
        </Button>
        <span className="flex gap-1">
          <button
            type="button"
            className="ws-go"
            aria-label={t('calendar.prev')}
            onClick={() => {
              setAnchor(addDays(anchor, -PAGE_DAYS[view]))
            }}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="ws-go"
            aria-label={t('calendar.next')}
            onClick={() => {
              setAnchor(addDays(anchor, PAGE_DAYS[view]))
            }}
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </span>
        <h1 className="ws-display text-[22px]">{t('calendar.title')}</h1>
        <span className="ws-num text-[12.5px] text-ws-muted-fg" data-testid="calendar-range">
          {title} · {t('calendar.count', { n: total })}
        </span>
        <span className="flex-1" />
        <div
          className="flex items-center gap-0.5 rounded-xl bg-ws-surface p-0.5"
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
              className={`rounded-[9px] px-2.5 py-1 text-xs ${
                view === v ? 'bg-ws-card shadow-ws' : 'text-ws-muted-fg hover:text-ws-ink'
              }`}
            >
              {t(`calendar.${v}`)}
            </button>
          ))}
        </div>
      </div>

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

      <div className="flex flex-col gap-4 md:flex-row">
        {/* 画布左栏：主按钮 → 小月历 → 图层勾选 */}
        <aside className="flex shrink-0 flex-col gap-3.5 md:w-[236px]">
          <Button
            className="h-9 w-full justify-center rounded-xl"
            data-testid="calendar-meet"
            aria-pressed={meeting}
            onClick={() => {
              setMeeting(!meeting)
            }}
          >
            {t('calendar.schedule')}
          </Button>
          <MiniMonth
            anchor={anchor}
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
          onItems={(items) => {
            setCounts(countByLayer(items))
          }}
        />
      </div>
    </div>
  )
}

/**
 * 图层列（画布左栏下半）：颜色方块 + 图层名 + 数量，顶上一个"只看这个岗位"。
 *
 * 颜色方块就是**勾选框本身**（勾上了是实心带勾，勾掉是空心留一圈边）——画布上
 * 一个格子干两件事：说这层是什么颜色、说它开着没有。
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
    <fieldset data-testid="calendar-layers" className="ws-card flex flex-col gap-0.5 p-2">
      <div className="flex w-full items-center px-2 pt-1 pb-2">
        <legend className="text-[11px] tracking-wider text-ws-muted-fg uppercase">
          {t('calendar.layers')}
        </legend>
        <span className="flex-1" />
        {onOnlyThis === undefined ? null : (
          <button
            type="button"
            data-testid="calendar-only-this"
            onClick={onOnlyThis}
            className="text-[11.5px] text-ws-brand hover:underline"
          >
            {t('calendar.layers.only_this')}
          </button>
        )}
      </div>
      {LAYERS.map((layer) => {
        const on = layers.includes(layer)
        const Icon = LAYER_ICON[layer]
        return (
          <label
            key={layer}
            data-testid="calendar-layer"
            data-layer={layer}
            data-on={on ? 'true' : 'false'}
            className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] hover:bg-ws-surface ${
              on ? '' : 'text-ws-muted-fg'
            }`}
          >
            <input
              type="checkbox"
              checked={on}
              className="sr-only"
              onChange={() => {
                onToggle(layer)
              }}
            />
            <span
              aria-hidden
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] text-white"
              style={{
                borderColor: LAYER_COLOR[layer],
                background: on ? LAYER_COLOR[layer] : 'transparent',
              }}
            >
              {on ? <Check className="size-2.5" aria-hidden /> : null}
            </span>
            <Icon className="size-3.5 shrink-0 text-ws-muted-fg" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t(`calendar.source.${layer}`)}</span>
            <span
              className="ws-num text-[11.5px] text-ws-muted-fg"
              data-testid="calendar-layer-count"
            >
              {counts[layer] === 0 ? '' : counts[layer]}
            </span>
          </label>
        )
      })}
      {/* 勾掉的那一层还在，只是这一屏不画它——这句话省掉的话，人会以为勾掉 = 删掉 */}
      <p className="px-2 pt-1.5 pb-1 text-[11px] leading-snug text-ws-muted-fg">
        {t('calendar.layers.hint')}
      </p>
    </fieldset>
  )
}
