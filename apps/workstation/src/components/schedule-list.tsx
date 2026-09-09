/**
 * 25 §3「人看得见管得了」的最小版：岗位页「记录」Tab 下的一张定时任务列表。
 *
 * 只读 + 暂停 / 恢复两个动作。改时间、删除、看历史留给后面的定时任务页——
 * 这一版先让用户知道**机器在替他定时做哪几件事**，以及能不能一键停掉。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getSchedules, patchSchedule, type ScheduledTaskRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'

/** 触发器 → 一句人话。cron 不翻译成自然语言（会翻错），原样给但标出时区。 */
export function triggerText(trigger: ScheduledTaskRow['trigger']): string {
  if (trigger.kind === 'cron') return `cron ${String(trigger.expr)}（${String(trigger.tz)}）`
  if (trigger.kind === 'interval') {
    const minutes = Math.round((trigger.every_ms ?? 0) / 60000)
    return `每 ${minutes} 分钟`
  }
  if (trigger.kind === 'once') return `一次：${String(trigger.at)}`
  return trigger.kind
}

export function ScheduleList({ positionId }: { positionId: string }): React.ReactNode {
  const { t, lang } = useApp()
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ['schedules', positionId],
    queryFn: () => getSchedules(positionId),
  })
  const toggle = useMutation({
    mutationFn: (input: { id: string; action: 'pause' | 'resume' }) =>
      patchSchedule(input.id, { action: input.action }, positionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedules', positionId] })
    },
  })

  if (list.isPending) return <Skeleton className="h-24 w-full" />
  const rows = list.data ?? []

  return (
    <section data-testid="schedule-list">
      <h3 className="mb-2 text-sm font-medium">{t('schedule.title')}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('schedule.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const paused = row.state === 'paused'
            return (
              <li
                key={row.id}
                data-testid="schedule-row"
                data-state={row.state}
                className="flex items-start justify-between gap-3 border-l pl-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm">{row.title ?? row.handler ?? row.id}</span>
                    {paused ? <Badge variant="secondary">{t('schedule.paused')}</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {triggerText(row.trigger)}
                    {row.next_fire_at === undefined
                      ? ''
                      : ` · ${t('schedule.next')} ${formatDate(row.next_fire_at, lang)}`}
                    {row.fire_count === 0
                      ? ''
                      : ` · ${t('schedule.ran', { n: String(row.fire_count) })}`}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={toggle.isPending}
                  aria-label={paused ? t('schedule.resume') : t('schedule.pause')}
                  onClick={() => {
                    toggle.mutate({ id: row.id, action: paused ? 'resume' : 'pause' })
                  }}
                >
                  {paused ? (
                    <Play className="size-4" aria-hidden />
                  ) : (
                    <Pause className="size-4" aria-hidden />
                  )}
                  {paused ? t('schedule.resume') : t('schedule.pause')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
