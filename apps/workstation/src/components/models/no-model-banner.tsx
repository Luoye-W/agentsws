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
import { NoticeLine } from '@/components/design/kit'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { getPositions, listModelProviders } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * WP98（09-18 收口）：首页第一屏不再让它占一整条。
 *
 * `banner` 是原样那条黄条（设置页还在用它——那一页本来就是来处理这件事的）；
 * `chip` 是顶栏上的一个黄色小胶囊，与模型 / 积分那两个芯片并排。
 * 判据一个字没改：仍旧只读 `has_key`，问不到就什么都不出。
 *
 * WP334（决策 726）：点了不再跳设置页——在第三栏开「接模型」那张连接卡（与开工向导第 ① 步同一个件，
 * key 走本机原生表单），就地接上；设置页仍在，是总览与管理。
 */
export type NoModelVariant = 'banner' | 'chip'

export function NoModelBanner({
  variant = 'banner',
}: {
  variant?: NoModelVariant
} = {}): React.ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
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

  if (variant === 'chip')
    return (
      <button
        type="button"
        title={`${t('models.banner')} ${t('models.banner.cta')}`}
        data-testid="no-model-chip"
        data-connect="model"
        className="flex items-center gap-1 rounded-full bg-ws-warn-bg px-2 py-1 text-xs font-medium text-ws-warn"
        onClick={() => {
          openConnect('model')
        }}
      >
        <TriangleAlert aria-hidden className="size-3.5" />
        <span className="max-w-32 truncate">{t('models.chip')}</span>
      </button>
    )

  // WP456-T2：一行提醒（浅底、黄图标、右边一个链接），不再是黄底带框的一条
  return (
    <NoticeLine
      data-testid="no-model-banner"
      role="status"
      action={{
        label: t('models.banner.cta'),
        data: { 'data-connect': 'model' },
        onClick: () => {
          openConnect('model')
        },
      }}
    >
      {t('models.banner')}
    </NoticeLine>
  )
}
