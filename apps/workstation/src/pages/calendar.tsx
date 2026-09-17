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
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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

  const title = useMemo(
    () => `${anchor.getFullYear()}-${`${anchor.getMonth() + 1}`.padStart(2, '0')}`,
    [anchor],
  )

  return (
    <div className="flex flex-col gap-4" data-testid="calendar" data-view={view}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">
          {t('calendar.title')}
          <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
            {title}
          </span>
        </h1>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('calendar.prev')}
            onClick={() => {
              setAnchor(addDays(anchor, -PAGE_DAYS[view]))
            }}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setAnchor(new Date())
            }}
          >
            {t('calendar.today')}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('calendar.next')}
            onClick={() => {
              setAnchor(addDays(anchor, PAGE_DAYS[view]))
            }}
          >
            <ChevronRight aria-hidden />
          </Button>
          <Button
            size="xs"
            variant={meeting ? 'secondary' : 'ghost'}
            data-testid="calendar-meet"
            aria-pressed={meeting}
            onClick={() => {
              setMeeting(!meeting)
            }}
          >
            {t('secretary.meet.title')}
          </Button>
          {CALENDAR_VIEWS.map((v) => (
            <Button
              key={v}
              size="xs"
              variant={view === v ? 'secondary' : 'ghost'}
              aria-pressed={view === v}
              onClick={() => {
                setView(v)
              }}
            >
              {t(`calendar.${v}`)}
            </Button>
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
        <LayerColumn
          layers={layers}
          counts={counts}
          onToggle={(l) => {
            setLayers(toggleLayer(layers, l))
          }}
        />
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

/** 左侧那一列：图层名 + 颜色点 + 数量。 */
function LayerColumn({
  layers,
  counts,
  onToggle,
}: {
  layers: readonly CalendarSource[]
  counts: Record<CalendarSource, number>
  onToggle(layer: CalendarSource): void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <aside
      data-testid="calendar-layers"
      className="flex shrink-0 flex-col gap-1 md:w-44"
      aria-label={t('calendar.layers')}
    >
      <span className="px-1 text-xs font-medium text-muted-foreground">{t('calendar.layers')}</span>
      {LAYERS.map((layer) => {
        const on = layers.includes(layer)
        const Icon = LAYER_ICON[layer]
        return (
          <label
            key={layer}
            data-testid="calendar-layer"
            data-layer={layer}
            data-on={on ? 'true' : 'false'}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted/60"
          >
            <input
              type="checkbox"
              checked={on}
              className="size-3.5 accent-primary"
              onChange={() => {
                onToggle(layer)
              }}
            />
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: LAYER_COLOR[layer] }}
            />
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t(`calendar.source.${layer}`)}</span>
            <span className="tabular-nums text-muted-foreground" data-testid="calendar-layer-count">
              {counts[layer]}
            </span>
          </label>
        )
      })}
      {/* 勾掉的那一层还在，只是这一屏不画它——这句话省掉的话，人会以为勾掉 = 删掉 */}
      <p className="px-1 pt-1 text-[11px] leading-snug text-muted-foreground">
        {t('calendar.layers.hint')}
      </p>
    </aside>
  )
}
