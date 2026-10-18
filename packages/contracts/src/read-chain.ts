/**
 * WP402（决策 1140 / 1146，Luoye 10-19 改定）：**读外部网页取数据的备用路**——竞品独立站、Amazon 前台、
 * Amazon 联想词这些「读别人公开页面」的地方，统一成一条可复用的取数链：
 *
 * 1. **工坊内置浏览器**（本机，免费；独立站在它前面还有一步「本机直接请求」）；
 * 2. **工坊云端接口**（Amazon 是 `amazon.product`，独立站是云端代读 {@link SHOP_PAGE_CLOUD_CAPABILITY}；按积分计价）；
 * 3. **通过插件操作用户自己的浏览器**（只读页面：打开、读回原文，不点不填）；
 * 4. 都不行就照实说，下一轮再试。
 *
 * 规矩：不伪装 UA；被拦（403 / 验证页）就换下一条路，不在同一条路上硬试；429 限速按退避（等一会儿再试同一条，
 * 还是 429 才换路）。**Amazon 走第 3 条**（用户自己的浏览器里多半登着他的真实账号）只在前两条都失败时用、
 * 每家竞品每天至多一次、第一次用前出一张卡问同意（同意后不再问，可在设置里撤回）；独立站走第 3 条不需额外同意。
 *
 * 每次结果都记下走了哪条路（{@link ReadRouteAttempt}），给面板「连接」卡和报告用。用户看得到的字不提任何实现名。
 */
import type { Iso8601 } from './common.js'

/** 取数链上的一条路（`direct` 只有独立站有：本机直接请求公开数据地址）。 */
export type ReadRoute = 'direct' | 'browser' | 'cloud' | 'extension'

/** 备用路的固定顺序（`direct` 在最前，只有能直接请求的地方才有）。 */
export const READ_ROUTE_ORDER: readonly ReadRoute[] = ['direct', 'browser', 'cloud', 'extension']

/** 每条路对用户说的名字（不提任何供应商 / 实现名）。 */
export const READ_ROUTE_LABEL: Readonly<Record<ReadRoute, { zh: string; en: string }>> = {
  direct: { zh: '直接读', en: 'Direct read' },
  browser: { zh: '工坊内置浏览器', en: 'Built-in browser' },
  cloud: { zh: '工坊云端', en: 'Workshop cloud' },
  extension: { zh: '你自己的浏览器（插件）', en: 'Your own browser (extension)' },
}

/**
 * 一条路这一次的结局：
 * - `ok` 读到了；
 * - `blocked` 被拦（403 / 验证页 / 对方机器人防护）→ 换下一条；
 * - `rate_limited` 限速（429），退避后还是 429 → 换下一条；
 * - `unavailable` 这台没有这条路（没桌面壳 / 没关联账号 / 没装插件）→ 跳过；
 * - `needs_consent` Amazon 走用户自己的浏览器还没得到同意 → 跳过、出一张卡问；
 * - `limited` 今天这一家已经用过一次用户自己的浏览器 → 跳过；
 * - `quota` 本机这一小时的读页额度满了 → 这一次不再往下换（不花钱），下一拍接着读；
 * - `failed` 读了但没读成（打不开 / 不是想要的东西）。
 */
export type ReadRouteOutcome =
  | 'ok'
  | 'blocked'
  | 'rate_limited'
  | 'unavailable'
  | 'needs_consent'
  | 'limited'
  | 'quota'
  | 'failed'

/** 取数链上试过的一条路（按试的顺序记；连接卡 / 报告用）。 */
export interface ReadRouteAttempt {
  route: ReadRoute
  outcome: ReadRouteOutcome
  /** 人话（没读成为什么）。 */
  reason?: string
}

/** 429 退避：等多久再试同一条路（毫秒，依次）；用完还是 429 就换下一条路。对方给了 Retry-After 按它、但不超过上限。 */
export const READ_RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 8_000]
export const READ_RATE_LIMIT_MAX_WAIT_MS = 30_000

/**
 * 独立站的云端代读（工坊云端接口里的一项同步能力，按次扣积分）：只读公开商品数据的那几个地址
 * （Shopify `/products.json`、`/collections/all.atom`，WooCommerce Store API `/wp-json/wc/store/v1/products`），
 * 云端照实自报身份去读，原文交回，本机用同一份解析。
 */
export const SHOP_PAGE_CLOUD_CAPABILITY = 'shop.page'

/** 云端代读只认这几种公开数据地址（路径前缀；别的地址一律不读）。 */
export const SHOP_PAGE_PATHS: readonly string[] = [
  '/products.json',
  '/collections/all.atom',
  '/wp-json/wc/store/v1/products',
  '/robots.txt',
]

/** 一个地址是不是云端代读认的公开数据地址（`https`、公开域名、路径在 {@link SHOP_PAGE_PATHS} 里）。 */
export function isShopPageUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false
  if (u.port !== '' && u.port !== '443') return false
  const host = u.hostname.toLowerCase()
  if (!host.includes('.') || /^\d+(\.\d+){3}$/u.test(host) || host.includes(':')) return false
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/u.test(host)) return false
  const path = u.pathname.replace(/\/+$/u, '')
  return SHOP_PAGE_PATHS.some((p) => path === p)
}

/* ── Amazon 走用户自己的浏览器：同意 ─────────────────────────────── */

/** 「用你自己的浏览器读 Amazon」那张同意卡的设置目标 id。 */
export const AMAZON_EXTENSION_CONSENT_TARGET = 'amazon.own_browser_read'

/** 每家竞品每天至多用几次用户自己的浏览器读 Amazon。 */
export const AMAZON_EXTENSION_DAILY_LIMIT = 1

/** 同意的状态（一个品牌一份）：同意后不再问；在设置里撤回 = 不再用、也不再问（设置里能重新打开）；点「先不用」同样不再问。 */
export interface AmazonOwnBrowserConsent {
  state: 'unasked' | 'asked' | 'granted' | 'revoked' | 'declined'
  /** 什么时候问的 / 同意的 / 撤回的 / 拒绝的。 */
  at?: Iso8601
}

/** 那张卡上的话（卡身只放这一句，细节进问号）。 */
export const AMAZON_EXTENSION_CONSENT_TEXT = {
  title: {
    zh: '内置浏览器和工坊云端都没读到，用你自己的浏览器读一下 Amazon？',
    en: 'The built-in browser and the workshop cloud both failed. Read Amazon in your own browser?',
  },
  detail: {
    zh: '只打开商品页读价格、评分这些公开信息，不点、不填、不碰你的账号；每家竞品每天至多一次。同意后不再问，可在设置里撤回。',
    en: "Only opens product pages to read public info like price and rating — no clicks, no forms, nothing on your account; at most once per competitor per day. You won't be asked again; revoke any time in Settings.",
  },
} as const

/** 品牌级「被 Amazon 拦了」的状态（竞品读页和联想词共用一份：一边被拦，另一边同时换路）。 */
export interface AmazonBlockState {
  /** 到这个时刻之前，内置浏览器不再开 Amazon 的页。 */
  paused_until?: Iso8601
  /** 哪一边先被拦的（给面板那一句「联想词那边被拦了」用）。 */
  by?: 'competitor' | 'keywords'
  at?: Iso8601
}

/** 被拦之后内置浏览器停多久不碰 Amazon（决策 1117 / 1146：24 小时，两边一样长）。 */
export const AMAZON_BRAND_PAUSE_MS = 24 * 3_600_000
