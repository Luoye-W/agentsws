/**
 * WP323：「发出记录」图标上那个数——记录去处里**写不进去、待补写**的条数（0 不出：出问题才出声）。
 * 单独一个小文件：图标轨要画数，但不该为此把面板本体（`lazy()`）提前下载下来。
 */
import { useQuery } from '@tanstack/react-query'
import type { PanelBadge, RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { listSinks, SINKS_KEY } from '@/lib/outbound-api'

export function useOutboundBadge(_props: RailPanelBodyProps): PanelBadge | undefined {
  const { t } = useApp()
  const sinks = useQuery({ queryKey: SINKS_KEY, queryFn: listSinks, retry: false })
  const count = (sinks.data ?? [])
    .filter((s) => s.state === 'broken')
    .reduce((n, s) => n + s.pending, 0)
  return count === 0 ? undefined : { count, label: t('outbound.badge', { count }) }
}
