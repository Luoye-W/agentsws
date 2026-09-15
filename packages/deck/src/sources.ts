/**
 * 数据源的连接状态从**真实连接**算（WP20）。
 *
 * 36 §3：「数据源没接（连接未建）时显示『去连接』卡而不是空图」。在 WP20 之前，
 * `DataSourceStatus` 是装配方写死的一张表；现在它由工作区里真有哪些连接决定——
 * 连上 Shopify，首页的销售数字块就不再是「去连接」；断开了就变回去。
 *
 * 这一层仍然**没有 IO**：调用方把连接清单（只要 service 与状态，绝无凭据）递进来，
 * 这里只做「哪个 service 喂哪个数据源」的映射。
 */
import { SOURCE_LABELS, SOURCE_REPORT_URLS } from './blocks.js'
import type { DataSourceId, DataSourceStatus } from './types.js'

/**
 * service → 数据源。
 *
 * 左边是我们对外的 provider id（`apps/server` 的连接目录），不是 OpenConnector 的
 * 上游 service 名——上游叫 `google_analytics` / `google_search_console` / `meta`，
 * 那层映射在装配方，不在 deck 里。
 */
export const SOURCES_BY_SERVICE: Readonly<Record<string, readonly DataSourceId[]>> = {
  shopify_admin: ['shop'],
  shopify: ['shop'],
  ga4: ['ga4'],
  google_analytics: ['ga4'],
  gsc: ['gsc'],
  google_search_console: ['gsc'],
  meta_ads: ['ads'],
  meta: ['ads'],
  googleads: ['ads'],
  // WP64（51 §2.3 / §2.4）：连接器骨架。这两行现在没有一条真连接会命中——
  // 目录里那几张卡的状态是"还没接"——但映射先立着：接上那天只改连接目录，不改 deck。
  klaviyo: ['email_marketing'],
  shopify_email: ['email_marketing'],
  aftership: ['tracking'],
  track17: ['tracking'],
}

/** 工作队列（审批项）是我们自己的库，永远算连上。 */
export const ALWAYS_CONNECTED: readonly DataSourceId[] = ['approvals']

/** 全部数据源，按面板里的出场顺序。 */
export const ALL_DATA_SOURCES: readonly DataSourceId[] = [
  'shop',
  'approvals',
  'ga4',
  'gsc',
  'ads',
  'csat',
  'email_marketing',
  'tracking',
  'reviews',
]

/**
 * WP63（51 §2.1 评价管理 / §3 N2）：**还没做**的数据源那一句人话。
 *
 * 与"没连"分得开（`DataSourceStatus.note` 的注释里那一条）：评价应用不是用户忘了
 * 去连，是连接目录里压根还没有这张卡。给一个「去连接」按钮才是骗人。
 */
export const PLANNED_SOURCE_NOTES: Partial<Record<DataSourceId, string>> = {
  reviews:
    '评价应用（Judge.me / Loox）还没接上——连接目录里已经登记为"待增加"，接上了这一块自己就有数了。',
}

/** 算连接状态时只认这个形状——**没有也不可能有凭据字段**。 */
export interface ConnectionLike {
  service: string
  status?: 'active' | 'reauth_required' | 'disabled'
}

/** 这条连接喂哪些数据源（不认识的 service 喂不了任何一个，返回空）。 */
export function dataSourcesOfService(service: string): readonly DataSourceId[] {
  return SOURCES_BY_SERVICE[service] ?? []
}

/**
 * 连接清单 → `DataSourceStatus[]`。
 *
 * 只有 `status === 'active'` 才算连上：需要重新授权的连接跟没连一样出「去连接」，
 * 否则界面会显示一个永远为 0 的数字块，比空图更糟。
 */
export function dataSourcesFromConnections(
  connections: readonly ConnectionLike[],
  options: { sources?: readonly DataSourceId[]; storefrontNote?: string } = {},
): DataSourceStatus[] {
  const connected = new Set<DataSourceId>(ALWAYS_CONNECTED)
  for (const c of connections) {
    if (c.status !== undefined && c.status !== 'active') continue
    for (const s of dataSourcesOfService(c.service)) connected.add(s)
  }
  return (options.sources ?? ALL_DATA_SOURCES).map((id) => {
    // WP62（51 §1 N0 ③）：这个工作区的网站平台我们还没接 → 「店铺后台」永远算没连，
    // 并带上那一句人话。给「去连接」按钮才是骗人：点进去也没有这个平台的卡。
    const unsupported = id === 'shop' && options.storefrontNote !== undefined
    // WP63：连接目录里还没有这张卡的数据源（评价应用）——永远算没连，并带上那句话
    const planned = PLANNED_SOURCE_NOTES[id]
    const on = !unsupported && planned === undefined && connected.has(id)
    const report_url = SOURCE_REPORT_URLS[id]
    const note = unsupported ? options.storefrontNote : planned
    return {
      id,
      label: SOURCE_LABELS[id],
      connected: on,
      // 没连上就别给「查看完整报告」——点进去也是别人的后台登录页
      ...(on && report_url !== undefined ? { report_url } : {}),
      ...(note === undefined ? {} : { note }),
    }
  })
}

/**
 * 把真实连接算出来的状态盖到一份既有表上（demo / 测试里那份写死的表）。
 *
 * 规则是**只加不减**：底表里已经 `connected: true` 的（比如 demo 里由合成世界喂的店铺后台）
 * 保持连上；真实连接再把别的源点亮。这样接一个连接不会把 demo 的数据打没。
 */
export function mergeDataSources(
  base: readonly DataSourceStatus[],
  connections: readonly ConnectionLike[],
): DataSourceStatus[] {
  const computed = new Map(dataSourcesFromConnections(connections).map((s) => [s.id, s] as const))
  return base.map((s) => {
    const live = computed.get(s.id)
    if (live === undefined || !live.connected || s.connected) return s
    return {
      ...s,
      connected: true,
      ...(live.report_url === undefined ? {} : { report_url: live.report_url }),
    }
  })
}
