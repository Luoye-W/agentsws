/**
 * WP74（37 §2.5）：**一个日历**的那个壳。
 *
 * 壳用 Schedule-X（MIT）。自己画月格是 WP37 那会儿的权宜之计——它能把方块摆对，
 * 但拖不动、没有日 / 周 / 议程、跨时段的事画不出来，而日历恰恰"既是视图也是排期面"。
 * 所以这一版把格子交给一个专门做这件事的库，我们只留三样自己的东西：
 *
 * 1. **图层**（哪几类东西现在看得见）——`lib/calendar-layers.ts`，纯函数，可单测；
 * 2. **拖拽语义**（拖了走哪条路）——判据在服务端给（`CalendarItem.drag`），这里只**执行**；
 * 3. **事件小卡**（点开看到什么）——用我们自己的 shadcn 卡，不用库自带的弹窗，
 *    否则深浅色、字号、圆角会跟工作台其余部分差一截。
 *
 * 一处要说清楚的：**颜色用 CSS 变量**（`var(--chart-1)`…）。Schedule-X 的
 * `calendars` 接的是颜色字符串，我们把 shadcn 的 token 原样递进去——这样深色浅色
 * 是浏览器在上色那一刻算的，不需要在这里监听主题再算一遍。
 */
import 'temporal-polyfill/global'
import type { CalendarItem, CalendarSource } from '@agentsws/contracts'
import {
  type CalendarApp,
  type CalendarEvent,
  createViewDay,
  createViewMonthAgenda,
  createViewMonthGrid,
  createViewWeek,
} from '@schedule-x/calendar'
import '@schedule-x/theme-default/dist/index.css'
import { createCalendarControlsPlugin } from '@schedule-x/calendar-controls'
import { createDragAndDropPlugin } from '@schedule-x/drag-and-drop'
import { ScheduleXCalendar, useCalendarApp } from '@schedule-x/react'
import { createResizePlugin } from '@schedule-x/resize'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GoButton, StatusPill, WsCard } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getCalendar, rescheduleSocialPost, scheduleTodo } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dispatchDrag, dragVerdict } from '@/lib/calendar-drag'
import {
  type CalendarView,
  filterByLayers,
  LAYER_COLOR,
  LAYERS,
  serializeLayers,
} from '@/lib/calendar-layers'
import './unified-calendar.css'

/** 浏览器自己那个时区。日界线在服务端按工作区时区切，这里只管画。 */
function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** Schedule-X 的视图名（日 / 周 / 月 / 议程）。 */
const VIEW_NAME: Record<CalendarView, string> = {
  day: 'day',
  week: 'week',
  month: 'month-grid',
  agenda: 'month-agenda',
}

const DAY_MS = 86_400_000

