/**
 * 收入归因（文章第 3 步，"最重要的一步"）：Search Console 告诉你谁点了，不告诉你谁留下了。
 * 把**点击**与**订单 / 收入**按页面并排放：
 *
 * ```
 * 页面                    点击   订单
 * /blog/popular-post       400     0   ← 看着像赢，其实是漏
 * /guides/boring-topic      40     6   ← 照这个再写三篇
 * ```
 *
 * 订单归到哪一页靠 Shopify 的 `landing_site`（顾客第一次进店落在哪）——没接 GA4 也算得出。
 * 写法照 `kol-core/src/attribution.ts` 那条纪律：**匹配不上就说匹配不上**，不按时间窗口猜。
 *
 * 带活动参数的落地页（`utm_medium=cpc/email/kol…`、`gclid`、`fbclid`）不算自然搜索来的：
 * 那一单是广告 / 邮件 / 红人带来的，算给文章等于替别人领功。
 */
import type { GscRow, PageRevenueRow } from '@agentsws/contracts'

/**
 * 按**路径**归一（小写、去结尾斜杠）。一家店只有一个域名，Search Console 给的是完整地址、
 * Shopify 的 `landing_site` 多半只有路径——按路径对才对得上（`www.` 与否、http 与否都不影响）。
 */
export function pathKey(url: string, base = 'https://shop.invalid'): string | undefined {
  try {
    const path = new URL(url.trim(), base).pathname.replace(/\/+$/, '') || '/'
    return path.toLowerCase()
  } catch {
    return undefined
  }
}

/** 归因要看的那一份订单（从店铺连接器的只读 Action 来）。 */
export interface LandingOrder {
  id: string
  /** Shopify 的 `landing_site`（可能是路径，也可能是完整 URL）。没有就是没有，别编。 */
  landing_site?: string
  total: number
  currency: string
}

/** GA4 的落地页转化率（接了 GA4 才有）。 */
export interface LandingConversion {
  page: string
  /** 0–1。 */
  conversion_rate: number
}

export interface RevenueOptions {
  /** "点击多但没订单"：点击至少这么多（默认 100）。 */
  leak_min_clicks?: number
  /** "点击少但出订单"：点击不超过这么多（默认 50）。 */
  gem_max_clicks?: number
  /** 店铺主币种（没有订单时收入那一格的币种）。 */
  currency: string
  /** 店铺域名（`landing_site` 是路径时拼成完整地址用）。 */
  shop_host: string
}

const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'paid',
  'paidsearch',
  'display',
  'email',
  'kol',
  'affiliate',
  'social',
  'paid_social',
  'sms',
])

/** 这个落地页是不是活动带来的（广告点击 id 或者付费 / 自有渠道的 `utm_medium`）。 */
export function isCampaignLanding(url: URL): boolean {
  if (
    url.searchParams.has('gclid') ||
    url.searchParams.has('fbclid') ||
    url.searchParams.has('ttclid')
  )
    return true
  const medium = url.searchParams.get('utm_medium')
  return medium !== null && PAID_MEDIUMS.has(medium.toLowerCase())
}

/** `landing_site` → 页面键（与 Search Console 那一侧同一种归一）；活动带来的回 `undefined`。 */
export function landingKey(landing: string, shop_host: string): string | undefined {
  const raw = landing.trim()
  if (raw === '') return undefined
  let u: URL
  try {
    u = new URL(raw, `https://${shop_host}`)
  } catch {
    return undefined
  }
  if (isCampaignLanding(u)) return undefined
  return pathKey(u.toString())
}

const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * 按页面并排「点击 / 订单 / 收入」，并标出两类：`leak`（点击多没订单）、`gem`（点击少出订单）。
 *
 * 行 = Search Console 里有点击的页 ∪ 有自然订单落地的页。排序：收入降序、点击降序、页面字面。
 */
export function pageRevenue(input: {
  gsc: readonly GscRow[]
  orders: readonly LandingOrder[]
  ga4?: readonly LandingConversion[]
  options: RevenueOptions
}): { rows: PageRevenueRow[]; unmatched_orders: number; campaign_orders: number } {
  const o = { leak_min_clicks: 100, gem_max_clicks: 50, ...input.options }
  const rows = new Map<string, PageRevenueRow>()
  const rowOf = (key: string, page: string): PageRevenueRow => {
    const hit = rows.get(key)
    if (hit !== undefined) return hit
    const row: PageRevenueRow = { page, clicks: 0, orders: 0, revenue: 0, currency: o.currency }
    rows.set(key, row)
    return row
  }
  for (const r of input.gsc) {
    const key = pathKey(r.page)
    if (key !== undefined) rowOf(key, r.page).clicks += r.clicks
  }
  let unmatched = 0
  let campaign = 0
  for (const order of input.orders) {
    if (order.landing_site === undefined || order.landing_site.trim() === '') {
      unmatched += 1
      continue
    }
    const key = landingKey(order.landing_site, o.shop_host)
    if (key === undefined) {
      // 解析不了的算归不上；活动带来的另记一个数（那一单有主，只是不归文章）
      if (isCampaignUrl(order.landing_site, o.shop_host)) campaign += 1
      else unmatched += 1
      continue
    }
    const row = rowOf(key, `https://${o.shop_host}${key}`)
    row.orders += 1
    row.revenue = round2(row.revenue + order.total)
    row.currency = order.currency
  }
  const ga4 = new Map((input.ga4 ?? []).map((g) => [pathKey(g.page) ?? g.page, g.conversion_rate]))
  const out = [...rows.entries()].map(([key, row]) => {
    const cr = ga4.get(key)
    const flag: PageRevenueRow['flag'] =
      row.clicks >= o.leak_min_clicks && row.orders === 0
        ? 'leak'
        : row.orders > 0 && row.clicks <= o.gem_max_clicks
          ? 'gem'
          : undefined
    return {
      ...row,
      ...(cr === undefined ? {} : { conversion_rate: cr }),
      ...(flag === undefined ? {} : { flag }),
    }
  })
  out.sort((a, b) => b.revenue - a.revenue || b.clicks - a.clicks || a.page.localeCompare(b.page))
  return { rows: out, unmatched_orders: unmatched, campaign_orders: campaign }
}

function isCampaignUrl(landing: string, shop_host: string): boolean {
  try {
    return isCampaignLanding(new URL(landing.trim(), `https://${shop_host}`))
  } catch {
    return false
  }
}
