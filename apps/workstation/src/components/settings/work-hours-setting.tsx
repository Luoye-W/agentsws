/**
 * WP474（决策 1530）：「设置 → 通用」里的一行「我的作息」——工作时段、排不排周末、直播前后留空、避不避午饭。
 *
 * 只影响「帮我排进空档」给的候选（日历与待办那一页）。每人一份，默认 9:00–18:00、不排周末、直播前后 30 分钟、不避午饭。
 * 取不到（老服务进程没有这条路）就整行不出，不报错。
 */
import type { WorkHours } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings-panel/setting-row'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const KEY = ['settings', 'work-hours'] as const

const getWorkHours = (): Promise<WorkHours> => api<WorkHours>('/v1/settings/work-hours')
const putWorkHours = (next: WorkHours): Promise<WorkHours> =>
  api<WorkHours>('/v1/settings/work-hours', { method: 'PUT', body: next })

/** 0:00 … 24:00，半小时一档 */
const HALF_HOURS = Array.from({ length: 49 }, (_, i) => i * 30)
const BUFFERS = [0, 15, 30, 45, 60, 90, 120]

function hhmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
}

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm'

export function WorkHoursSetting(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const current = useQuery({ queryKey: KEY, queryFn: getWorkHours, retry: false })
  const save = useMutation({
    mutationFn: putWorkHours,
    onSuccess: (next) => {
      client.setQueryData(KEY, next)
    },
  })
  const h = current.data
  if (h === undefined) return null
  const set = (patch: Partial<WorkHours>): void => {
    const next = { ...h, ...patch }
    if (next.end_min <= next.start_min) return
    save.mutate(next)
  }
  return (
    <SettingRow
      testId="settings-work-hours"
      title={t('sp.work_hours')}
      desc={t('sp.work_hours.desc')}
      stacked
      control={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ws-body">
          <span className="flex items-center gap-1.5">
            <select
              className={SELECT}
              aria-label={t('sp.work_hours.start')}
              data-testid="work-hours-start"
              value={String(h.start_min)}
              disabled={save.isPending}
              onChange={(e) => {
                set({ start_min: Number(e.target.value) })
              }}
            >
              {HALF_HOURS.filter((m) => m < h.end_min).map((m) => (
                <option key={m} value={String(m)}>
                  {hhmm(m)}
                </option>
              ))}
            </select>
            <span className="text-ws-faint">–</span>
            <select
              className={SELECT}
              aria-label={t('sp.work_hours.end')}
              data-testid="work-hours-end"
              value={String(h.end_min)}
              disabled={save.isPending}
              onChange={(e) => {
                set({ end_min: Number(e.target.value) })
              }}
            >
              {HALF_HOURS.filter((m) => m > h.start_min).map((m) => (
                <option key={m} value={String(m)}>
                  {hhmm(m)}
                </option>
              ))}
            </select>
          </span>
          <label htmlFor="work-hours-weekends" className="flex items-center gap-2">
            <Switch
              id="work-hours-weekends"
              aria-label={t('sp.work_hours.weekends')}
              data-testid="work-hours-weekends"
              checked={h.weekends}
              disabled={save.isPending}
              onCheckedChange={(v) => {
                set({ weekends: v })
              }}
            />
            {t('sp.work_hours.weekends')}
          </label>
          <span className="flex items-center gap-1.5">
            {t('sp.work_hours.live')}
            <select
              className={SELECT}
              aria-label={t('sp.work_hours.live')}
              data-testid="work-hours-live"
              value={String(h.live_buffer_min)}
              disabled={save.isPending}
              onChange={(e) => {
                set({ live_buffer_min: Number(e.target.value) })
              }}
            >
              {BUFFERS.map((m) => (
                <option key={m} value={String(m)}>
                  {m === 0 ? t('sp.work_hours.live.none') : t('sp.work_hours.live.min', { n: m })}
                </option>
              ))}
            </select>
          </span>
          <label htmlFor="work-hours-lunch" className="flex items-center gap-2">
            <Switch
              id="work-hours-lunch"
              aria-label={t('sp.work_hours.lunch')}
              data-testid="work-hours-lunch"
              checked={h.avoid_lunch}
              disabled={save.isPending}
              onCheckedChange={(v) => {
                set({ avoid_lunch: v })
              }}
            />
            {t('sp.work_hours.lunch')}
          </label>
        </div>
      }
    />
  )
}
