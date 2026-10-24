/**
 * WP450：主题簇与外链体检的**合成样本**（NordVolt Gear，3C 配件，`shop.example`，同 `demo.ts` 那一家）。
 *
 * 给测试、demo 与截图用；每个网址、每个数都是编的，没有任何真实店铺或真实网站的数据。
 * 外链那几份是**云上回包的形状**（`DataCallResult`：`seo.backlink_summary` 一行概况、`seo.backlinks` 一行一条外链），
 * 按 WP300 适配器规范化之后的字段写——测试与 demo 当「录好的回包」用。
 *
 * 搜索结果故意凑成：一个总页（「usb c charger」，「best usb c charger」和它前 10 名重叠 7 个、并成同一篇）+ 两个小组
 * （GaN 两篇重叠 ≥ 4、笔记本瓦数两篇重叠 ≥ 4）+ 一个和谁都不重叠的词 + 一个品牌词——一组主题的样子一眼看得出来。
 */
import type { DataCallResult, SeoClusterKeyword } from '@agentsws/contracts'

const R = (n: number): string => `https://retail-${String(n)}.example/usb-c-chargers`
const B = (n: number): string => `https://review-${String(n)}.example/best-chargers`
const G = (n: number): string => `https://tech-${String(n)}.example/gan`
const X = (n: number): string => `https://forum-${String(n)}.example/thread`
const W = (n: number): string => `https://guide-${String(n)}.example/laptop-watts`
const L = (n: number): string => `https://store-${String(n)}.example/100w`
const T = (n: number): string => `https://travel-${String(n)}.example/adapters`
const range = (f: (n: number) => string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => f(from + i))

/** 词 → 前 10 名自然结果的网址（编的）。 */
export const PLAN_SAMPLE_SERPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['usb c charger', range(R, 1, 10)],
  ['best usb c charger', [...range(R, 1, 7), ...range(B, 1, 3)]],
  ['gan charger', [...range(R, 1, 4), ...range(G, 1, 6)]],
  ['gan charger vs regular charger', [...range(G, 1, 5), R(1), ...range(X, 1, 4)]],
  ['how many watts to charge a laptop with usb c', [R(1), R(2), ...range(W, 1, 8)]],
  ['usb c laptop charger 100w', [R(1), R(2), ...range(W, 1, 3), ...range(L, 1, 5)]],
  ['travel charger with multiple ports', range(T, 1, 10)],
])

/** 候选词（量是编的估算；GaN 那个词我们已经排上了一页）。 */
export const PLAN_SAMPLE_KEYWORDS: readonly SeoClusterKeyword[] = [
  { keyword: 'usb c charger', volume: 60500, intent: 'unknown', from: 'related' },
  { keyword: 'best usb c charger', volume: 18100, intent: 'unknown', from: 'related' },
  {
    keyword: 'gan charger',
    volume: 9900,
    intent: 'unknown',
    impressions: 2300,
    clicks: 41,
    ranking_page: 'https://shop.example/blogs/guide/gan-chargers-explained',
    from: 'search_console',
  },
  { keyword: 'gan charger vs regular charger', volume: 1300, intent: 'unknown', from: 'related' },
  {
    keyword: 'how many watts to charge a laptop with usb c',
    volume: 4400,
    intent: 'unknown',
    from: 'related',
  },
  { keyword: 'usb c laptop charger 100w', volume: 6600, intent: 'unknown', from: 'related' },
  {
    keyword: 'travel charger with multiple ports',
    volume: 2900,
    intent: 'unknown',
    from: 'related',
  },
  { keyword: 'nordvolt charger', volume: 90, intent: 'unknown', from: 'search_console' },
]

const at = '2026-10-20T03:00:00.000Z'

const call = (
  capability: string,
  items: Record<string, unknown>[],
  credits: number,
): DataCallResult => ({
  capability,
  items,
  quantity: capability === 'seo.backlinks' ? items.length : 1,
  credits,
  cached: false,
  fetched_at: at,
  source: 'official',
})

