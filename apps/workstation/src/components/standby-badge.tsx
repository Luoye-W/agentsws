/**
 * 顶栏角标：**值守中：云上运行**（48 L6 / L7，WP60）。
 *
 * 它回答的是一个用户真的会问的问题：**我关了这台电脑，还有人接活吗？**
 *
 * 所以判据不是"这台电脑连的是哪台服务器"，而是"服务进程在不在云上"——
 * 两者在值守档里恰好是同一件事（48 L6：同一时刻只有一个服务进程），
 * 但写成前者的话，一个连公司 NAS 的员工也会看到这个角标，而那台 NAS
 * 关了照样什么都不接。
 *
 * 没开值守就什么都不画。一个常驻的灰角标写着"未开通"，是在每个人的顶栏上
 * 挂一条广告。
 */
import { useQuery } from '@tanstack/react-query'
import { Wifi } from 'lucide-react'
import { getPositions, getStandby } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 状态问得不用勤：它一天变不了两次。 */
const REFRESH_MS = 60_000

/**
 * 不收任何 props：顶栏那一行只该是 `<StandbyBadge />`。
 *
 * 值守是**工作区**级的事（05 common.owner 那一格），与左栏当前选中哪个岗位无关，
 * 所以这里跟连接页一样显式用所有者那条 Assignment，而不是跟着选中的岗位走。
 */
export function StandbyBadge(): React.ReactNode {
  const { t } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const assignment = positions.data?.positions.find(
    (p) => p.role_id === 'common.owner',
  )?.position_id
  const standby = useQuery({
    queryKey: ['standby-badge', assignment],
    enabled: assignment !== undefined,
    queryFn: () => getStandby(assignment),
    refetchInterval: REFRESH_MS,
    // 顶栏上的一个角标不值得让整个页面等它
    retry: false,
  })

  const status = standby.data?.cloud?.status
  if (status !== 'running' && status !== 'starting') return null

  return (
    <span
      data-testid="standby-badge"
      title={t('standby.badge.hint')}
      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
    >
      <Wifi className="size-3" aria-hidden />
      {status === 'running' ? t('standby.badge') : t('standby.badge.starting')}
    </span>
  )
}
