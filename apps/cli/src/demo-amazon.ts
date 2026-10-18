/**
 * WP394（docs/104 一期 B）：demo 里的 **Amazon 前台替身**——读页那一块（`AmazonFrontReader`）和云端兜底都是替身，
 * 不出网、不花钱。ASIN 都是编的（`B0DEMO…`），不是真商品。
 *
 * - 搜「品牌名 + 品类」：交回那家的几张卡片（外加一个广告位和一个配件，规则脑该挑掉它们）；
 * - 读商品页：第一次原样（只建底子）；之后每次读 Jackery Explorer 1000 v2 降到 $679（「第二天把快照改一格」）；
 * - 想演「被 Amazon 拦了」：启动 demo 时设 `AGENTSWS_DEMO_AMAZON=<一个 JSON 文件>`，文件里写 `{ "blocked": true }`——
 *   每次读都会重新看这个文件；被拦后这一轮剩下的走云端替身（0.18 积分 / 个，和真价目一致）。
 */
import { existsSync, readFileSync } from 'node:fs'
import type { DataTaskView } from '@agentsws/contracts'
import type { AmazonCloudPort, AmazonFrontReader } from '@agentsws/server'

type Facts = Extract<Awaited<ReturnType<AmazonFrontReader['readFacts']>>, { status: 'ok' }>['facts']
type Card = Extract<
  Awaited<ReturnType<AmazonFrontReader['searchCards']>>,
  { status: 'ok' }
>['cards'][number]

interface DemoListing {
  asin: string
  brand: string
  title: string
  price: number
  list_price?: number
  coupon?: string
  rating: number
  reviews: number
  bsr: { rank: number; category: string }[]
  sponsored?: boolean
}

const BSR = (big: number, small: number) => [
  { rank: big, category: 'Patio, Lawn & Garden' },
  { rank: small, category: 'Portable Power Stations' },
]

/** 自家（NordVolt Gear）与三家竞品在 Amazon 上的几款（编的）。 */
export const DEMO_AMAZON: readonly DemoListing[] = [
  {
    asin: 'B0DEMONV01',
    brand: 'NordVolt',
    title: 'NordVolt Trail Power 1000 Portable Power Station, 1024Wh LiFePO4',
    price: 699,
    rating: 4.5,
    reviews: 412,
    bsr: BSR(5120, 61),
  },
  {
    asin: 'B0DEMONV02',
    brand: 'NordVolt',
    title: 'NordVolt Trail Power 300 Portable Power Station for Camping',
    price: 279,
    rating: 4.4,
    reviews: 188,
    bsr: BSR(9876, 140),
  },
  {
    asin: 'B0DEMOEF01',
    brand: 'EcoFlow',
    title: 'EcoFlow River 3 Plus Portable Power Station, 286Wh',
    price: 449,
    list_price: 499,
    rating: 4.6,
    reviews: 3120,
    bsr: BSR(812, 9),
  },
  {
    asin: 'B0DEMOEF02',
    brand: 'EcoFlow',
    title: 'EcoFlow Delta 3 Portable Power Station 1024Wh LiFePO4',
    price: 899,
    rating: 4.5,
    reviews: 1890,
    bsr: BSR(1544, 17),
  },
  {
    asin: 'B0DEMOEF09',
    brand: 'EcoFlow',
    title: 'EcoFlow 220W Bifacial Portable Solar Panel',
    price: 499,
    rating: 4.4,
    reviews: 640,
    bsr: BSR(3400, 30),
    sponsored: true,
  },
  {
    asin: 'B0DEMOJK01',
    brand: 'Jackery',
    title: 'Jackery Explorer 1000 v2 Portable Power Station, 1070Wh LiFePO4',
    price: 799,
    rating: 4.7,
    reviews: 5210,
    bsr: BSR(640, 6),
  },
  {
    asin: 'B0DEMOJK02',
    brand: 'Jackery',
    title: 'Jackery Explorer 300 Plus Portable Power Station',
    price: 299,
    rating: 4.6,
    reviews: 2780,
    bsr: BSR(1203, 12),
  },
  {
    asin: 'B0DEMOJK09',
    brand: 'Jackery',
    title: 'Jackery Carrying Case Bag',
    price: 39,
    rating: 4.7,
    reviews: 9100,
    bsr: BSR(2200, 1),
  },
  {
    asin: 'B0DEMOBL01',
    brand: 'BLUETTI',
    title: 'BLUETTI AC180 Portable Power Station, 1152Wh LiFePO4',
    price: 699,
    coupon: 'Apply $50 coupon',
    rating: 4.5,
    reviews: 2310,
    bsr: BSR(980, 11),
  },
  {
    asin: 'B0DEMOBL02',
    brand: 'BLUETTI',
    title: 'BLUETTI EB3A Portable Power Station 268Wh',
    price: 199,
    rating: 4.5,
    reviews: 6020,
    bsr: BSR(1100, 13),
  },
]