/** 这一屏要问服务端的窗口：把当前视图前后各放宽一点，翻一页不必立刻再请求。 */
export function windowFor(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  if (view === 'day') return { from: addDays(day, -1), to: addDays(day, 2) }
  if (view === 'week') {
    const monday = addDays(day, -((day.getDay() + 6) % 7))
    return { from: addDays(monday, -7), to: addDays(monday, 14) }
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  return { from: addDays(first, -14), to: addDays(first, 60) }
}

function addDays(at: Date, n: number): Date {
  return new Date(at.getTime() + n * DAY_MS)
}

/** ISO → Schedule-X 的时刻（带时区）。 */
function toZoned(iso: string, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.from(iso).toZonedDateTimeISO(tz)
}

/** ISO → Schedule-X 的"那一天"（全天项）。 */
function toPlainDate(iso: string, tz: string): Temporal.PlainDate {
  return toZoned(iso, tz).toPlainDate()
}

/** Schedule-X 改完之后回来的那个时刻 → ISO。全天项按当天零点读。 */
function fromSx(value: Temporal.ZonedDateTime | Temporal.PlainDate, tz: string): string {
  return value instanceof Temporal.PlainDate
    ? value.toZonedDateTime(tz).toInstant().toString()
    : value.toInstant().toString()
}

/** 一条日历项 → Schedule-X 的事件。`calendarId` 就是图层名（颜色从 `calendars` 上来）。 */
function toEvent(item: CalendarItem, tz: string): CalendarEvent {
  const base = {
    id: item.id,
    title: item.title,
    calendarId: item.source,
    ...(item.notes === undefined ? {} : { description: item.notes.join('\n') }),
    // 只读的那几层连"拖起来"这一下都不给：拖起来再回弹比拖不动更让人以为是坏了
    ...(item.drag === 'reschedule' ? {} : { _options: { disableDND: true, disableResize: true } }),
  }
  if (item.all_day) {
    const d = toPlainDate(item.start, tz)
    return { ...base, start: d, end: d }
  }
  return {
    ...base,
    start: toZoned(item.start, tz),
    end: toZoned(item.end ?? item.start, tz),
  }
}

export interface UnifiedCalendarProps {
  /** 现在开着的图层（画哪几层） */
  layers: readonly CalendarSource[]
  /**
   * 向服务端要哪几层。不传 = 全部——日历那一页要全部，因为图层开关旁边那个数字
   * 得把**关掉的层**也数出来（看不出"关掉的那层里有东西"的开关是没用的）。
   */
  fetchLayers?: readonly CalendarSource[]
  view: CalendarView
  /** 定位到哪一天 */
  anchor: Date
  /** 只看这条渠道的社媒排期（职责页嵌进来时用；一条职责只看它自己那条渠道，56 §2） */
  channel?: string
  /** 社媒那几条路由要带的 `X-Assignment`（职责页嵌进来时用） */
  assignment?: string
  /** 取回来的**全部**项（图层计数用；已经按 `fetchLayers` 过滤过） */
  onItems?(items: CalendarItem[]): void
  /** 点某一天的空白 */
  onPickDate?(iso: string): void
  /** 这一屏的高度（职责页里那一块比整页矮） */
  heightClass?: string
}

/**
 * 一个图层的三个颜色。Schedule-X 把它们写成 `--sx-color-<图层>[-container]`，
 * 我们递进去的是 shadcn 的 token 与一次 `color-mix`——深浅色因此是浏览器上色那一刻
 * 算的，这个组件里没有一行"如果是深色就……"。
 */
function layerPalette(layer: CalendarSource): {
  colorName: string
  lightColors: { main: string; container: string; onContainer: string }
  darkColors: { main: string; container: string; onContainer: string }
} {
  const main = LAYER_COLOR[layer]
  const colors = {
    main,
    container: `color-mix(in oklab, ${main} 18%, var(--card))`,
    onContainer: 'var(--card-foreground)',
  }
  return { colorName: layer, lightColors: colors, darkColors: colors }
}

export function UnifiedCalendar({
  layers,
  fetchLayers,
  view,
  anchor,
  channel,
  assignment,
  onItems,
  onPickDate,
  heightClass = 'h-[70vh]',
}: UnifiedCalendarProps): React.ReactNode {
  const { t, theme, lang } = useApp()
  const client = useQueryClient()
  const tz = useMemo(() => browserTz(), [])
  const [note, setNote] = useState<string | undefined>(undefined)
  const [picked, setPicked] = useState<CalendarItem | undefined>(undefined)

  const range = windowFor(view, anchor)
  const sources = fetchLayers === undefined ? undefined : serializeLayers(fetchLayers)

  const calendar = useQuery({
    queryKey: ['calendar', range.from.toISOString(), range.to.toISOString(), sources ?? 'all'],
    queryFn: () => getCalendar(range.from.toISOString(), range.to.toISOString(), sources),
  })

  /** 这一屏画的是哪些（渠道过滤 + 图层过滤；两者都在客户端做，勾一下不重新请求）。 */
  const items = useMemo(() => {
    const all = calendar.data?.items ?? []
    const byChannel =
      channel === undefined
        ? all
        : all.filter((i) => i.source !== 'social_post' || i.channel === channel)
    return filterByLayers(byChannel, layers)
  }, [calendar.data, channel, layers])

  /** 事件 id → 那一条（拖拽回调里只拿得到事件，判据在这一份上）。 */
  const byId = useRef(new Map<string, CalendarItem>())
  byId.current = new Map(items.map((i) => [i.id, i]))

  const reportRef = useRef(onItems)
  reportRef.current = onItems
  useEffect(() => {
    const all = calendar.data?.items
    if (all !== undefined) reportRef.current?.(all)
  }, [calendar.data])

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['calendar'] })
    void client.invalidateQueries({ queryKey: ['todos'] })
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['social-calendar'] })
  }

  const moveTodo = useMutation({
    mutationFn: (input: { id: string; start: string; end: string }) =>
      scheduleTodo(input.id, { start: input.start, end: input.end }),
    onSuccess: () => {
      setNote(t('calendar.drag.todo_done'))
      refresh()
    },
    onError: (e: Error) => {
      setNote(t('calendar.drag.failed', { message: e.message }))
      refresh()
    },
  })

  const moveSocial = useMutation({
    mutationFn: (input: { id: string; at: string }) =>
      rescheduleSocialPost(input.id, input.at, assignment),
    onSuccess: (res) => {
      // WP73 纪律 2：拖完不是"改好了"，是"提上去了，等人点头"
      setNote(
        res.conflicts.length > 0
          ? `${t('social.calendar.moved')} ${res.conflicts.join(' ')}`
          : t('social.calendar.moved'),
      )
      refresh()
    },
    onError: (e: Error) => {
      setNote(t('calendar.drag.failed', { message: e.message }))
      refresh()
    },
  })

  /** 回调里要读最新的 state / mutation，但日历只建一次，所以统统走 ref。 */
  const handlers = useRef({ moveTodo, moveSocial, setNote, setPicked, t, onPickDate })
  handlers.current = { moveTodo, moveSocial, setNote, setPicked, t, onPickDate }

  const controls = useMemo(() => createCalendarControlsPlugin(), [])

  const app: CalendarApp | null = useCalendarApp(
    {
      views: [createViewDay(), createViewWeek(), createViewMonthGrid(), createViewMonthAgenda()],
      defaultView: VIEW_NAME[view],
      timezone: tz,
      firstDayOfWeek: 1,
      locale: lang === 'en' ? 'en-US' : 'zh-CN',
      /**
       * 日 / 周视图只画 08:00–20:00（WP96 照画布收窄了两头）。
       *
       * 整整 24 小时的格子里，凌晨那八行永远是空的，而它们把真正有事的时段挤到了
       * 屏幕外面——打开周视图第一眼看到的是 1AM 到 8AM 的空白。做生意的一天从早上
       * 开始，也在晚上结束：真落在这之外的事仍然画得出来，Schedule-X 会把它顶到
       * 边界那一格，不会丢。
       */
      dayBoundaries: { start: '08:00', end: '20:00' },
      isDark: theme === 'dark',
      events: [],
      // 七个图层各一个 shadcn token：深浅色由浏览器在上色那一刻算，不在这里监听主题
      calendars: Object.fromEntries(LAYERS.map((l) => [l, layerPalette(l)])),
      callbacks: {
        onEventClick: (event) => {
          const item = byId.current.get(String(event.id))
          if (item !== undefined) handlers.current.setPicked(item)
        },
        onClickDate: (date) => {
          handlers.current.onPickDate?.(date.toZonedDateTime(tz).toInstant().toString())
        },
        /**
         * 拖拽语义按来源（WP74）。判据是服务端给的 `CalendarItem.drag`，这里只执行：
         * 只读的回弹并说为什么，会议回弹并提示走秘书那条约时间。
         */
        onBeforeEventUpdate: (_old, next) => {
          const item = byId.current.get(String(next.id))
          const verdict = dragVerdict(item, handlers.current.t)
          if (verdict.kind === 'propose') {
            // 会议：回弹，并把那一条摊开——"改时间"要对方点头才算（41 §1.2）
            handlers.current.setNote(handlers.current.t('calendar.drag.meeting'))
            if (item !== undefined) handlers.current.setPicked(item)
            return false
          }
          if (verdict.kind === 'bounce') {
            handlers.current.setNote(verdict.why)
            return false
          }
          return true
        },
        onEventUpdate: (event) => {
          const item = byId.current.get(String(event.id))
          if (item === undefined) return
          dispatchDrag(
            item,
            { start: fromSx(event.start, tz), end: fromSx(event.end, tz) },
            {
              todo: (id, slot) => {
                handlers.current.moveTodo.mutate({ id, ...slot })
              },
              socialPost: (id, at) => {
                handlers.current.moveSocial.mutate({ id, at })
              },
            },
          )
        },
      },
    },
    [createDragAndDropPlugin(15), createResizePlugin(15), controls],
  )

  // 事件变了：换一份进去（不重建日历，否则滚动位置与正在拖的那一下都没了）
  useEffect(() => {
    app?.events.set(items.map((i) => toEvent(i, tz)))
  }, [app, items, tz])

  // 视图 / 定位日 / 主题变了：走 controls，同样不重建
  useEffect(() => {
    if (app === null) return
    controls.setView(VIEW_NAME[view])
    controls.setDate(toPlainDate(anchor.toISOString(), tz))
  }, [app, controls, view, anchor, tz])

  useEffect(() => {
    app?.setTheme(theme === 'dark' ? 'dark' : 'light')
  }, [app, theme])

  // 中英切换：星期名与钟点跟着换（日历只建一次，所以走 controls）
  useEffect(() => {
    if (app === null) return
    controls.setLocale(lang === 'en' ? 'en-US' : 'zh-CN')
  }, [app, controls, lang])

  if (calendar.isPending) return <Skeleton className={`w-full ${heightClass}`} />
  if (calendar.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{calendar.error.message}
      </p>
    )

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid="unified-calendar">
      {layers.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="calendar-no-layer">
          {t('calendar.layers.none')}
        </p>
      ) : null}
      <div
        className={`sx-host min-w-0 ${heightClass}`}
        data-testid="calendar-host"
        data-view={view}
        data-count={items.length}
      >
        <ScheduleXCalendar calendarApp={app} />
      </div>

      {/* 拖完之后那句话。不是 toast：它常常要人读完（撞车说明就在里面） */}
      {note === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="calendar-note">
          {note}
        </p>
      )}

      {picked === undefined ? null : (
        <EventCard
          item={picked}
          onClose={() => {
            setPicked(undefined)
          }}
        />
      )}
    </div>
  )
}

