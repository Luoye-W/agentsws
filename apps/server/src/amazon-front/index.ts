/**
 * WP394（docs/104 一期 B，docs/106 §13 A9）：读 Amazon 前台的那一块（内置浏览器自报 Agent、配送邮编、被拦就停）
 * 与云端兜底。竞品对标款（本单）、自家 Listing 体检（WP396）共用；联想词是 WP398 那一份。
 */

// WP402（决策 1140 / 1146）：品牌级「被 Amazon 拦了」（竞品读页与联想词共用）、走你自己的浏览器（同意 / 每家每天一次）
export { type AmazonBlockDeps, type AmazonBlockPort, createAmazonBlock } from './block.js'
export {
  AMAZON_CLOUD_POLL_MS,
  AMAZON_CLOUD_WAIT_MS,
  type AmazonCloudPort,
  amazonCloudItemOf,
  readAmazonCloud,
} from './cloud.js'
export {
  type AmazonOwnBrowser,
  type AmazonOwnBrowserDeps,
  type AmazonOwnBrowserState,
  createAmazonOwnBrowser,
  localDay,
  OWN_BROWSER_KEYWORDS_KEY,
} from './own-browser.js'
export {
  AMAZON_BLOCK_PAUSE_MS,
  AMAZON_DELIVERY_FRESH_MS,
  AMAZON_PAGE_TIMEOUT_MS,
  type AmazonCardsRead,
  type AmazonFrontReader,
  type AmazonFrontReaderDeps,
  type AmazonFrontState,
  type AmazonRawRead,
  type AmazonStorefrontRead,
  createAmazonFrontReader,
} from './reader.js'
