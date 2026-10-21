/**
 * WP438：`agentsws demo --report-history`——给报表截图用的**演示订单历史**（只在 demo 里、只在点名要时才造）。
 *
 * 合成世界里只有几十笔订单，报表的 30 / 90 天趋势画出来是几根孤零零的柱子，看不出报表长什么样。
 * 这里按固定种子补 120 天的订单：每天十几二十笔、周末多一点、最近两周多一点；客人有回头客（按邮箱认）；
 * 落地页 / 进店来源按常见比例给（自然搜索、直接、邮件、社媒、付费、AI 回答）；行项目取世界里的商品。
 *
 * **全是演示数据**：页面顶上那个「演示数据」标记照旧在；生产里不会走到这里。
 */
import type { OrderRow } from '@agentsws/deck'

interface ProductLike {
  id: string
  title: string
  price?: number
}

/** mulberry32：固定种子的伪随机（同一个种子每次出一样的数）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 86_400_000

const CHANNELS: readonly { w: number; referring_site?: string; landing_site: string }[] = [
  { w: 34, referring_site: 'https://www.google.com/', landing_site: '/products/' },
  { w: 4, referring_site: 'https://www.bing.com/', landing_site: '/products/' },
  { w: 20, landing_site: '/' },
  { w: 13, landing_site: '/collections/new?utm_source=klaviyo&utm_medium=email' },
  { w: 7, referring_site: 'https://www.instagram.com/', landing_site: '/products/' },
  { w: 5, referring_site: 'https://www.reddit.com/', landing_site: '/products/' },
  { w: 10, landing_site: '/products/?gclid=demo' },
  { w: 4, referring_site: 'https://chatgpt.com/', landing_site: '/products/' },
  { w: 3, referring_site: 'https://www.perplexity.ai/', landing_site: '/products/' },
]

export function demoOrderHistory(input: {
  now: string
  tz_offset_minutes: number
  currency: string
  products: readonly ProductLike[]
  days?: number
  seed?: number
}): OrderRow[] {
  const rand = rng(input.seed ?? 438)
  const days = input.days ?? 120
  const products = input.products.length > 0 ? input.products : [{ id: 'p', title: '商品' }]
  const price = (p: ProductLike, i: number): number =>
    p.price !== undefined && p.price > 0 ? p.price : ([39, 59, 89, 129, 199][i % 5] ?? 59)
  const shift = input.tz_offset_minutes * 60_000
  const today = Math.floor((Date.parse(input.now) + shift) / DAY) * DAY - shift
  const customers: string[] = []
  const totalW = CHANNELS.reduce((a, c) => a + c.w, 0)
  const pickChannel = () => {
    let r = rand() * totalW
    for (const c of CHANNELS) {
      r -= c.w
      if (r <= 0) return c
    }
    return CHANNELS[0] as (typeof CHANNELS)[number]
  }
  const out: OrderRow[] = []
  let seq = 5000
  for (let d = days; d >= 1; d -= 1) {
    const dayStart = today - d * DAY
    const dow = new Date(dayStart + shift).getUTCDay()
    const weekend = dow === 0 || dow === 6 ? 1.25 : 1
    const recent = d <= 14 ? 1.22 : d <= 30 ? 1.08 : 1
    const n = Math.round((11 + rand() * 7) * weekend * recent)
    for (let k = 0; k < n; k += 1) {
      const returning = customers.length > 20 && rand() < 0.38
      const email = returning
        ? (customers[Math.floor(rand() * customers.length)] as string)
        : `buyer${customers.length + 1}@example.com`
      if (!returning) customers.push(email)
      const ch = pickChannel()
      const items = 1 + (rand() < 0.22 ? 1 : 0)
      const line_items = Array.from({ length: items }, () => {
        const i = Math.min(products.length - 1, Math.floor(rand() ** 1.7 * products.length))
        const p = products[i] as ProductLike
        const quantity = rand() < 0.15 ? 2 : 1
        return {
          product_id: p.id,
          title: p.title,
          quantity,
          total: Math.round(price(p, i) * quantity * 100) / 100,
        }
      })
      const total = Math.round(line_items.reduce((a, li) => a + li.total, 0) * 100) / 100
      const at = dayStart + Math.floor(rand() * DAY)
      seq += 1
      out.push({
        id: `ord_hist_${seq}`,
        name: `#${seq}`,
        email,
        currency: input.currency,
        created_at: new Date(at).toISOString(),
        total_price: total,
        refunded_amount: rand() < 0.03 ? total : 0,
        financial_status: 'paid',
        fulfillment_status: d > 3 ? 'delivered' : 'unfulfilled',
        line_items,
        landing_site: ch.landing_site,
        ...(ch.referring_site === undefined ? {} : { referring_site: ch.referring_site }),
      })
    }
  }
  return out
}
