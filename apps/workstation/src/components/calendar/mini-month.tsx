/**
 * 左栏那个小月历（WP96，画布《日历 · 新风格》）。
 *
 * 它只做两件事：告诉人"现在在哪个月、今天是哪天"，以及点一天把主视图定位过去。
 * **不画事件**——小格子里塞点点只会变成一片噪声，事件在右边那一大块里。
 *
 * 周一起头（与 Schedule-X 的 `firstDayOfWeek: 1` 一致）；跨月那几格灰着，
 * 点得动（点了就翻到那一天）。
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

export function MiniMonth({
  anchor,
  onPick,
  onShiftMonth,
}: {
  anchor: Date
  onPick: (date: Date) => void
  onShiftMonth: (delta: number) => void
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
      ? anchor.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
      : `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`

  return (
    <div className="ws-card p-3" data-testid="calendar-mini-month">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="ws-display text-[14px]">{label}</span>
        <span className="flex gap-1">
          <button
            type="button"
            className="ws-go size-6"
            aria-label={t('calendar.month.prev')}
            onClick={() => {
              onShiftMonth(-1)
            }}
          >
            <ChevronLeft className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            className="ws-go size-6"
            aria-label={t('calendar.month.next')}
            onClick={() => {
              onShiftMonth(1)
            }}
          >
            <ChevronRight className="size-3" aria-hidden />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 justify-items-center gap-0.5">
        {weekdays.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 星期名会重（英文两个 T、两个 S），下标才是它的位置
          <span key={`${w}${i}`} className="text-[10.5px] text-ws-muted-fg">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const outside = d.getMonth() !== anchor.getMonth()
          const isToday = sameDay(d, today)
          const isAnchor = sameDay(d, anchor)
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
              className={`ws-num inline-flex size-[26px] items-center justify-center rounded-full text-[11.5px] ${
                isAnchor
                  ? 'bg-ws-brand font-semibold text-ws-brand-fg'
                  : isToday
                    ? 'bg-ws-tint text-ws-brand-ink'
                    : outside
                      ? 'text-ws-muted-fg/60'
                      : 'hover:bg-ws-surface'
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
