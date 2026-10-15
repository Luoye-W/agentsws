/**
 * WP335（docs/99 §5.6，docs/96 决策 335「依据」）：第三栏的 **一条回答**——点看板方格的一格开
 * （`agentsws://geo-answer/<分配>/<回答 id>`）。不占图标轨（只按地址开），不离开那一页。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { GeoAnswerView } from '@/components/seo/geo-answer'
import { useApp } from '@/lib/app-context'
import { getGeoAnswer, parseGeoAnswerAddress } from '@/lib/geo-watch-api'

export function GeoAnswerPanel({ address }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const target = parseGeoAnswerAddress(address)
  const detail = useQuery({
    queryKey: ['geo-answer', target?.assignment, target?.answer_id],
    enabled: target !== undefined,
    queryFn: () => getGeoAnswer(target?.answer_id ?? '', target?.assignment),
  })
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="geo-answer-panel">
      {target === undefined || detail.isError ? (
        <p className="text-sm text-ws-muted-fg">{t('geo.answer.missing')}</p>
      ) : detail.data === undefined ? (
        <p className="text-sm text-ws-muted-fg">{t('geo.answer.loading')}</p>
      ) : (
        <GeoAnswerView detail={detail.data} />
      )}
    </div>
  )
}
