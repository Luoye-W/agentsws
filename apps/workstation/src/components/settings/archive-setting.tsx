/**
 * WP207：「设置 → 通用」里的一行——对话 / 任务超过几天没动就自动归档（1–30 天，或不自动归档）。
 *
 * 说明进问号（36 §7 少字）；取不到（老服务进程没有这条路）就整行不出，不报错。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { getWorkArchiveSettings, RAIL_KEY, setWorkArchiveSettings } from '@/lib/work-archive'

const KEY = ['settings', 'work-archive'] as const
const DAYS = Array.from({ length: 30 }, (_, i) => i + 1)

export function ArchiveSetting(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const current = useQuery({ queryKey: KEY, queryFn: getWorkArchiveSettings, retry: false })
  const save = useMutation({
    mutationFn: (idle_days: number | null) => setWorkArchiveSettings(idle_days),
    onSuccess: async (next) => {
      client.setQueryData(KEY, next)
      await client.invalidateQueries({ queryKey: RAIL_KEY })
    },
  })
  if (current.data === undefined) return null
  const value = current.data.idle_days === null ? 'never' : String(current.data.idle_days)
  return (
    <div className="flex items-center justify-between" data-testid="settings-archive">
      <span className="flex items-center gap-1">
        {t('settings.archive')}
        <Hint text={t('settings.archive.hint')} />
      </span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label={t('settings.archive')}
        data-testid="settings-archive-days"
        value={value}
        disabled={save.isPending}
        onChange={(e) => {
          save.mutate(e.target.value === 'never' ? null : Number(e.target.value))
        }}
      >
        {DAYS.map((n) => (
          <option key={n} value={String(n)}>
            {t('settings.archive.days', { n })}
          </option>
        ))}
        <option value="never">{t('settings.archive.never')}</option>
      </select>
    </div>
  )
}
