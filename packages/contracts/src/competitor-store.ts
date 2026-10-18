/**
 * WP393（docs/104 一期 A，C1 / C5 / C8，Luoye 10-18）：网站运营 · 店铺管理的第六个能力面「竞品动向」——
 * 盯竞品**独立站**（Shopify / WooCommerce 店里公开的商品数据）的上新、改价、打折、断货。
 *
 * 读、比、存都在 WP392 那条管道里（`competitor-watch.ts`）；这里只放本能力面自己的几样：
 *
 * - {@link StoreProbeResult}：探平台（给一个官网，读一下店里那两个公开地址，认出是 Shopify / WooCommerce / 都不是）；
 * - {@link CompetitorStorePlan}：方案卡存下的那一份——哪几种变化算「重要」（AI 按品类建议、用户确认，C5 不预设）、
 *   竞品哪一款对标自家哪一款（C8）；
 * - {@link OwnShopProduct}：自家店里的一件商品（从已连店铺读，比价用）。
 *
 * 纪律：只读外部公开页面、不碰用户的外部账号 → 不出审批卡（docs/104 §5 第 4 条）；
 * 用户看得到的字不提任何数据供应商名 / 实现库名，只说「直接读他店里公开的商品数据」这类人话。
 */
import type { Iso8601 } from './common.js'

/** 方案卡的设置目标 id（`request_setup` / 工具回 `needs_setup` 认它）。 */
export const COMPETITOR_STORE_TARGET = 'store.competitor_watch'

/** 竞品独立站的平台（同 `BrandWatchStore.platform`）。 */
export type CompetitorStorePlatform = 'shopify' | 'woocommerce' | 'other' | 'unknown'

/**
 * 每家走哪条路（方案卡 / 连接卡上一行人话）：
 * - `direct`：本机直接读他店里公开的商品数据；
 * - `browser`：对方挡了直接读，改用工坊内置浏览器打开同一个地址读；
 * - `unsupported`：不是 Shopify / WooCommerce，暂时读不了商品数据（三期再做）；
 * - `blocked`：直接读和内置浏览器都被挡了；
 * - `unreachable`：打不开这个网站（域名不对 / 连不上）。
 * - WP402：`cloud` 前两条都被挡，工坊云端代读同一份公开数据；`extension` 再不行，通过插件在你自己的浏览器里读。
 */
export type CompetitorStoreRoute =
  | 'direct'
  | 'browser'
  | 'unsupported'
  | 'blocked'
  | 'unreachable'
  | 'cloud'
  | 'extension'

export const COMPETITOR_STORE_ROUTE_TEXT: Readonly<
  Record<CompetitorStoreRoute, { zh: string; en: string }>
> = {
  direct: { zh: '直接读他店里公开的商品数据', en: "Reads the store's public product data" },
  browser: {
    zh: '对方挡了直接读，改用工坊内置浏览器读同一份公开数据',
    en: 'Blocked for direct reads; reads the same public data in the built-in browser',
  },
  unsupported: {
    zh: '这家网站暂时读不了商品数据',
    en: "Can't read this site's product data yet",
  },
  blocked: { zh: '对方把读取挡了，这次没读到', en: 'The site blocked reading this time' },
  unreachable: { zh: '打不开这个网站', en: "Couldn't open this site" },
  cloud: {
    zh: '直接读和内置浏览器都被挡了，改由工坊云端读同一份公开数据（按次扣积分）',
    en: 'Blocked locally; the workshop cloud reads the same public data (credits per read)',
  },
  extension: {
    zh: '前几条路都没读到，通过插件在你自己的浏览器里读同一份公开数据',
    en: 'Other routes failed; reads the same public data in your own browser via the extension',
  },
}

/** 探平台的结果（写进 `BrandWatchCompetitor.store`；地址按跳转后的存）。 */
export interface StoreProbeResult {
  /** 跳转之后的店铺首页（`https://www.aventon.com`）；打不开就是原样规整过的地址。 */
  url: string
  platform: CompetitorStorePlatform
  route: CompetitorStoreRoute
  /** 这一次是怎么探出来的（WP402 加云端代读 / 你自己的浏览器）。 */
  via?: 'direct' | 'browser' | 'cloud' | 'extension'
  /** 没探出来的那一句人话。 */
  reason?: string
  checked_at: Iso8601
}

/**
 * 哪几种变化算「重要」——AI 按品类给建议、用户在方案卡上确认（C5：不预设）。
 * **没有确认过的方案 = 一条都不算重要**：简报不出「竞品动向」这一段，变化照样进变化表。
 */
export interface CompetitorImportanceRules {
  /** 降价幅度到这个数（%）及以上算重要；不填 = 不按幅度算。 */
  price_drop_pct?: number
  /** 降价后比你的对标款便宜就算重要（要连上你的店才比得了）。 */
  cheaper_than_own?: boolean
  /** 上新算重要。 */
  new_products?: boolean
  /** 开始打折算重要。 */
  discounts?: boolean
  /** 断货 / 补货算重要。 */
  stock?: boolean
  /** 下架算重要。 */
  removed?: boolean
}

/** 竞品的一款对标自家哪一款（C8；AI 按标题 / 品类配，人在方案卡上能改）。 */
export interface CompetitorProductPair {
  competitor_id: string
  /** 竞品商品键（Shopify / WooCommerce 商品 id）。 */
  product_key: string
  /** 竞品商品标题快照（卡上给人看）。 */
  title?: string
  /** 自家商品键（店铺商品 handle）。 */
  own_key: string
  own_title?: string
  /** 谁配的：AI 自动配 / 人在方案卡上改过。人改过的 AI 不再动。 */
  by: 'ai' | 'user'
}

/** 方案卡存下的那一份（每个品牌一份，存在竞品监控库的杂项里）。 */
export interface CompetitorStorePlan {
  rules: CompetitorImportanceRules
  pairs: CompetitorProductPair[]
  /** 用户点「就这样」/ 改完保存的时刻。 */
  confirmed_at: Iso8601
  /** AI 给建议时按的品类（一句，卡上那句理由里用）。 */
  category?: string
}

/** 自家店里的一件商品（从已连店铺读；C8 比价用）。 */
export interface OwnShopProduct {
  /** 店铺商品 handle。 */
  key: string
  title: string
  /** 现价（多个款式取最低那一个，「$1,799 起」）。 */
  price?: number
  currency?: string
  product_type?: string
  url?: string
}
