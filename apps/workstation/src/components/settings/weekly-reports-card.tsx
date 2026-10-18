/**
 * WP388（docs/103 S3 / T2）：设置 → 通知「周报时间」——系统自带的周复盘、SEO 周报每周几、几点出。
 *
 * 和「经营一页纸」那一行同一个选择（`WeeklyTimePicker`）；默认周一 16:30（工作区时区）出上一周的。
 * 跟 AI 说一声也能改（「改设置」卡，设置目标 `schedule.weekly_reports`）。
 * 周复盘每个岗位一条：这里一起改本人在这个品牌里的那几条。一条都没有的那一份不出；两份都没有整张不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getMyWeeklyReportSchedules, type ScheduledTaskRow, setWeeklyCron } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { WeeklyTimePicker } from './weekly-time-picker'

/** 一条周定时的「周几、几点」（不是简单周定时的回 `undefined`：那一行不出）。 */
export function weeklyOf(row: ScheduledTaskRow): { weekday: number; time: string } | undefined {
  if (row.trigger.kind !== 'cron' || row.trigger.expr === undefined) return undefined
  const [mm, hh, dom, mon, dow] = row.trigger.expr.trim().split(/\s+/)
  if (dom !== '*' || mon !== '*' || !/^\d$/.test(dow ?? '')) return undefined
  if (!/^\d+$/.test(mm ?? '') || !/^\d+$/.test(hh ?? '')) return undefined
  const pad = (n: string | undefined) => String(Number(n)).padStart(2, '0')
  return { weekday: Number(dow) % 7, time: `${pad(hh)}:${pad(mm)}` }
}

const KINDS = ['review_week', 'seo_weekly'] as const

export function WeeklyReportsCard({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['settings', 'weekly-reports', assignment] as const
  const current = useQuery({
    queryKey: key,
    queryFn: () => getMyWeeklyReportSchedules(assignment),
    retry: false,
  })
  const save = useMutation({
    mutationFn: async (input: {
      rows: ScheduledTaskRow[]
      next: { weekday: number; time: string }
    }) => {
      for (const row of input.rows) await setWeeklyCron(row, input.next, assignment)
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  })
  if (current.data === undefined) return null
  const rows = KINDS.flatMap((k) => {
    const list = current.data[k]
    const first = list[0]
    const value = first === undefined ? undefined : weeklyOf(first)
    return value === undefined ? [] : [{ k, list, value }]
  })
  if (rows.length === 0) return null
  return (
    <Card data-testid="settings-weekly-reports">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <CalendarClock aria-hidden className="size-4" />
          {t('settings.weekly_reports')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(({ k, list, value }) => (
          <div key={k} className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-sm">{t(`settings.weekly_reports.${k}`)}</span>
            <WeeklyTimePicker
              weekday={value.weekday}
              time={value.time}
              disabled={save.isPending}
              testId={`settings-weekly-${k}`}
              onChange={(next) => save.mutate({ rows: list, next })}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
