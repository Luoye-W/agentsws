/**
 * WP396（docs/106 §13）：自家 Amazon Listing 体检的接口（`/v1/amazon-listing*`）+ 向设计岗下需求单（`/v1/design/requests`）。
 * 单独一个文件（`api.ts` 那张大表好几单同时在加）。带「亚马逊店铺运营」那条分配。
 */
import type { ListingCheckupRun, ListingCheckupView } from '@agentsws/contracts'
import { api } from './api'

export type {
  ListingCheckupItem,
  ListingCheckupRun,
  ListingCheckupView,
  ListingIssue,
} from '@agentsws/contracts'

export const amazonListingKey = (assignment: string) => ['amazon-listing', assignment] as const

/** 老版本服务端 / 替身回的不是这个形状：当没有（块里照旧出「还没体检过」）。 */
export const isListingCheckupView = (v: unknown): v is ListingCheckupView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ListingCheckupView).own_asins === 'number' &&
  Array.isArray((v as ListingCheckupView).rules)

export const getAmazonListing = async (assignment: string): Promise<ListingCheckupView | null> => {
  const v = await api<unknown>('/v1/amazon-listing', { assignment })
  return isListingCheckupView(v) ? v : null
}

export const runAmazonListing = (
  assignment: string,
): Promise<{ run?: ListingCheckupRun; needs_setup?: string; message?: string }> =>
  api('/v1/amazon-listing/run', { method: 'POST', assignment })

/** 图片类问题的「向设计岗下需求单」：开一张 `request_design`（L3），来源是亚马逊店铺运营。 */
export const requestListingDesign = (
  assignment: string,
  input: { title: string; need: string },
): Promise<{ request: { id: string } }> =>
  api('/v1/design/requests', { method: 'POST', assignment, body: input })

/** WP420（自查 B15）：改自家 ASIN（ASIN / 商品链接，逗号或换行隔开；空 = 清掉）。只动本机。 */
export const setAmazonOwnAsins = (
  assignment: string,
  value: string,
): Promise<{ ok: boolean; message?: string }> =>
  api('/v1/amazon-listing/own', { method: 'PUT', assignment, body: { value } })
