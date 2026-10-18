/**
 * WP396（docs/106 §13）：体检读 Amazon 前台页用的口子。
 *
 * **读页本身不在本单**：内置浏览器打开 Amazon、User-Agent 带 `Agent/AgentsWorkshop`、配送邮编、
 * 被拦就停退云端——那一套是 WP394 的积木（docs/104 一期 B）。这里只定「体检要它交回什么」，
 * 服务端装配时把 WP394 的读页积木接到 `ServerOptions.amazonListingReader` 上；没接 = 照实说「这里读不了」。
 *
 * 纪律（docs/106 §2.1 Agent Policy）：不模仿人的节奏、不过验证码、**被拦就停**——读到验证页回 `blocked`，
 * 体检这一轮不再碰 Amazon，不重试、不换办法绕。每读一页算进内置浏览器每小时的额度（决策 914），
 * 额度满了回 `quota`。
 */
export type ListingPageRead =
  | { status: 'ok'; url: string; html: string }
  | { status: 'blocked'; url: string; message?: string }
  | { status: 'quota'; message?: string }
  | { status: 'failed'; url: string; message: string }

export interface AmazonListingReader {
  /** 读一页商品页 `/dp/{ASIN}`（站点按国家码）。 */
  readProduct(input: { marketplace: string; asin: string }): Promise<ListingPageRead>
  /** 搜一页（自家 ASIN 还没填时用品牌名搜，给建议）。没有 = 只能让人自己贴。 */
  search?(input: { marketplace: string; query: string }): Promise<ListingPageRead>
}

/** 站点国家码 → 前台域名（与 `amz/store.yml` 的 `browser_scope` 对得上）。 */
const HOSTS: Readonly<Record<string, string>> = {
  US: 'www.amazon.com',
  CA: 'www.amazon.ca',
  MX: 'www.amazon.com.mx',
  BR: 'www.amazon.com.br',
  GB: 'www.amazon.co.uk',
  UK: 'www.amazon.co.uk',
  DE: 'www.amazon.de',
  FR: 'www.amazon.fr',
  IT: 'www.amazon.it',
  ES: 'www.amazon.es',
  NL: 'www.amazon.nl',
  SE: 'www.amazon.se',
  PL: 'www.amazon.pl',
  BE: 'www.amazon.com.be',
  TR: 'www.amazon.com.tr',
  AE: 'www.amazon.ae',
  SA: 'www.amazon.sa',
  EG: 'www.amazon.eg',
  IN: 'www.amazon.in',
  JP: 'www.amazon.co.jp',
  AU: 'www.amazon.com.au',
  SG: 'www.amazon.sg',
}

export function amazonHostOf(marketplace: string): string | undefined {
  return HOSTS[marketplace.trim().toUpperCase()]
}

/** 商品页地址（站点认不出回 `undefined`）。 */
export function amazonProductUrl(marketplace: string, asin: string): string | undefined {
  const host = amazonHostOf(marketplace)
  return host === undefined ? undefined : `https://${host}/dp/${asin.trim().toUpperCase()}`
}

/** 站点 → 那个站的币种（读到的币种对不上 = 配送地址没设对，这次读数作废）。 */
const CURRENCY: Readonly<Record<string, string>> = {
  US: 'USD',
  CA: 'CAD',
  MX: 'MXN',
  BR: 'BRL',
  GB: 'GBP',
  UK: 'GBP',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  JP: 'JPY',
  IN: 'INR',
  AU: 'AUD',
  SG: 'SGD',
}

export function amazonCurrencyOf(marketplace: string): string | undefined {
  return CURRENCY[marketplace.trim().toUpperCase()]
}
