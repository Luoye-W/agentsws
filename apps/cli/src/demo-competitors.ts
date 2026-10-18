/**
 * WP392（docs/104）：demo 里的**竞品监控替身**——三家竞品的独立站（`.example` 保留域，不是真店）
 * 和一个替身进料口。不出网、不花钱。
 *
 * - 第一次读：三家的商品目录原样交回（只建底子，不报上新）；
 * - 之后每次读：Jackery 那款 Explorer 1000 的两个款式降价 15%（「第二天把快照改一格」）；
 * - 想演「一家没读到」：启动 demo 时设 `AGENTSWS_DEMO_COMPETITORS=<一个 JSON 文件>`，文件里写
 *   `{ "jackery.example": { "broken": true } }`——每次读都会重新看这个文件，改了就生效，不用重启；
 *   也可以写 `{ "<店铺域名>": { "price_factor": 0.9 } }` 让那家整店打九折。
 */
import { existsSync, readFileSync } from 'node:fs'
import type {
  BrandWatchCompetitor,
  CatalogSnapshotRow,
  CompetitorIntakeAdapter,
} from '@agentsws/contracts'

interface DemoProduct {
  id: string
  title: string
  handle: string
  variants: { id: string; title: string; price: number; compare_at?: number }[]
}

const CATALOG: Readonly<Record<string, DemoProduct[]>> = {
  'ecoflow.example': [
    {
      id: '9001',
      title: 'River 3 Plus',
      handle: 'river-3-plus',
      variants: [{ id: '90011', title: 'Default', price: 449, compare_at: 499 }],
    },
    {
      id: '9002',
      title: 'Delta 3',
      handle: 'delta-3',
      variants: [{ id: '90021', title: 'Default', price: 899 }],
    },
  ],
  'jackery.example': [
    {
      id: '8001',
      title: 'Explorer 1000 v2',
      handle: 'explorer-1000-v2',
      variants: [
        { id: '80011', title: 'Standard', price: 799 },
        { id: '80012', title: 'With 100W panel', price: 999 },
      ],
    },
    {
      id: '8002',
      title: 'Explorer 300 Plus',
      handle: 'explorer-300-plus',
      variants: [{ id: '80021', title: 'Default', price: 299 }],
    },
  ],
  'bluetti.example': [
    {
      id: '7001',
      title: 'AC180',
      handle: 'ac180',
      variants: [{ id: '70011', title: 'Default', price: 699 }],
    },
  ],
}

/** demo 品牌关注的三家竞品（和档案里 AI 建议的那三家对得上）。 */
export const DEMO_COMPETITORS: BrandWatchCompetitor[] = [
  {
    id: 'c_ecoflow',
    name: 'EcoFlow',
    aliases: [],
    domains: ['ecoflow.example'],
    store: { url: 'https://ecoflow.example', platform: 'shopify' },
  },
  {
    id: 'c_jackery',
    name: 'Jackery',
    aliases: [],
    domains: ['jackery.example'],
    store: { url: 'https://jackery.example', platform: 'shopify' },
  },
  {
    id: 'c_bluetti',
    name: 'BLUETTI',
    aliases: [],
    domains: ['bluetti.example'],
    store: { url: 'https://bluetti.example', platform: 'woocommerce' },
  },
]

type Knobs = Record<string, { broken?: boolean; price_factor?: number }>

const knobs = (): Knobs => {
  const file = process.env.AGENTSWS_DEMO_COMPETITORS
  if (file === undefined || file === '' || !existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Knobs
  } catch {
    return {}
  }
}

/** demo 的独立站替身进料口（第一次原样、之后 Jackery 那款降价 15%）。 */
export function demoShopAdapter(): CompetitorIntakeAdapter {
  const reads = new Map<string, number>()
  return {
    kind: 'shop_catalog',
    read: async (source, ctx) => {
      const host = (() => {
        try {
          return new URL(source.url).hostname.replace(/^www\./, '')
        } catch {
          return source.url
        }
      })()
      const knob = knobs()[host]
      const products = CATALOG[host]
      if (products === undefined || knob?.broken === true)
        return {
          rows: [],
          complete: false,
          error: `读不到 ${host} 的商品数据：店里那份公开数据打不开`,
        }
      const n = (reads.get(source.id) ?? 0) + 1
      reads.set(source.id, n)
      const factor = knob?.price_factor ?? 1
      const rows: CatalogSnapshotRow[] = products.flatMap((p) =>
        p.variants.map((v) => {
          const drop = n >= 2 && p.id === '8001' ? 0.85 : 1
          const price = Math.round(v.price * drop * factor)
          return {
            source_id: source.id,
            competitor_id: source.competitor_id,
            product_key: p.id,
            variant_key: v.id,
            title: p.title,
            variant_title: v.title,
            url: `https://${host}/products/${p.handle}`,
            price,
            ...(v.compare_at === undefined ? {} : { compare_at_price: v.compare_at }),
            currency: 'USD',
            available: true,
            product_created_at: '2026-01-15T00:00:00.000Z',
            read_at: ctx.now,
          }
        }),
      )
      return { rows, complete: true, via: 'direct' }
    },
  }
}
