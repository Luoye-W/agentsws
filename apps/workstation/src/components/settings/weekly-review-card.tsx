/**
 * WP224（docs/91 §2.2 #1）：设置 → 通用里「经营一页纸」一行——秘书每周几、几点推。
 *
 * 只改这个品牌那一条定时（多品牌时每个品牌各一份，各改各的）。WP388：默认周一 16:30（工作区时区）出上一周的。
 * 与「后台」那张卡同一档权限（所有者）；取不到就整张不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { getWeeklyReviewSchedule, setWeeklyReviewSchedule } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { WeeklyTimePicker } from './weekly-time-picker'

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
      <CardContent>
        <WeeklyTimePicker
          weekday={weekday}
          time={time}
          disabled={save.isPending}
          testId="settings-weekly-review"
          onChange={(next) => save.mutate(next)}
        />
      </CardContent>
    </Card>
  )
}
