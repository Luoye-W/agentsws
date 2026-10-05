/**
 * WP236：「设置 → 通用」里的一行——一次运行多久没动静算卡死、最多跑多久。
 *
 * 两个下拉、说明进问号（36 §7 少字）；取不到（老服务进程没有这条路）就整行不出，不报错。
 * 职责可以在自己的阈值里单独放长（研究类），这里是这台机器的缺省。
 */
import type { RunTimeLimits } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { api } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const KEY = ['settings', 'run-limits'] as const
/** 空闲线（分钟）与总时长（分钟）的可选档。 */
const IDLE_MIN = [1, 2, 3, 5, 10, 15, 30]
const MAX_MIN = [5, 10, 20, 30, 45, 60, 90, 120]

const getRunLimits = (): Promise<RunTimeLimits> => api('/v1/settings/run-limits')
const setRunLimits = (body: RunTimeLimits): Promise<RunTimeLimits> =>
  api('/v1/settings/run-limits', { method: 'PUT', body })

export function RunLimitsSetting(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const current = useQuery({ queryKey: KEY, queryFn: getRunLimits, retry: false })
  const save = useMutation({
    mutationFn: setRunLimits,
    onSuccess: (next) => {
      client.setQueryData(KEY, next)
    },
  })
  const data = current.data
  if (data === undefined) return null
  const idle = Math.round(data.idle_timeout_seconds / 60)
  const max = Math.round(data.max_duration_seconds / 60)
  const pick = (values: number[], v: number): number[] =>
    values.includes(v) ? values : [...values, v].sort((a, b) => a - b)
  return (
    <div className="flex items-center justify-between gap-2" data-testid="settings-run-limits">
      <span className="flex items-center gap-1">
        {t('settings.run_limits')}
        <Hint text={t('settings.run_limits.hint')} />
      </span>
      <span className="flex items-center gap-1 text-sm">
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          aria-label={t('settings.run_limits.idle')}
          data-testid="settings-run-limits-idle"
          value={String(idle)}
          disabled={save.isPending}
          onChange={(e) => {
            const v = Number(e.target.value) * 60
            save.mutate({
              idle_timeout_seconds: Math.min(v, data.max_duration_seconds),
              max_duration_seconds: data.max_duration_seconds,
            })
          }}
        >
          {pick(IDLE_MIN, idle).map((n) => (
            <option key={n} value={String(n)}>
              {t('settings.run_limits.idle_n', { n })}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          aria-label={t('settings.run_limits.max')}
          data-testid="settings-run-limits-max"
          value={String(max)}
          disabled={save.isPending}
          onChange={(e) => {
            const v = Number(e.target.value) * 60
            save.mutate({
              idle_timeout_seconds: Math.min(data.idle_timeout_seconds, v),
              max_duration_seconds: v,
            })
          }}
        >
          {pick(MAX_MIN, max).map((n) => (
            <option key={n} value={String(n)}>
              {t('settings.run_limits.max_n', { n })}
            </option>
          ))}
        </select>
      </span>
    </div>
  )
}