/**
 * 点开一条出来的小卡（WP96 照画布《日历 · 新风格》右下那张）。
 *
 * 四样东西：图层胶囊 + 状态胶囊、标题、预览（来源那一行 + 撞车提示）、
 * 一主一次两个按钮 + 右下角的 → 圆钮。**与卡片队列是同一套语言**——
 * 人在日历上点开一条和在队列里翻到一张，看到的应该是同一种东西。
 */
function EventCard({
  item,
  onClose,
}: {
  item: CalendarItem
  onClose: () => void
}): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const href =
    item.matter_id !== undefined
      ? `/matters/${item.matter_id}`
      : item.position_id !== undefined
        ? `/positions/${item.position_id}`
        : undefined
  return (
    <WsCard
      data-testid="calendar-event-card"
      data-source={item.source}
      className="flex flex-col gap-2.5 p-4 text-sm"
    >
      <div className="flex items-center gap-2">
        <StatusPill tone="brand">{t(`calendar.source.${item.source}`)}</StatusPill>
        {item.status === undefined ? null : <StatusPill tone="warn">{item.status}</StatusPill>}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onClose} aria-label={t('calendar.event.close')}>
          ✕
        </Button>
      </div>
      <div className="text-[14.5px] leading-5 font-semibold">{item.title}</div>
      {item.notes === undefined ? null : (
        <ul className="list-disc pl-4 text-xs text-ws-bad">
          {item.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t border-ws-line pt-2.5">
        {href === undefined ? null : (
          <Link
            to={href}
            className="inline-flex h-8 items-center rounded-[10px] bg-ws-brand px-3 text-xs font-medium text-ws-brand-fg"
          >
            {item.matter_id === undefined
              ? t('calendar.open_position')
              : t('calendar.open_in_matter')}
          </Link>
        )}
        <Button size="xs" variant="ghost" onClick={onClose}>
          {t('calendar.event.later')}
        </Button>
        <span className="flex-1" />
        {href === undefined ? null : (
          <GoButton
            label={t('deck.go')}
            onClick={() => {
              navigate(href)
            }}
          />
        )}
      </div>
    </WsCard>
  )
}
