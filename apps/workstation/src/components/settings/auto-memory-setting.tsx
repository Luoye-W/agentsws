/**
 * WP320：「设置 → 通用」里的一行——「自动记忆」开关（默认开）。
 *
 * 开着：AI 边干活边记下稳定的偏好 / 纠正过的做法 / 长期不变的事实，记住时冒一句「记住了：……」；
 * 关了：只在人明确说「记住…」时才记。说明进问号（36 §7 少字）；老服务进程没有这条路就整行不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings-panel/setting-row'
import { Switch } from '@/components/ui/switch'
import { getAutoMemory, setAutoMemory } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const KEY = ['settings', 'auto-memory'] as const

export function AutoMemorySetting(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const current = useQuery({ queryKey: KEY, queryFn: getAutoMemory, retry: false })
  const save = useMutation({
    mutationFn: (enabled: boolean) => setAutoMemory(enabled),
    onSuccess: (next) => {
      client.setQueryData(KEY, next)
    },
  })
  if (current.data === undefined) return null
  return (
    <SettingRow
      testId="settings-auto-memory"
      title={t('settings.auto_memory')}
      desc={t('sp.auto_memory.desc')}
      hint={t('settings.auto_memory.hint')}
      control={
        <Switch
          aria-label={t('settings.auto_memory')}
          data-testid="settings-auto-memory-switch"
          checked={current.data.enabled}
          disabled={save.isPending}
          onCheckedChange={(v) => {
            save.mutate(v)
          }}
        />
      }
    />
  )
}
