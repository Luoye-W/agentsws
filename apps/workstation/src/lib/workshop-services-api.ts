/**
 * WP390（docs/105）：「工坊服务」的本机接口——目录（本机缓存）、看看 / 交给工坊办、不用、订单面板。
 *
 * 下单 / 验收 / 交换联系方式都走卡（`service_order`，永远 L1）：批卡还是 `decide`，这里一个花钱的口都没有。
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 */
import type {
  ServiceOffer,
  ServiceOrderMessage,
  ServiceOrderStatus,
  ServiceOrderView,
  ServiceView,
  WorkshopServiceCatalogView,
  WorkshopServiceOrderDetail,
  WorkshopServiceOrdersView,
  WorkshopServiceReplyDraft,
  WorkshopServiceStartInput,
  WorkshopServiceStartResult,
} from '@agentsws/contracts'
import { SERVICE_ORDER_TERMINAL_STATUSES } from '@agentsws/contracts'
import { api } from './api'

export type {
  ServiceOffer,
  ServiceOrderMessage,
  ServiceOrderView,
  ServiceView,
  WorkshopServiceCatalogView,
  WorkshopServiceOrderDetail,
  WorkshopServiceOrdersView,
}

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

export const WORKSHOP_SERVICES_KEY = ['workshop-services'] as const
export const WORKSHOP_ORDERS_KEY = ['workshop-services', 'orders'] as const

export const listWorkshopServices = (
  refresh = false,
  assignment?: string,
): Promise<WorkshopServiceCatalogView> =>
  api(`/v1/workshop-services${refresh ? '?refresh=1' : ''}`, as(assignment))

export const startWorkshopService = (
  input: WorkshopServiceStartInput,
  assignment?: string,
): Promise<WorkshopServiceStartResult> =>
  api('/v1/workshop-services/start', { method: 'POST', body: input, ...as(assignment) })

export const declineWorkshopService = (
  service_id: string,
  assignment?: string,
): Promise<{ until: string }> =>
  api('/v1/workshop-services/decline', { method: 'POST', body: { service_id }, ...as(assignment) })

export const listWorkshopOrders = (
  status: 'open' | 'all' = 'open',
  assignment?: string,
): Promise<WorkshopServiceOrdersView> =>
  api(`/v1/workshop-services/orders?status=${status}`, as(assignment))

export const getWorkshopOrder = (
  id: string,
  assignment?: string,
): Promise<WorkshopServiceOrderDetail> =>
  api(`/v1/workshop-services/orders/${encodeURIComponent(id)}`, as(assignment))

export const postWorkshopMessage = (
  id: string,
  text: string,
  assignment?: string,
): Promise<ServiceOrderMessage> =>
  api(`/v1/workshop-services/orders/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { text },
    ...as(assignment),
  })

export const draftWorkshopReply = (
  id: string,
  assignment?: string,
): Promise<WorkshopServiceReplyDraft> =>
  api(`/v1/workshop-services/orders/${encodeURIComponent(id)}/draft-reply`, {
    method: 'POST',
    ...as(assignment),
  })

export const cancelWorkshopOrder = (id: string, assignment?: string): Promise<ServiceOrderView> =>
  api(`/v1/workshop-services/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    ...as(assignment),
  })

/** 第三栏「订单」的资源地址：`agentsws://service-order/<订单号>`。 */
export const SERVICE_ORDER_ADDRESS_PREFIX = 'agentsws://service-order/'

export const serviceOrderAddress = (id: string): string =>
  `${SERVICE_ORDER_ADDRESS_PREFIX}${encodeURIComponent(id)}`

export function parseServiceOrderAddress(address: string | undefined): string | undefined {
  if (address === undefined || !address.startsWith(SERVICE_ORDER_ADDRESS_PREFIX)) return undefined
  const id = decodeURIComponent(address.slice(SERVICE_ORDER_ADDRESS_PREFIX.length))
  return id === '' ? undefined : id
}

export const isOpenOrder = (status: ServiceOrderStatus): boolean =>
  !SERVICE_ORDER_TERMINAL_STATUSES.includes(status)

/** 在等你的那几种状态（列表上标黄点）。 */
export const waitsForYou = (status: ServiceOrderStatus): boolean =>
  status === 'quoted' || status === 'waiting_user' || status === 'delivered'

/** 积分写法：整数不带小数，零头最多两位。 */
export const creditsText = (n: number | undefined, lang: string): string =>
  n === undefined
    ? ''
    : n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 })