/** demo 品牌自家的那两款（`BrandWatch.brand.amazon`）。 */
export const DEMO_AMAZON_OWN = [
  { marketplace: 'US', asin: 'B0DEMONV01', label: 'Trail Power 1000' },
  { marketplace: 'US', asin: 'B0DEMONV02', label: 'Trail Power 300' },
]

const blocked = (): boolean => {
  const file = process.env.AGENTSWS_DEMO_AMAZON
  if (file === undefined || file === '' || !existsSync(file)) return false
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { blocked?: boolean }).blocked === true
  } catch {
    return false
  }
}

const url = (asin: string) => `https://www.amazon.com/dp/${asin}`

export function demoAmazon(): { reader: AmazonFrontReader; cloud: AmazonCloudPort } {
  const reads = new Map<string, number>()
  /** 第二次起 Jackery Explorer 1000 v2 降到 $679。 */
  const priceOf = (l: DemoListing): number =>
    l.asin === 'B0DEMOJK01' && (reads.get(l.asin) ?? 0) > 1 ? 679 : l.price
  const factsOf = (l: DemoListing): Facts => {
    reads.set(l.asin, (reads.get(l.asin) ?? 0) + 1)
    return {
      asin: l.asin,
      url: url(l.asin),
      title: l.title,
      brand: l.brand,
      price: priceOf(l),
      price_text: `$${priceOf(l)}.00`,
      currency: 'USD',
      ...(l.list_price === undefined ? {} : { list_price: l.list_price }),
      ...(l.coupon === undefined ? {} : { coupon: l.coupon }),
      rating: l.rating,
      reviews: l.reviews,
      bsr: l.bsr,
      available: true,
      bullets: [],
      deliver_to: 'New York 10001',
      undeliverable: false,
    }
  }
  const find = (asin: string) => DEMO_AMAZON.find((l) => l.asin === asin.toUpperCase())
  const reader: AmazonFrontReader = {
    ready: () => !blocked(),
    pausedUntil: () => (blocked() ? Date.now() + 3_600_000 : undefined),
    async readProduct() {
      return { status: 'failed', url: '', message: 'demo 里只演竞品对标款' }
    },
    async search() {
      return { status: 'failed', url: '', message: 'demo 里只演竞品对标款' }
    },
    async readFacts({ asin }) {
      if (blocked()) return { status: 'blocked', message: 'Amazon 要人机验证' }
      const l = find(asin)
      return l === undefined ? { status: 'missing' } : { status: 'ok', facts: factsOf(l) }
    },
    async searchCards({ query }) {
      if (blocked()) return { status: 'blocked' }
      const q = query.toLowerCase()
      const cards: Card[] = DEMO_AMAZON.filter(
        (l) => l.brand !== 'NordVolt' && q.includes(l.brand.toLowerCase()),
      ).map((l, i) => ({
        asin: l.asin,
        title: l.title,
        position: i + 1,
        price: l.price,
        currency: 'USD',
        rating: l.rating,
        reviews: l.reviews,
        sponsored: l.sponsored === true,
      }))
      return { status: 'ok', cards }
    },
    async readStorefront() {
      return { status: 'failed', message: 'demo 里没有店铺页' }
    },
  }
  /** 云端替身：交上去就跑完（不等），按读到的条数扣 0.18 积分 / 个。 */
  let last: { asins: string[]; at: string } = { asins: [], at: new Date(0).toISOString() }
  const task = (status: DataTaskView['status']): DataTaskView => {
    const n = last.asins.filter((a) => find(a) !== undefined).length
    return {
      id: 'demo_amazon_task',
      capability: 'amazon.product',
      status,
      max_items: last.asins.length,
      item_count: n,
      reserved_credits: Math.round(0.18 * last.asins.length * 100) / 100,
      credits: Math.round(0.18 * n * 100) / 100,
      created_at: last.at,
      source: 'official',
    }
  }
  const cloud: AmazonCloudPort = {
    async submit(input) {
      const asins = Array.isArray(input.input.asins) ? (input.input.asins as string[]) : []
      last = { asins, at: new Date().toISOString() }
      return task('succeeded')
    },
    task: async () => task('succeeded'),
    async items() {
      const items = last.asins.flatMap((asin) => {
        const l = find(asin)
        if (l === undefined) return []
        reads.set(l.asin, (reads.get(l.asin) ?? 0) + 1)
        return [
          {
            asin: l.asin,
            title: l.title,
            price: priceOf(l),
            currency: 'USD',
            rating: l.rating,
            reviews_count: l.reviews,
            bsr: l.bsr[0]?.rank ?? 0,
            category: 'Patio, Lawn & Garden › Generators & Portable Power',
            url: url(l.asin),
            in_stock: true,
          },
        ]
      })
      return { task_id: 'demo_amazon_task', items, total: items.length }
    },
  }
  return { reader, cloud }
}
