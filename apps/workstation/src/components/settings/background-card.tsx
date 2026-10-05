/**
 * WP215：设置 → 通用里的「后台」一张小卡。
 *
 * 后台（巡检、收信、每日计划 / 复盘、自动化任务……）按品牌常驻，与眼前切在哪个品牌无关。
 * 这张卡只管一件事：**全进程同时最多跑几件**（1–4；品牌之间并行，同一品牌永远一件接一件）。
 * 再加一句必须一眼可见的限制：后台跟着这台电脑走——关机、睡眠、断网时所有品牌都停。
 *
 * 每个品牌在跑几条、停没停，看顶栏切换器与公司页「品牌一览」那一格，这里不重复。
 * 与模型 key 同一档权限（所有者）；取不到（老服务进程没有这条路 / 没权限）就整张不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Laptop, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { getBackgroundSettings, setBackgroundSettings } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function BackgroundCard({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['settings', 'background', assignment] as const
  const current = useQuery({
    queryKey: key,
    queryFn: () => getBackgroundSettings(assignment),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (max_concurrent: number) => setBackgroundSettings({ max_concurrent }, assignment),
    onSuccess: (next) => {
      client.setQueryData(key, next)
    },
  })
  if (current.data === undefined) return null
  const { min, max } = current.data.limits
  const options = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i)
  return (
    <Card data-testid="settings-background">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Timer aria-hidden className="size-4" />
          {t('settings.background')}
          <Hint text={t('settings.background.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1">
            {t('settings.background.concurrency')}
            <Hint text={t('settings.background.concurrency.hint')} />
          </span>
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label={t('settings.background.concurrency')}
            data-testid="settings-background-concurrency"
            value={String(current.data.max_concurrent)}
            disabled={save.isPending}
            onChange={(e) => {
              save.mutate(Number(e.target.value))
            }}
          >
            {options.map((n) => (
              <option key={n} value={String(n)}>
                {t('settings.background.concurrency.n', { n })}
              </option>
            ))}
          </select>
        </div>
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="settings-background-device"
        >
          <Laptop aria-hidden className="size-3.5 shrink-0" />
          {t('settings.background.device')}
        </p>
      </CardContent>
    </Card>
  )
}
