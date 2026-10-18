/**
 * WP390：右栏「工坊服务」那张卡的标题行（「2 单在做」，有在等你的亮黄点）。图标轨也读它，所以单独一个轻文件
 * （不把面板身体拉下来，WP95 #6）。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { listWorkshopOrders, WORKSHOP_ORDERS_KEY, waitsForYou } from '@/lib/workshop-services-api'

export const useWorkshopOrders = (status: 'open' | 'all' = 'open') =>
  useQuery({
    queryKey: [...WORKSHOP_ORDERS_KEY, 'list', status],
    queryFn: () => listWorkshopOrders(status),
    retry: false,
    // 读一次服务端就去云上看一遍：图标轨那个点别每次挂载都敲
    staleTime: 60_000,
  })

export function useWorkshopServicesStatus(
  _props: RailPanelBodyProps,
  detail: boolean,
): { summary?: string; dot?: 'attention'; dotLabel?: string } | undefined {
  const { t } = useApp()
  const orders = useWorkshopOrders('open')
  const rows = orders.data?.orders ?? []
  const waiting = rows.filter((r) => waitsForYou(r.order.status) || r.card_id !== undefined).length
  if (rows.length === 0) return undefined
  return {
    ...(detail ? { summary: t('svc.list.open', { n: String(rows.length) }) } : {}),
    ...(waiting > 0
      ? { dot: 'attention' as const, dotLabel: t('svc.list.waiting', { n: String(waiting) }) }
      : {}),
  }
}
