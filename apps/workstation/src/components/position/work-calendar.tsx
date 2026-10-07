/**
 * WP241「工作」的日历视图（月 / 周）：**只看这个岗位**的工作项，按截止 / 下次时间落在哪天。
 *
 * 与左栏「日历」那一页不是一个东西：那一页是全部图层（会议、别的岗位…），这里只放
 * 这个岗位的事项 / 待办 / 定时 / 排期——日历在岗位页上只是「工作」的一种看法。
 */
import type { PositionWorkGroup, PositionWorkItem } from '@agentsws/contracts'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { WsTag } from '@/components/design'
import { useApp } from '@/lib/app-context'
import { localDay } from '@/lib/position-work'

const DAY_MS = 86_400_000
const MAX_PER_DAY_MONTH = 3

const BAR: Record<PositionWorkGroup, string> = {
  doing: 'border-l-ws-good',
  stuck: 'border-l-ws-warn',
  queued: 'border-l-ws-muted-fg',
  waiting: 'border-l-ws-info',
  done: 'border-l-ws-good line-through text-ws-muted-fg',
}

/** 这一天所在那周的周一（本地时区）。 */
function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const back = (out.getDay() + 6) % 7
  out.setDate(out.getDate() - back)
  return out
}

function Chip({ item }: { item: PositionWorkItem }): ReactNode {
  const body = (
    <span
      className={`block truncate rounded-sm border-l-2 bg-ws-surface px-1.5 py-0.5 text-[11.5px] ${BAR[item.group]}`}
      title={item.title}
      data-testid="work-cal-item"
      data-id={item.id}
    >
      {item.title}
    </span>
  )
  return item.matter_id === undefined ? (
    body
  ) : (
    <Link to={`/matters/${encodeURIComponent(item.matter_id)}`} className="block hover:opacity-80">
      {body}
    </Link>
  )
}

export function WorkCalendar({
  items,
  mode,
  now,
  onMode,
}: {
  items: readonly PositionWorkItem[]
  mode: 'month' | 'week'
  now: Date
  onMode(mode: 'month' | 'week'): void
}): ReactNode {
  const { t, lang } = useApp()
  const [anchor, setAnchor] = useState(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  )
  const byDay = new Map<string, PositionWorkItem[]>()
  for (const i of items) {
    if (i.due_at === undefined) continue
    const k = localDay(i.due_at)
    byDay.set(k, [...(byDay.get(k) ?? []), i])
  }
  const undated = items.filter((i) => i.due_at === undefined).length

  const start =
    mode === 'week'
      ? mondayOf(anchor)
      : mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
  const days: Date[] = []
  const count =
    mode === 'week'
      ? 7
      : (() => {
          const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
          const end = mondayOf(last).getTime() + 7 * DAY_MS
          return Math.round((end - start.getTime()) / DAY_MS)
        })()
  for (let k = 0; k < count; k += 1)
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k))

  const shift = (dir: 1 | -1): void => {
    setAnchor(
      mode === 'week'
        ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * dir)
        : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1),
    )
  }
  const today = localDay(now)
  const weekdays = ['一', '二', '三', '四', '五', '六', '日']
  const weekdaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div
      className="overflow-hidden rounded-xl border bg-card"
      data-testid="work-calendar"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          aria-label={t('pos2.cal.prev')}
          className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
          onClick={() => {
            shift(-1)
          }}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t('pos2.cal.next')}
          className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
          onClick={() => {
            shift(1)
          }}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <h4 className="ws-display text-[16px]" data-testid="work-cal-title">
          {t('pos2.cal.title', { y: anchor.getFullYear(), m: anchor.getMonth() + 1 })}
        </h4>
        <WsTag>{t('pos2.cal.only')}</WsTag>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="h-7 rounded-md border px-2 text-xs hover:bg-accent"
            onClick={() => {
              setAnchor(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
            }}
          >
            {t('pos2.cal.today')}
          </button>
          <span className="inline-flex rounded-md border p-0.5 text-xs">
            {(['month', 'week'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                data-testid={`work-cal-${m}`}
                className={`rounded px-2 py-0.5 ${mode === m ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
                onClick={() => {
                  onMode(m)
                }}
              >
                {t(`pos2.cal.${m}`)}
              </button>
            ))}
          </span>
        </span>
      </div>
      <div className="grid grid-cols-7 border-b text-center text-xs text-ws-muted-fg">
        {(lang === 'en' ? weekdaysEn : weekdays).map((w) => (
          <div key={w} className="py-1.5">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = localDay(d)
          const list = byDay.get(key) ?? []
          const out = mode === 'month' && d.getMonth() !== anchor.getMonth()
          const shown = mode === 'month' ? list.slice(0, MAX_PER_DAY_MONTH) : list
          return (
            <div
              key={key}
              data-testid="work-cal-day"
              data-day={key}
              className={`flex flex-col gap-1 border-r border-b p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0 ${mode === 'month' ? 'min-h-[92px]' : 'min-h-[220px]'} ${key === today ? 'bg-ws-brand-soft/40' : ''}`}
            >
              <span
                className={`ws-num w-fit text-xs ${key === today ? 'rounded-full bg-ws-brand px-1.5 text-background' : out ? 'text-ws-muted-fg/60' : 'text-ws-muted-fg'}`}
              >
                {d.getDate()}
              </span>
              {shown.map((i) => (
                <Chip key={i.id} item={i} />
              ))}
              {list.length > shown.length ? (
                <span className="text-[11px] text-ws-muted-fg">
                  {t('pos2.cal.more', { n: list.length - shown.length })}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
      {undated === 0 ? null : (
        <p className="px-3 py-2 text-xs text-ws-muted-fg" data-testid="work-cal-undated">
          {t('pos2.cal.nodate', { n: undated })}
        </p>
      )}
    </div>
  )
}
