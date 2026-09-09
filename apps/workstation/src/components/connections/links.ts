/**
 * 「去连接」跳哪里（WP20 §C）。
 *
 * 36 §3 的三层链路里，数据源没接时首页数字块与岗位面板都出一张「去连接」卡。
 * 点它应该直接落到**那一个** provider 的卡片上，而不是丢用户到一页目录里自己找。
 *
 * 一个数据源可能有好几个 provider 能喂（广告后台既可以是 Meta 也可以是 Google Ads），
 * 这里挑 v1 的那一个；用户到了页面上仍然能选别的。
 */
import type { DataSourceId } from '@agentsws/deck'

const SERVICE_BY_SOURCE: Partial<Record<DataSourceId, string>> = {
  shop: 'shopify_admin',
  ga4: 'ga4',
  gsc: 'gsc',
  ads: 'meta_ads',
}

/** 数据源 → 连接页的地址（认不出来的就落到连接页首屏）。 */
export function connectPathFor(source: string | undefined): string {
  const service = source === undefined ? undefined : SERVICE_BY_SOURCE[source as DataSourceId]
  return service === undefined ? '/connections' : `/connections?service=${service}`
}
