/** WP335：看板几块共用的小件（百分比、比上一期的小箭头、站点类型小标）。 */
import type { CitedSiteKind } from '@agentsws/contracts'
import type { ReactNode } from 'react'
import { DeltaPill, WsTag } from '@/components/design'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 百分比（0–1 → 「38%」）；没有数是「—」。 */
export const pct = (v: number | undefined): string =>
  v === undefined ? '—' : `${Math.round(v * 100)}%`

/** 行尾 / 格里那个小箭头（比上一期好 / 差；没比就不画）。 */
export function ChangeMark({ change }: { change: 'up' | 'down' | undefined }): ReactNode {
  const { t } = useApp()
  if (change === undefined) return null
  const label = t(change === 'up' ? 'geo.change.up' : 'geo.change.down')
  return (
    <span title={label} data-testid="geo-change" data-change={change}>
      <DeltaPill direction={change}>
        <span className="sr-only">{label}</span>
      </DeltaPill>
    </span>
  )
}

/** 站点类型小标（我们加粗绿、竞品橙，其余灰）。 */
export function KindTag({ kind }: { kind: CitedSiteKind }): ReactNode {
  const { t } = useApp()
  return (
    <WsTag
      data-slot="badge"
      className={cn(
        'h-[18px] shrink-0 whitespace-nowrap px-1.5 text-xs',
        kind === 'ours' && 'bg-ws-good-bg font-medium text-ws-good',
        kind === 'competitor' && 'bg-ws-warn-bg text-ws-warn',
      )}
    >
      {t(`geo.kind.${kind}`)}
    </WsTag>
  )
}
