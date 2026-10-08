/**
 * WP265：云端 Shopify 一键授权（私有云 WP263 已上线，cloud.agentsws.com）在本机这一侧的约定。
 *
 * 为什么不进 `CloudApi` 路由表（`cloud-api.ts`）：那张表也是开源云（自建形态）的实现清单，
 * 一致性测试要求表里每一条都打得通；决策 191 定了自建形态**不支持** Shopify 一键授权
 * （应用的 Client secret 只在官方云上）。所以这里只写本机客户端读写的形状——
 * 云上回的多余字段一律忽略，少的字段按「没有」处理，不编。
 *
 * 五条云端接口（鉴权用工作区令牌，动作集 `store`，决策 186）：
 * - `POST /v1/shopify/oauth/start` {@link ShopifyOauthStartRequest} → 201 {@link ShopifyOauthStart}
 *   （应用没配齐 / 这家店不在应用的分发范围 → 501 + 一句人话）
 * - `GET /v1/shopify/oauth/attempts/{id}` → {@link ShopifyOauthAttempt}
 * - `GET /v1/shopify/connections` → {@link ShopifyCloudConnection} 的列表
 * - `DELETE /v1/shopify/connections/{shop}`（最后一个工作区断开时云上顺手卸载应用，决策 188）
 * - `POST /v1/shopify/graphql` {@link ShopifyCloudGraphqlRequest}（云端代发，店铺令牌不出云，决策 185）
 */

/** 云上那几条的路径（本机客户端与测试替身共用一份，免得两边各拼各的）。 */
export const SHOPIFY_CLOUD_PATHS = {
  start: '/v1/shopify/oauth/start',
  attempt: (id: string): string => `/v1/shopify/oauth/attempts/${encodeURIComponent(id)}`,
  connections: '/v1/shopify/connections',
  connection: (shop: string): string => `/v1/shopify/connections/${encodeURIComponent(shop)}`,
  graphql: '/v1/shopify/graphql',
} as const

export interface ShopifyOauthStartRequest {
  /** `xxx.myshopify.com`。 */
  shop: string
  /** 记在哪个品牌名下（本机工作区 id；WP252 连接按品牌隔开）。 */
  brand?: string
  /** 授权完浏览器落到哪（不给就停在云上那张「已连好」小页）。 */
  return_to?: string
}

export interface ShopifyOauthStart {
  attempt_id: string
  /** Shopify 自己的授权页（店主在那里点「安装」）。 */
  authorize_url: string
  /** 用的是哪个应用（`rollout` 指定店铺应用 / `public` 公开应用）。 */
  app: string
  scopes: string[]
  expires_at: string
}

export type ShopifyOauthAttemptStatus = 'pending' | 'connected' | 'failed' | 'expired'

export interface ShopifyOauthAttempt {
  status: ShopifyOauthAttemptStatus
  shop?: string
  /** 失败时云上那句人话（有就照搬）。 */
  message?: string
  reason?: string
}

export type ShopifyCloudConnectionStatus = 'connected' | 'reauth_required'

export interface ShopifyCloudConnection {
  shop: string
  app?: string
  /** 起授权时带的 `brand`（老的没有）。 */
  brand?: string
  status: ShopifyCloudConnectionStatus
  /** `reauth_required` 的原因（令牌撤了、店主卸载了、权限变了…）。 */
  reauth_reason?: string
  /** 已经授了的 Shopify 权限（`read_products` …）。 */
  scopes?: string[]
  /** 应用要、但这次没授到的权限。 */
  missing_scopes?: string[]
  expires_at?: string
  /** 店名（云上记了就有）。 */
  shop_name?: string
  connected_at?: string
}

export interface ShopifyCloudGraphqlRequest {
  shop: string
  query: string
  variables?: Record<string, unknown>
  /** 不给 = 只许查询；改店的那一类要显式说（本单不用）。 */
  allow_mutations?: boolean
}

/** 「测试连接」那一次只读查询：店名 + 店铺域名。 */
export const SHOPIFY_CLOUD_TEST_QUERY = '{ shop { name myshopifyDomain } }'

/**
 * WP267（决策 208，接私有云 WP266）：**一点补签**——老的工作区令牌缺后来才进默认集的动作集（`store` / `kol`）时，
 * 不用重新登录，本机拿这把令牌打一下就**就地**补上（不换令牌、不动有效期、不碰同组织别的关联）。
 *
 * 同样不进 `CloudApi` 路由表：这是官方云为老令牌留的一条，自建形态签出来的令牌本来就按当时的默认集。
 * 云上没有这一条（404 / 405 / 501）、或令牌已经不认（401）→ 本机退回「重新登录」。
 */
export const CLOUD_LINK_UPGRADE_PATH = '/v1/cloud/links/current/upgrade'

/** `POST /v1/cloud/links/current/upgrade` → 200 `{ data: CloudLinkUpgrade }`（没有令牌）。 */
export interface CloudLinkUpgrade {
  /** 这把令牌现在有的全部动作集。 */
  scopes: string[]
  /** 这一次补上的那几项（已经齐了 = 空）。 */
  added: string[]
  /** 关联本身的元信息（云上原样给，本机只认 `id` / `expires_at`）。 */
  link?: { id?: string; expires_at?: string; scopes?: string[] }
}