const row = (
  from: string,
  anchor: string,
  extra: { domain_rating?: number; spam_score?: number; to?: string } = {},
): Record<string, unknown> => ({
  url_from: `https://${from}/post`,
  domain_from: from,
  url_to: extra.to ?? 'https://shop.example/',
  anchor,
  ...(extra.domain_rating === undefined ? {} : { domain_rating: extra.domain_rating }),
  ...(extra.spam_score === undefined ? {} : { spam_score: extra.spam_score }),
})

/** 我们这家（上一次体检时是 181 个来源域名）。 */
export const BACKLINK_SAMPLE_PREVIOUS = { referring_domains: 181, backlinks: 1975 } as const

/** 录好的回包：我们这家的外链概况（一行）。 */
export const BACKLINK_SAMPLE_SUMMARY: DataCallResult = call(
  'seo.backlink_summary',
  [
    {
      target: 'shop.example',
      rank: 31,
      backlinks: 1840,
      referring_domains: 142,
      referring_main_domains: 131,
      broken_backlinks: 12,
      spam_score: 8,
      estimate: true,
    },
  ],
  0.88,
)

/** 录好的回包：我们这家的外链（30 条）。 */
export const BACKLINK_SAMPLE_ROWS: DataCallResult = call(
  'seo.backlinks',
  [
    ...Array.from({ length: 12 }, () =>
      row('linkfarm-seo.example', 'usb c charger', { domain_rating: 3, spam_score: 74 }),
    ),
    ...[
      'gadget-blog.example',
      'deskreview.example',
      'techdad.example',
      'unboxweekly.example',
      'nomadgear.example',
      'hifi-notes.example',
    ].map((d) => row(d, 'NordVolt Gear', { domain_rating: 40 })),
    ...['coupons-hub.example', 'deal-feed.example', 'linklist.example', 'gadget-blog.example'].map(
      (d) => row(d, 'shop.example', { domain_rating: 22 }),
    ),
    ...['forum-chargers.example', 'qa-site.example', 'tips-daily.example'].map((d) =>
      row(d, 'click here', { domain_rating: 18 }),
    ),
    ...[
      'charge-guide.example',
      'power-tips.example',
      'cable-matters.example',
      'travel-tech.example',
      'desk-setup.example',
    ].map((d) => row(d, 'usb c charger', { domain_rating: 27 })),
  ],
  0.3,
)

const comp = (domains: readonly [string, number][], target: string): Record<string, unknown>[] =>
  domains.map(([d, dr]) => row(d, 'charger', { domain_rating: dr, to: `https://${target}/` }))

/** 录好的回包：两家竞品的外链（竞品差距用）。 */
export const BACKLINK_SAMPLE_COMPETITORS: ReadonlyMap<string, DataCallResult> = new Map([
  [
    'voltpeak.example',
    call(
      'seo.backlinks',
      comp(
        [
          ['outdoor-lab.example', 78],
          ['techradar-like.example', 82],
          ['gadget-blog.example', 40],
          ['laptop-mag.example', 70],
          ['camping-world-blog.example', 55],
          ['vanlife-notes.example', 33],
          ['student-tech.example', 29],
          ['spammy-dir.example', 2],
          ['podcast-gear.example', 47],
          ['photo-kit.example', 51],
        ],
        'voltpeak.example',
      ).map((r) => (r.domain_from === 'spammy-dir.example' ? { ...r, spam_score: 88 } : r)),
      0.1,
    ),
  ],
  [
    'chargely.example',
    call(
      'seo.backlinks',
      comp(
        [
          ['outdoor-lab.example', 78],
          ['techradar-like.example', 82],
          ['laptop-mag.example', 70],
          ['remote-work-weekly.example', 44],
          ['ev-forum.example', 38],
          ['minimal-desk.example', 36],
          ['vanlife-notes.example', 33],
          ['phone-repair-guide.example', 25],
        ],
        'chargely.example',
      ),
      0.08,
    ),
  ],
])
