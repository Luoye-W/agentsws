/**
 * 一份**合成的**一周 Search Console 数据（NordVolt Gear，3C 配件，`shop.example`）。
 *
 * 给测试、demo 与截图用；每一行都是编的，没有任何真实店铺的数据。它故意凑成：
 * 七件候选（三件改页、一件交建站、三件新页面）+ 两行什么信号都不响的噪声——
 * 于是"恰好 5 件、先修再写、不倾倒数据"三件事一眼看得出来。
 */
import type { GscRow, SitePage } from '@agentsws/contracts'

const S = 'https://shop.example'

export const DEMO_PAGES: readonly SitePage[] = [
  {
    url: `${S}/blogs/guide/how-to-choose-a-usb-c-charger`,
    kind: 'article',
    title: 'How to choose a USB-C charger',
    target_queries: ['how to choose a usb c charger'],
    index_status: 'indexed',
  },
  {
    url: `${S}/products/usb-c-65w-charger`,
    kind: 'product',
    title: 'USB-C 65W Charger',
    index_status: 'indexed',
  },
  {
    url: `${S}/blogs/guide/gan-chargers-explained`,
    kind: 'article',
    title: 'GaN chargers explained',
    index_status: 'indexed',
  },
  {
    url: `${S}/pages/travel-adapter-guide`,
    kind: 'page',
    title: 'Travel adapter guide',
    index_status: 'redirect',
  },
  {
    url: `${S}/blogs/guide/braided-cable-care`,
    kind: 'article',
    title: 'How to care for a braided cable',
    target_queries: ['braided cable care'],
    index_status: 'indexed',
  },
  { url: `${S}/`, kind: 'home', title: 'NordVolt Gear', index_status: 'indexed' },
  {
    url: `${S}/blogs/guide/best-magsafe-car-mount`,
    kind: 'article',
    title: 'Best MagSafe car mount',
    target_queries: ['best magsafe car mount'],
    index_status: 'indexed',
  },
]

export const DEMO_GSC_ROWS: readonly GscRow[] = [
  // ① 没人点：曝光 2400、点击率 0.25% → 改标题 / 描述 / H1 / 开头
  {
    query: 'usb c laptop charger',
    page: `${S}/products/usb-c-65w-charger`,
    clicks: 6,
    impressions: 2400,
    ctr: 0.0025,
    position: 8.4,
    clicks_prev_week: 7,
  },
  // ② 在掉：上周 40 这周 18 → 加小节
  {
    query: 'braided cable care',
    page: `${S}/blogs/guide/braided-cable-care`,
    clicks: 18,
    impressions: 1200,
    ctr: 0.015,
    position: 2.5,
    clicks_prev_week: 40,
  },
  // ③ 快到了、页面也专门写了，卡在第 13.5 位 → 从强页链一下
  {
    query: 'how to choose a usb c charger',
    page: `${S}/blogs/guide/how-to-choose-a-usb-c-charger`,
    clicks: 9,
    impressions: 800,
    ctr: 0.011,
    position: 13.5,
    clicks_prev_week: 8,
  },
  // ④ 排上了，但那一页在跳转 → 交建站
  {
    query: 'travel adapter guide europe',
    page: `${S}/pages/travel-adapter-guide`,
    clicks: 5,
    impressions: 700,
    ctr: 0.007,
    position: 11,
    clicks_prev_week: 6,
  },
  // ⑤ 对比类查询落在一篇随笔上 → 要一页对比（新页面）
  {
    query: 'gan vs silicon charger',
    page: `${S}/blogs/guide/gan-chargers-explained`,
    clicks: 12,
    impressions: 1500,
    ctr: 0.008,
    position: 9,
    clicks_prev_week: 11,
  },
  // ⑥ "计算器"类查询落在文章上 → 新页面（第六件，挤不进今天的 5 件）
  {
    query: 'usb c charger wattage calculator',
    page: `${S}/blogs/guide/how-to-choose-a-usb-c-charger`,
    clicks: 2,
    impressions: 650,
    ctr: 0.003,
    position: 15,
    clicks_prev_week: 2,
  },
  // ⑦ 像问 AI 一样的长句，落在一个我们没登记的集合页上 → 新页面（第七件）
  {
    query: 'what charger do i need for a macbook pro 16 inch',
    page: `${S}/collections/chargers`,
    clicks: 1,
    impressions: 300,
    ctr: 0.0033,
    position: 24,
    clicks_prev_week: 1,
  },
  // 强页：点击最多，排第 1.8（不在 3–20 之内，什么信号都不响）
  {
    query: 'best magsafe car mount',
    page: `${S}/blogs/guide/best-magsafe-car-mount`,
    clicks: 210,
    impressions: 3000,
    ctr: 0.07,
    position: 1.8,
    clicks_prev_week: 190,
  },
  // 噪声：品牌词、排在第 35 位的短词——什么信号都不响，也不该上卡
  {
    query: 'nordvolt charger',
    page: `${S}/`,
    clicks: 150,
    impressions: 600,
    ctr: 0.25,
    position: 1.1,
    clicks_prev_week: 140,
  },
  {
    query: 'usb c cable',
    page: `${S}/products/usb-c-65w-charger`,
    clicks: 0,
    impressions: 100,
    ctr: 0,
    position: 35,
  },
]

export const DEMO_BRAND_TERMS: readonly string[] = ['nordvolt']
export const DEMO_OUR_DOMAINS: readonly string[] = ['shop.example']
