/**
 * 日历（37 C3）：**既是视图也是排期面**。
 *
 * 显示四类来源：会议 / 有排期的待办 / 定时任务 / 卡片到期。
 * 把待办从待办箱拖到某一天，就是写 `Todo.scheduled`——这一页只发 `POST /v1/todos/:id/schedule`，
 * 时段由服务端的日界线决定，前端只给「哪一天」。
 */
import type { CalendarItem } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { MeetDialog } from '@/components/secretary/meet-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getCalendar, listPeople, scheduleTodo } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { addDays, dayKey, groupByDay, hhmm, startOfMonthGrid, startOfWeek } from '@/lib/work'
import { TODO_DRAG_TYPE } from '@/pages/todos'

type View = 'week' | 'month'

/** 四类来源各一个底色，好一眼分开（不是图表，就是背景色）。 */
const SOURCE_TONE: Record<string, string> = {
  meeting: 'bg-chart-1/20',
  todo: 'bg-muted',
  scheduled_task: 'bg-chart-4/20',
  card_due: 'bg-destructive/10',
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 拖进来的那一天默认排 09:00–10:00（本地时间）。 */
const SLOT_START_HOUR = 9
const SLOT_HOURS = 1

function slotFor(day: Date): { start: string; end: string } {
  const start = new Date(day)
  start.setHours(SLOT_START_HOUR, 0, 0, 0)
  const end = new Date(start)
  end.setHours(start.getHours() + SLOT_HOURS)
  return { start: start.toISOString(), end: end.toISOString() }
}

function DayCell({
  day,
  items,
  onDropTodo,
  compact,
}: {
  day: Date
  items: CalendarItem[]
  onDropTodo: (todoId: string, day: Date) => void
  compact: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [over, setOver] = useState(false)
  const key = dayKey(day.toISOString())
  const today = dayKey(new Date().toISOString()) === key
  return (
    <td
      aria-label={key}
      data-testid="calendar-day"
      data-day={key}
      data-over={over ? 'true' : 'false'}
      className={[
        'h-24 rounded-md border p-1.5 align-top text-xs',
        today ? 'border-primary/50 bg-primary/5' : '',
        over ? 'ring-2 ring-primary/60' : '',
      ].join(' ')}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => {
        setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData(TODO_DRAG_TYPE) || e.dataTransfer.getData('text/plain')
        if (id !== '') onDropTodo(id, day)
      }}
    >
      <div className="flex h-full flex-col gap-1 overflow-hidden">
        <div className="flex items-baseline justify-between">
          <span className="font-medium tabular-nums">{day.getDate()}</span>
          {today ? <span className="text-[10px] text-primary">{t('calendar.today')}</span> : null}
        </div>
        {items.slice(0, compact ? 2 : 4).map((item) => (
          <div
            key={item.id}
            data-testid="calendar-item"
            data-source={item.source}
            className={`truncate rounded px-1 py-0.5 ${SOURCE_TONE[item.source]}`}
            title={item.title}
          >
            {item.all_day ? '' : `${hhmm(item.start)} `}
            {item.title}
          </div>
        ))}
        {items.length > (compact ? 2 : 4) ? (
          <span className="text-[10px] text-muted-foreground">
            +{items.length - (compact ? 2 : 4)}
          </span>
        ) : null}
      </div>
    </td>
  )
}

export function CalendarPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [view, setView] = useState<View>('week')
  const [anchor, setAnchor] = useState(() => new Date())
  // 41 §1.2：约别人 = 向对方秘书发一张卡，对方点头才进双方日历
  const [meeting, setMeeting] = useState(false)

  const start = view === 'week' ? startOfWeek(anchor) : startOfMonthGrid(anchor)
  const dayCount = view === 'week' ? 7 : 42
  const end = addDays(start, dayCount)
  const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i))
  const weeks = Array.from({ length: dayCount / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))

  const calendar = useQuery({
    queryKey: ['calendar', start.toISOString(), dayCount],
    queryFn: () => getCalendar(start.toISOString(), end.toISOString()),
  })

  const people = useQuery({
    queryKey: ['secretary', 'people'],
    enabled: meeting,
    queryFn: listPeople,
  })

  const schedule = useMutation({
    mutationFn: (input: { id: string; day: Date }) => scheduleTodo(input.id, slotFor(input.day)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['calendar'] })
      void client.invalidateQueries({ queryKey: ['todos'] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  const byDay = groupByDay(calendar.data?.items ?? [])

  return (
    <div className="flex flex-col gap-4" data-testid="calendar" data-view={view}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">{t('calendar.title')}</h1>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('calendar.prev')}
            onClick={() => {
              setAnchor(addDays(anchor, view === 'week' ? -7 : -28))
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
              setAnchor(addDays(anchor, view === 'week' ? 7 : 28))
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
          {(['week', 'month'] as View[]).map((v) => (
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

      {calendar.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : calendar.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error.generic')}：{calendar.error.message}
        </p>
      ) : (
        // 月 / 周格子用真表格：它本来就是二维时间表，语义与无障碍都对得上
        <table className="w-full table-fixed border-separate border-spacing-1.5">
          <caption className="sr-only">{t('calendar.title')}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col" className="pb-1 text-xs font-normal text-muted-foreground">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]?.toISOString()}>
                {week.map((day) => (
                  <DayCell
                    key={day.toISOString()}
                    day={day}
                    items={byDay.get(dayKey(day.toISOString())) ?? []}
                    compact={view === 'month'}
                    onDropTodo={(id, target) => {
                      schedule.mutate({ id, day: target })
                    }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
