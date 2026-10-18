/**
 * WP394（docs/104 一期 B，docs/106 §13 A9）：读 Amazon 前台的那一块（内置浏览器自报 Agent、配送邮编、被拦就停）
 * 与云端兜底。竞品对标款（本单）、自家 Listing 体检（WP396）共用；联想词是 WP398 那一份。
 */
export {
  AMAZON_CLOUD_POLL_MS,
  AMAZON_CLOUD_WAIT_MS,
  type AmazonCloudPort,
  amazonCloudItemOf,
  readAmazonCloud,
} from './cloud.js'
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
