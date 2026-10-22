/**
 * 左栏那个小月历（WP96，画布《日历 · 新风格》）。
 *
 * 它只做两件事：告诉人"现在在哪个月、今天是哪天"，以及点一天把主视图定位过去。
 * **不画事件**——小格子里塞点点只会变成一片噪声，事件在右边那一大块里。
 *
 * 周一起头（与 Schedule-X 的 `firstDayOfWeek: 1` 一致）；跨月那几格灰着，
 * 点得动（点了就翻到那一天）。
 *
 * WP456-T5（示意稿 `5-calendar`）：今天是品牌色实心圈；周视图下正在看的那一周整行一层浅底；
 * 定位到的那天（不是今天时）是淡品牌底。标题只写「10 月」——年份在页头大标题里。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useApp } from '@/lib/app-context'

const WEEKDAYS_ZH = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAYS_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/** 这一格网格的第一天：把 anchor 那个月的 1 号往回退到周一。 */
function gridStart(anchor: Date): Date {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  // JS 的 0 是周日；我们要周一起头
  const shift = (first.getDay() + 6) % 7
  return new Date(anchor.getFullYear(), anchor.getMonth(), 1 - shift)
}

/** 那一天所在那一周的周一（本地零点）。 */
function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
}

export function MiniMonth({
  anchor,
  onPick,
  onShiftMonth,
  highlightWeek = false,
}: {
  anchor: Date
  onPick: (date: Date) => void
  onShiftMonth: (delta: number) => void
  /** 周视图：把正在看的那一周整行标出来 */
  highlightWeek?: boolean
}): React.ReactNode {
  const { t, lang } = useApp()
  const today = new Date()
  const start = gridStart(anchor)
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
  const weekdays = lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH
  const label =
    lang === 'en'
      ? anchor.toLocaleDateString('en-US', { month: 'long' })
      : `${anchor.getMonth() + 1} 月`
  const week = mondayOf(anchor).getTime()

  return (
    <div className="ws-card px-3.5 pt-3.5 pb-2.5" data-testid="calendar-mini-month">
      <div className="flex items-center justify-between pb-1.5">
        <span className="text-ws-ui font-semibold">{label}</span>
        <span className="flex">
          <button
            type="button"
            className="ws-btn ws-btn-ghost size-6 p-0"
            aria-label={t('calendar.month.prev')}
            onClick={() => {
              onShiftMonth(-1)
            }}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="ws-btn ws-btn-ghost size-6 p-0"
            aria-label={t('calendar.month.next')}
            onClick={() => {
              onShiftMonth(1)
            }}
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {weekdays.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 星期名会重（英文两个 T、两个 S），下标才是它的位置
          <span key={`${w}${i}`} className="text-xs leading-6.5 text-ws-faint">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const outside = d.getMonth() !== anchor.getMonth()
          const isToday = sameDay(d, today)
          const isAnchor = sameDay(d, anchor)
          const inWeek = highlightWeek && mondayOf(d).getTime() === week
          return (
            <button
              key={d.toISOString()}
              type="button"
              data-testid="mini-day"
              data-today={isToday ? 'true' : undefined}
              data-selected={isAnchor ? 'true' : undefined}
              onClick={() => {
                onPick(d)
              }}
              data-week={inWeek ? 'true' : undefined}
              className={`ws-num h-6.5 rounded-full text-xs ${
                isToday
                  ? 'bg-ws-brand font-semibold text-ws-brand-fg'
                  : isAnchor
                    ? 'bg-ws-tint font-semibold text-ws-brand-ink'
                    : `${inWeek ? 'bg-ws-hover' : 'hover:bg-ws-hover'} ${
                        outside ? 'text-ws-faint' : 'text-ws-body'
                      }`
              }`}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
