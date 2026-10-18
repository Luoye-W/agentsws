/**
 * WP392（docs/104）：竞品监控积木——监控源同步、调度、快照对比入库、报告积木的数据口、工作台视图。
 * 进料口（读独立站 / 读 Amazon）由 WP393 / WP394 实现 `CompetitorIntakeAdapter` 接进来。
 */
// WP394（docs/104 一期 B）：Amazon 对标款的进料口、方案卡、现在读一次
export {
  AMAZON_BATCH_TRIES,
  type AmazonAsinAdapterDeps,
  createAmazonAsinAdapter,
} from './amazon-adapter.js'
export {
  AMAZON_CREDITS_KEY,
  AMAZON_PICKS_PER_COMPETITOR,
  AMAZON_PLAN_COMPETITORS_MAX,
  type AmazonCompetitorAssembly,
  type AmazonCompetitorDeps,
  type AmazonReadNowResult,
  createAmazonCompetitor,
  parseAmazonPairs,
} from './amazon-plan.js'
export { createAmazonCompetitorTools } from './amazon-tools.js'
export { dueSources, nextReadAt, RETRY_GAP_MS } from './due.js'
// WP393：店铺管理「竞品动向」（独立站进料口、自家店价、方案卡、探平台 / 现在读一次、简报那一段）
export { type OwnShopRead, readOwnShopProducts } from './own-shop.js'
export {
  type CompetitorWatchAssembly,
  type CompetitorWatchDeps,
  createCompetitorWatch,
} from './service.js'
export { browserTextReadOf, createShopCatalogAdapter, nodePageFetch } from './shop-adapter.js'
export { amazonHomeOf, type SourceSync, syncSources, wantedSources } from './sources.js'
export { type CompetitorWatchDb, createCompetitorWatchDb } from './store.js'
export {
  type CompetitorStoreAssembly,
  type CompetitorStoreDeps,
  createCompetitorStore,
  type ReadNowResult,
} from './store-plan.js'
export { createCompetitorStoreTools } from './store-tools.js'
export { competitorWatchSourceOf } from './watch-source.js'
