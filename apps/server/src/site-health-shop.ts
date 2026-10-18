/**
 * WP381：体检与 AI 来源流量要的那几条**写死的**只读 Admin GraphQL，以及回包 → 我们的形状。
 *
 * - 商品：`read_products`（网站运营 / 建站的店铺授权里都有）；
 * - 订单进店来源（`customerJourneySummary`）：`read_orders`（网站运营有）——只拿金额、时间与两次进店的
 *   来源网址 / 落地页 / 来源名，**一格顾客信息都不要**；
 * - 会话来源（ShopifyQL `FROM sessions`）：要 `read_reports`，授权里没有就不问（访问数记「没授权」）。
 */
import type { TrafficOrder, TrafficSessions } from '@agentsws/seo-core'
import type { ProductTruth } from '@agentsws/site-core'

export const HEALTH_PRODUCTS = `query AgentswsHealthProducts($first: Int!) {
  shop { name currencyCode }
  products(first: $first, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
    nodes { id title handle onlineStoreUrl descriptionHtml vendor productType
      featuredMedia { preview { image { url } } }
      options { name }
      variants(first: 50) { nodes { id title sku price barcode availableForSale } }
    }
  }
}`

/** WP385：设置里填了上架页的那几件（按 handle 补读；字段同上）。 */
export const HEALTH_PRODUCTS_BY_HANDLE = `query AgentswsHealthProductsListed($first: Int!, $query: String!) {
  shop { name currencyCode }
  products(first: $first, query: $query) {
    nodes { id title handle onlineStoreUrl descriptionHtml vendor productType
      featuredMedia { preview { image { url } } }
      options { name }
      variants(first: 50) { nodes { id title sku price barcode availableForSale } }
    }
  }
}`

export const AI_TRAFFIC_ORDERS = `query AgentswsAiTrafficOrders($first: Int!, $after: String, $query: String) {
  shop { currencyCode }
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customerJourneySummary {
        firstVisit { landingPage referrerUrl source }
        lastVisit { landingPage referrerUrl source }
      }
    }
  }
}`

/** ShopifyQL：近 N 天按来源域名的真人会话（机器人不算）。 */
export const aiTrafficSessionsDoc = (days: number): string =>
  `query AgentswsAiTrafficSessions { shopifyqlQuery(query: "FROM sessions SHOW sessions WHERE human_or_bot_session = 'human' GROUP BY referrer_domain SINCE -${String(days)}d UNTIL today ORDER BY sessions DESC LIMIT 500") { tableData { columns { name } rows } parseErrors } }`

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined
const nodes = (v: unknown): Record<string, unknown>[] => {
  const r = rec(v)
  return (Array.isArray(r.nodes) ? r.nodes : []).map(rec)
}

/** 商品回包 → 真源（价格统一两位小数）。 */
export function healthProductsOf(data: unknown): {
  shop: { name?: string; currency?: string }
  products: ProductTruth[]
} {
  const d = rec(data)
  const shop = rec(d.shop)
  const products: ProductTruth[] = nodes(d.products).map((p) => {
    const image = str(rec(rec(rec(p.featuredMedia).preview).image).url)
    const url = str(p.onlineStoreUrl)
    const description = str(p.descriptionHtml)
    const vendor = str(p.vendor)
    const type = str(p.productType)
    const options = (Array.isArray(p.options) ? p.options : [])
      .map((o) => str(rec(o).name))
      .filter((n): n is string => n !== undefined && n !== 'Title')
    return {
      id: String(p.id ?? ''),
      title: String(p.title ?? ''),
      handle: String(p.handle ?? ''),
      ...(url === undefined ? {} : { url }),
      ...(description === undefined ? {} : { description }),
      ...(vendor === undefined ? {} : { vendor }),
      ...(type === undefined ? {} : { product_type: type }),
      ...(image === undefined ? {} : { image }),
      ...(options.length === 0 ? {} : { options }),
      variants: nodes(p.variants).map((v) => {
        const sku = str(v.sku)
        const barcode = str(v.barcode)
        const title = str(v.title)
        return {
          id: String(v.id ?? ''),
          price: Number(v.price ?? 0).toFixed(2),
          ...(typeof v.availableForSale === 'boolean' ? { available: v.availableForSale } : {}),
          ...(sku === undefined ? {} : { sku }),
          ...(barcode === undefined ? {} : { barcode }),
          ...(title === undefined ? {} : { title }),
        }
      }),
    }
  })
  const name = str(shop.name)
  const currency = str(shop.currencyCode)
  return {
    shop: {
      ...(name === undefined ? {} : { name }),
      ...(currency === undefined ? {} : { currency }),
    },
    products,
  }
}

const visitOf = (v: unknown): TrafficOrder['first'] => {
  const r = rec(v)
  const referrer_url = str(r.referrerUrl)
  const landing_page = str(r.landingPage)
  const source = str(r.source)
  if (referrer_url === undefined && landing_page === undefined && source === undefined)
    return undefined
  return {
    ...(referrer_url === undefined ? {} : { referrer_url }),
    ...(landing_page === undefined ? {} : { landing_page }),
    ...(source === undefined ? {} : { source }),
  }
}

/** 订单回包 → 只有金额、时间、两次进店来源的订单。 */
export function trafficOrdersOf(data: unknown): {
  currency?: string
  orders: TrafficOrder[]
  next?: string
} {
  const d = rec(data)
  const conn = rec(d.orders)
  const info = rec(conn.pageInfo)
  const currency = str(rec(d.shop).currencyCode)
  const orders = nodes(conn).map((o) => {
    const money = rec(rec(o.currentTotalPriceSet).shopMoney)
    const j = rec(o.customerJourneySummary)
    const first = visitOf(j.firstVisit)
    const last = visitOf(j.lastVisit)
    return {
      total: Number(money.amount ?? 0),
      currency: String(money.currencyCode ?? currency ?? ''),
      created_at: String(o.createdAt ?? ''),
      ...(first === undefined ? {} : { first }),
      ...(last === undefined ? {} : { last }),
    }
  })
  const next = info.hasNextPage === true ? str(info.endCursor) : undefined
  return {
    ...(currency === undefined ? {} : { currency }),
    orders,
    ...(next === undefined ? {} : { next }),
  }
}

/** ShopifyQL 回包 → 按来源域名的会话；有解析错误回 `undefined`。 */
export function trafficSessionsOf(data: unknown): TrafficSessions[] | undefined {
  const q = rec(rec(data).shopifyqlQuery)
  if (Array.isArray(q.parseErrors) && q.parseErrors.length > 0) return undefined
  const rows = rec(q.tableData).rows
  if (!Array.isArray(rows)) return undefined
  return rows
    .map(rec)
    .map((r) => ({
      referrer_domain: String(r.referrer_domain ?? ''),
      sessions: Number(r.sessions ?? 0),
    }))
    .filter((r) => r.referrer_domain !== '' && Number.isFinite(r.sessions))
}
