/**
 * WP224（docs/91 §2.2 #1）：设置 → 通用里「经营一页纸」一行——秘书每周几、几点推。
 *
 * 只改这个品牌那一条定时（多品牌时每个品牌各一份，各改各的）。默认周一 08:00（工作区时区）。
 * 与「后台」那张卡同一档权限（所有者）；取不到就整张不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { getWeeklyReviewSchedule, setWeeklyReviewSchedule } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 周一在前（cron 的 0 是周日）。 */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const

export function WeeklyReviewCard({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['settings', 'weekly-review', assignment] as const
  const current = useQuery({
    queryKey: key,
    queryFn: () => getWeeklyReviewSchedule(assignment),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (input: { weekday: number; time: string }) =>
      setWeeklyReviewSchedule(input, assignment),
    onSuccess: (next) => {
      client.setQueryData(key, next)
    },
  })
  if (current.data === undefined || current.data.missing === true) return null
  const { weekday, time } = current.data
  return (
    <Card data-testid="settings-weekly-review">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <FileText aria-hidden className="size-4" />
          {t('settings.weekly_review')}
          <Hint text={t('settings.weekly_review.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2 text-sm">
        <span>{t('settings.weekly_review.every')}</span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          aria-label={t('settings.weekly_review.weekday')}
          data-testid="settings-weekly-review-weekday"
          value={String(weekday)}
          disabled={save.isPending}
          onChange={(e) => {
            save.mutate({ weekday: Number(e.target.value), time })
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
          data-testid="settings-weekly-review-time"
          value={time}
          disabled={save.isPending}
          onChange={(e) => {
            if (/^\d{2}:\d{2}$/.test(e.target.value)) save.mutate({ weekday, time: e.target.value })
          }}
        />
      </CardContent>
    </Card>
  )
}
