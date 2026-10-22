/**
 * WP476（决策 1590）：「设置 → 数据与隐私」里的一行——「帮助改进工坊（匿名使用数据）」开关（测试阶段默认开）。
 *
 * 一台机器一份。关了：工作台立刻停发、服务进程手上攒的也扔掉。说明进问号（36 §7 少字）；
 * 老服务进程没有这条路就整行不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings-panel/setting-row'
import { Switch } from '@/components/ui/switch'
import { getTelemetrySettings, putTelemetrySettings } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const TELEMETRY_KEY = ['settings', 'telemetry'] as const

export function TelemetrySetting(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const current = useQuery({ queryKey: TELEMETRY_KEY, queryFn: getTelemetrySettings, retry: false })
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      // 在这里改过开关 = 已经知道这件事了，第一次那句提示不再出
      putTelemetrySettings({ enabled, notice_seen: true }),
    onSuccess: (next) => {
      client.setQueryData(TELEMETRY_KEY, next)
    },
  })
  if (current.data === undefined) return null
  return (
    <SettingRow
      testId="settings-telemetry"
      title={t('telemetry.title')}
      desc={t('telemetry.desc')}
      hint={t('telemetry.hint')}
      control={
        <Switch
          aria-label={t('telemetry.title')}
          data-testid="settings-telemetry-switch"
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
