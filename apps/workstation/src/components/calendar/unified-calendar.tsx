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
import { createCurrentTimePlugin } from '@schedule-x/current-time'
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
import {
  ALL_DAY_MAX,
  foldAllDay,
  foldMonth,
  MORE_ID_PREFIX,
  moreDayOf,
} from '@/lib/calendar-allday'
import { dispatchDrag, dragVerdict } from '@/lib/calendar-drag'
import {
  type CalendarView,
  filterByLayers,
  LAYER_COLOR,
  LAYER_ICON,
  LAYERS,
  serializeLayers,
} from '@/lib/calendar-layers'
import { displayEnd, eventContent, writeBackEnd } from '@/lib/calendar-view'
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

/**
 * WP457（WP456 §3.6）：小时格每格 52px，08:00–20:00 一共 12 格。
 * 原来是库的缺省 1600px（每格 133px），一屏只看得见三四个钟点。
 */
const HOUR_PX = 52
const DAY_HOURS = 12

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

/**
 * 一条日历项 → Schedule-X 的事件。`calendarId` 就是图层名（底色从 `calendars` 上来）。
 *
 * WP456-T5：格子里画什么由我们给（`_customContent`）——图层色细条 + 标题 + 「9:00 · 社媒排期」；
 * 只有一个时刻的按 1 小时高画（`displayEnd`），否则标题挤成一行只剩三四个字。
 */
