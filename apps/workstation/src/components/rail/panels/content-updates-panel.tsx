/**
 * WP406（私有 docs/107 §5）：第三栏「岗位更新」两个入口——
 * - 卡上「挑着看」开的（地址 `agentsws://content-updates/<岗位>`，在哪一页都开得到）；
 * - 「设定」里岗位层那一个标签（跟着当前岗位）。
 * 身体是同一个 `PositionUpdates`。
 */
import type { ReactNode } from 'react'
import { PositionUpdates } from '@/components/content-updates/position-updates'
import type { RailScope } from '@/components/rail/rail-scope'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { positionOfAddress } from '@/lib/content-digest-api'

export function ContentUpdatesPanel({ address, scope }: RailPanelBodyProps): ReactNode {
  const position = positionOfAddress(address)
  if (position === undefined) return null
  // 开着的正好是这个岗位：带上本人在这个岗位下的那条分配；不是就用当前那条
  const assignment =
    scope?.tier === 'position' && scope.scope_id === position ? scope.assignment : undefined
  return <PositionUpdates positionId={position} assignment={assignment} />
}

/** 「设定」里岗位层的「岗位更新」标签。 */
export function ContentUpdatesTab({ scope }: { scope: RailScope }): ReactNode {
  if (scope.tier !== 'position') return null
  return <PositionUpdates positionId={scope.scope_id} assignment={scope.assignment} />
}
