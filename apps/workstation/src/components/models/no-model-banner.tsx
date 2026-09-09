/**
 * 「还没接模型」的黄条（WP25 交付 C）。
 *
 * 为什么要有它：没接模型时，工作台看着**一切正常**——卡片有、事项有、首页四格有，
 * 因为那些都是替身与历史数据。用户点"让 Agent 去处理"才发现它答非所问，
 * 而界面上一个字都没提"你还没接模型"。这条黄条就是补这个洞。
 *
 * 两条纪律：
 * 1. **配好就消失**：它只读 `has_key`，不读任何 key；接上一个能用的模型之后
 *    下一次 `invalidateQueries` 就不见了。
 * 2. **拿不到就不出现**：模型是所有者的事，客服岗位问这条路会 403——那就什么都不显示，
 *    而不是给他一条他点不动的提示。
 */
import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { getPositions, listModelProviders } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function NoModelBanner(): React.ReactNode {
  const { t } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const providers = useQuery({
    queryKey: ['model-providers', ownerId],
    enabled: ownerId !== undefined,
    // 不是所有者（403）就当作"这条提示不归我管"，静默不显示
    retry: false,
    queryFn: () => listModelProviders(ownerId),
  })

  if (providers.data === undefined) return null
  if (providers.data.providers.some((p) => p.active)) return null

  return (
    <p
      className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
      data-testid="no-model-banner"
      role="status"
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <span>
        {t('models.banner')}{' '}
        <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
          {t('models.banner.cta')}
        </Link>
      </span>
    </p>
  )
}