function toEvent(item: CalendarItem, tz: string, layerName: string): CalendarEvent {
  const base = {
    id: item.id,
    title: item.title,
    calendarId: item.source,
    ...(item.notes === undefined ? {} : { description: item.notes.join('\n') }),
    // 只读的那几层连"拖起来"这一下都不给：拖起来再回弹比拖不动更让人以为是坏了
    ...(item.drag === 'reschedule' ? {} : { _options: { disableDND: true, disableResize: true } }),
    _customContent: eventContent(item, { color: LAYER_COLOR[item.source], layerName }),
  }
  if (item.all_day) {
    const d = toPlainDate(item.start, tz)
    return { ...base, start: d, end: d }
  }
  return {
    ...base,
    start: toZoned(item.start, tz),
    end: toZoned(displayEnd(item).end, tz),
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
  /**
   * 库的「窄了就换视图」（默认开着）。日历整页传 false：库认为「议程」只给窄屏用，宽屏下点「议程」
   * 会被它悄悄换成日视图（WP456-T5 截图时发现）；整页的视图由页头那个分段说了算。
   */
  responsive?: boolean
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
  // 底色是同色的淡版：浅 10%、深 16%，和示意稿一致。库把这几个变量写在 <html> 上，
  // 所以比例只能直接写在这里（写成我们自己的 CSS 变量，在 <html> 那一层取不到）。
  const tinted = (pct: number) => ({
    main,
    container: `color-mix(in srgb, ${main} ${pct}%, var(--ws-card))`,
    onContainer: 'var(--ws-ink)',
  })
  return { colorName: layer, lightColors: tinted(10), darkColors: tinted(16) }
}

/** 「还有 N 项」那一条：不是一个图层，没有底色，只是一行灰字（样式在 `unified-calendar.css`）。 */
const MORE_PALETTE = {
  colorName: 'more',
  lightColors: { main: 'transparent', container: 'transparent', onContainer: 'var(--ws-muted-fg)' },
  darkColors: { main: 'transparent', container: 'transparent', onContainer: 'var(--ws-muted-fg)' },
}

/**
 * 那一天（`YYYY-MM-DD`）→ 「还有 N 项」那一条事件。拖不动、改不了长短。
 *
 * 周 / 日视图里它是一条全天项（排在全天区最后一行）；月格里库按开始时刻排，全天项排最前，
 * 所以月格里它落在那天 23:59——排在最后，字由 `_customContent` 给，不出钟点。
 */
function moreEvent(day: string, title: string, inMonth: boolean, tz: string): CalendarEvent {
  const d = Temporal.PlainDate.from(day)
  const at = inMonth
    ? d.toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from('23:59') })
    : d
  return {
    id: `${MORE_ID_PREFIX}${day}`,
    title,
    calendarId: 'more',
    start: at,
    end: at,
    _options: { disableDND: true, disableResize: true },
    _customContent: { monthGrid: `<span class="ws-ev-title">${title}</span>` },
  }
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
  responsive = true,
}: UnifiedCalendarProps): React.ReactNode {
  const { t, theme, lang } = useApp()
  const client = useQueryClient()
  const tz = useMemo(() => browserTz(), [])
  const [note, setNote] = useState<string | undefined>(undefined)
  const [picked, setPicked] = useState<CalendarItem | undefined>(undefined)
  /** 点开了哪一天的「还有 N 项」（`YYYY-MM-DD`） */
  const [moreDay, setMoreDay] = useState<string | undefined>(undefined)

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

  /**
   * WP457：日 / 周视图的全天区每天最多画 2 条，多的折成「还有 N 项」。
   * WP456-T5：月格也照这一套（每天 2 条 + 「还有 N 项」，点开同一张小卡）；议程是列表，不折。
   */
  const fold = useMemo(() => {
    const dayOf = (iso: string): string => toPlainDate(iso, tz).toString()
    if (view === 'day' || view === 'week') return foldAllDay(items, dayOf)
    if (view === 'month') return foldMonth(items, dayOf)
    return { shown: items, hidden: new Map<string, CalendarItem[]>() }
  }, [items, view, tz])

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
  const handlers = useRef({ moveTodo, moveSocial, setNote, setPicked, setMoreDay, t, onPickDate })
  handlers.current = { moveTodo, moveSocial, setNote, setPicked, setMoreDay, t, onPickDate }

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
      // WP457：每格 52px；钟点写「9:00」（原来是「9时」，又灰到看不清）
      weekOptions: {
        gridHeight: HOUR_PX * DAY_HOURS,
        timeAxisFormatOptions: { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' },
      },
      // WP456-T5：月格每天 2 条 + 「还有 N 项」是我们折好的（最多 3 条）；库自己那套「+ 9 场活动」不再出现
      monthGridOptions: { nEventsPerDay: ALL_DAY_MAX + 1 },
      isDark: theme === 'dark',
      isResponsive: responsive,
      events: [],
      // 七个图层各一个 shadcn token：深浅色由浏览器在上色那一刻算，不在这里监听主题
      calendars: {
        ...Object.fromEntries(LAYERS.map((l) => [l, layerPalette(l)])),
        more: MORE_PALETTE,
      },
      callbacks: {
        onEventClick: (event) => {
          const day = moreDayOf(String(event.id))
          if (day !== undefined) {
            handlers.current.setPicked(undefined)
            handlers.current.setMoreDay(day)
            return
          }
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
          const start = fromSx(event.start, tz)
          dispatchDrag(
            item,
            // 画的时候补过 1 小时的（只有一个时刻的那种），回写时去掉补的那一截
            { start, end: writeBackEnd(item, start, fromSx(event.end, tz)) },
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
    [
      createDragAndDropPlugin(15),
      createResizePlugin(15),
      // WP456-T5：当前时间一条红线（只画在今天那一列；颜色在 unified-calendar.css）
      createCurrentTimePlugin({ fullWeekWidth: false }),
      controls,
    ],
  )

  // 事件变了：换一份进去（不重建日历，否则滚动位置与正在拖的那一下都没了）
  useEffect(() => {
    app?.events.set([
      ...fold.shown.map((i) => toEvent(i, tz, t(`calendar.source.${i.source}`))),
      ...[...fold.hidden].map(([day, rest]) =>
        moreEvent(day, t('calendar.more', { n: rest.length }), view === 'month', tz),
      ),
    ])
  }, [app, fold, tz, t, view])
  const hiddenOfDay = moreDay === undefined ? undefined : fold.hidden.get(moreDay)
  const todayKey = Temporal.Now.plainDateISO(tz).toString()

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
        // 全天区左边那格写「全天」（库不画这个字；CSS 用 content 取这个变量）
        style={
          { '--ws-allday-label': JSON.stringify(t('calendar.all_day')) } as React.CSSProperties
        }
      >
        {/*
          WP456-T5：周视图里今天那一列整列一层淡品牌色（示意稿；日视图只有一列，不用标）。库只在表头上标「今天」，
          时间格那一列没有类名可认，所以按日期点名——日期是我们自己算的，不是外来的字。
        */}
        <style>{`.sx-host[data-view="week"] [data-time-grid-date="${todayKey}"]{background-color:var(--ws-cal-today-col)}`}</style>
        <ScheduleXCalendar calendarApp={app} />
      </div>

      {/* 拖完之后那句话。不是 toast：它常常要人读完（撞车说明就在里面） */}
      {note === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="calendar-note">
          {note}
        </p>
      )}

      {moreDay === undefined || hiddenOfDay === undefined ? null : (
        <MoreCard
          day={moreDay}
          items={hiddenOfDay}
          onPick={(item) => {
            setMoreDay(undefined)
            setPicked(item)
          }}
          onClose={() => {
            setMoreDay(undefined)
          }}
        />
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
 * WP457：点「还有 N 项」出来的那张小卡——那一天折起来的几条，一行一条（图层色点 + 图标 + 标题），
 * 点一条就换成那一条的小卡（{@link EventCard}）。
 */
function MoreCard({
  day,
  items,
  onPick,
  onClose,
}: {
  day: string
  items: readonly CalendarItem[]
  onPick(item: CalendarItem): void
  onClose(): void
}): React.ReactNode {
  const { t } = useApp()
  const d = Temporal.PlainDate.from(day)
  return (
    <WsCard data-testid="calendar-more-card" className="flex flex-col gap-1.5 p-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          {t('calendar.more.title', { month: d.month, day: d.day, n: items.length })}
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onClose} aria-label={t('calendar.event.close')}>
          ✕
        </Button>
      </div>
      <ul className="flex flex-col">
        {items.map((item) => {
          const Icon = LAYER_ICON[item.source]
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid="calendar-more-item"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ws-hover"
                onClick={() => {
                  onPick(item)
                }}
              >
                <span
                  aria-hidden
                  className="ws-cal-swatch"
                  style={{ background: LAYER_COLOR[item.source] }}
                />
                <Icon className="size-3.5 shrink-0 text-ws-muted-fg" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </WsCard>
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
      <div className="text-ws-read font-semibold">{item.title}</div>
      {item.notes === undefined ? null : (
        <ul className="list-disc pl-4 text-xs text-ws-bad">
          {item.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t border-ws-line pt-2.5">
        {href === undefined ? null : (
          <Link to={href} className="ws-btn ws-btn-primary ws-btn-sm">
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
