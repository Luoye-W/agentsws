/**
 * WP144（docs/80 §5）：第三栏那一行——**AI 正在操作这台电脑 · 停止**。
 *
 * 与桌面壳托盘变红是同一件事的两处落点：人在工作台里也要一眼看见"现在有 AI 在动我的电脑"，
 * 而且一下就能停。3 秒问一次 `GET /v1/computer-use/active`；没在操作、服务没装配电脑操控
 * （501）、这个人看不了（403）时一个像素都不占。
 *
 * 用所有者那条岗位问（与设置页同一个口径：电脑操控是这台机器的事，不跟左栏选中的岗位走）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { clockOf } from '@/components/settings/computer-use-card'
import { Button } from '@/components/ui/button'
import { getComputerUseActive, getPositions, stopComputerUse } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ComputerUseStrip(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const owner = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const active = useQuery({
    queryKey: ['computer-use-active', owner],
    queryFn: () => getComputerUseActive(owner),
    enabled: owner !== undefined,
    retry: false,
    refetchInterval: 3000,
  })
  const stop = useMutation({
    mutationFn: () => stopComputerUse(owner),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['computer-use-active'] })
      await client.invalidateQueries({ queryKey: ['computer-use-settings'] })
    },
  })
  const run = active.data?.active
  if (run === undefined) return null
  return (
    <div
      role="status"
      className="fixed top-2 right-14 z-50 flex items-center gap-2 rounded-full border border-destructive/40 bg-background px-3 py-1 text-xs shadow-sm"
      data-testid="computer-use-strip"
    >
      <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden />
      <span>{t('cu.active', { until: clockOf(run.until) })}</span>
      <Button
        size="sm"
        variant="destructive"
        className="h-6 px-2 text-xs"
        disabled={stop.isPending}
        data-testid="computer-use-strip-stop"
        onClick={() => {
          stop.mutate()
        }}
      >
        {t('cu.stop')}
      </Button>
    </div>
  )
}
