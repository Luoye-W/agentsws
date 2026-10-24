/**
 * WP119c / WP131：**插件深链的落点**（docs/76 §10）——插件版本里写死了这几条，路由要长期留着。
 *
 * WP504（决策 1765「资料在右、决策在中」、1778 A）：红人库搬进红人营销岗位的第三栏，这两条路改成**跳转**：
 *
 * - `/influencer/creators?creator=<handle|id>` → 岗位页 `?panel=kol-library&creator=…`：开红人库、叠开那个人（认 handle 也认 id）；
 * - `/influencer/creators?batch=<bt_…>[&channel=…]`（插件「回作战室看这批」）→ 库里带「这一批」筛选签，
 *   带了 `channel` 就落到那条渠道的职责上；
 * - `/influencer/setup` → 开到「活动」那一格；老的 `?kol=threads` → 「合作」那一格。
 *
 * 落到哪个岗位页：带了 `channel` 先找那条渠道的红人职责，找不到退回第一条（与原来一样）；
 * 一条红人职责都没有就跳首页、照样开那一格——面板照实说「还没有红人营销岗位」。
 */
import { useQuery } from '@tanstack/react-query'
import { Navigate, useSearchParams } from 'react-router-dom'
import { KOL_LIBRARY } from '@/components/kol/kol-library-status'
import { channelOfRole } from '@/components/kol/kol-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositions } from '@/lib/api'

/** 跳到哪（纯函数，测试用）。 */
export function influencerTarget(
  positions: readonly { position_id: string; role_id: string }[],
  search: URLSearchParams,
  setup: boolean,
): string {
  const wanted = search.get('channel')
  const kols = positions.filter((p) => channelOfRole(p.role_id) !== undefined)
  const kol = kols.find((p) => wanted !== null && channelOfRole(p.role_id) === wanted) ?? kols[0]
  const next = new URLSearchParams()
  next.set('panel', KOL_LIBRARY)
  const view = search.get('kol')
  next.set(
    'tab',
    setup || view === 'campaign' ? 'campaign' : view === 'threads' ? 'collab' : 'creators',
  )
  for (const key of ['creator', 'batch'] as const) {
    const v = search.get(key)
    if (v !== null && v !== '') next.set(key, v)
  }
  const channel = kol === undefined ? undefined : channelOfRole(kol.role_id)
  if (channel !== undefined) next.set('channel', channel)
  const base = kol === undefined ? '/' : `/positions/${encodeURIComponent(kol.position_id)}`
  return `${base}?${next.toString()}`
}

export function InfluencerPage({ setup = false }: { setup?: boolean }): React.ReactNode {
  const [search] = useSearchParams()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  if (positions.isPending)
    return (
      <div className="flex flex-col gap-3" data-testid="influencer-redirecting">
        <Skeleton className="h-8 w-64" />
      </div>
    )
  return <Navigate replace to={influencerTarget(positions.data?.positions ?? [], search, setup)} />
}
