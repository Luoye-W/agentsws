/**
 * WP388：「每 [周一] [16:30] 出上周 (?)」——周报类定时的星期几 / 几点（经营一页纸、周复盘、SEO 周报共用）。
 *
 * 可见的只有这一句；问号里是为什么默认周一（美国那边上一周刚结束、数据也到齐了；想换时间跟我说一声）。
 * 周一到周三出的是上一周，周四起出的是这一周到现在（与服务端 `reportWeek` 同一条线）。
 */
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

/** 周一在前（cron 的 0 是周日）。 */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const

/** 周一到周三出的是上一周（同服务端 `LAST_WEEK_BEFORE_DOW`）。 */
export const coversLastWeek = (weekday: number): boolean => weekday >= 1 && weekday <= 3

export function WeeklyTimePicker({
  weekday,
  time,
  disabled,
  testId,
  onChange,
}: {
  weekday: number
  time: string
  disabled?: boolean
  /** `<testId>-weekday` / `<testId>-time` */
  testId: string
  onChange(next: { weekday: number; time: string }): void
}): ReactNode {
  const { t } = useApp()
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t('settings.weekly_review.every')}</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label={t('settings.weekly_review.weekday')}
        data-testid={`${testId}-weekday`}
        value={String(weekday)}
        disabled={disabled}
        onChange={(e) => {
          onChange({ weekday: Number(e.target.value), time })
        }}
      >
        {WEEKDAYS.map((d) => (
          <option key={d} value={String(d)}>
            {t(`settings.weekly_review.day.${d}`)}
          </option>
        ))}
      </select>
      <input
        type="time"
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label={t('settings.weekly_review.time')}
        data-testid={`${testId}-time`}
        value={time}
        disabled={disabled}
        onChange={(e) => {
          if (/^\d{2}:\d{2}$/.test(e.target.value)) onChange({ weekday, time: e.target.value })
        }}
      />
      <span data-testid={`${testId}-covers`}>
        {t(coversLastWeek(weekday) ? 'settings.weekly.last_week' : 'settings.weekly.this_week')}
      </span>
      <Hint text={t('settings.weekly.why')} testId={`${testId}-why`} />
    </span>
  )
}
