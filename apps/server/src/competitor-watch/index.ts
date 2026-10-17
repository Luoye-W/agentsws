/**
 * WP392（docs/104）：竞品监控积木——监控源同步、调度、快照对比入库、报告积木的数据口、工作台视图。
 * 进料口（读独立站 / 读 Amazon）由 WP393 / WP394 实现 `CompetitorIntakeAdapter` 接进来。
 */
export { dueSources, nextReadAt, RETRY_GAP_MS } from './due.js'
export {
  type CompetitorWatchAssembly,
  type CompetitorWatchDeps,
  createCompetitorWatch,
} from './service.js'
export { amazonHomeOf, type SourceSync, syncSources, wantedSources } from './sources.js'
export { type CompetitorWatchDb, createCompetitorWatchDb } from './store.js'
export { competitorWatchSourceOf } from './watch-source.js'
