/**
 * `@agentsws/creator-capture`（WP496，决策 1739 A）：红人主页 / 内容页 / 列表页 / 链接页的**读取规则**——
 * 浏览器插件与 ego 路共用同一套。
 *
 * | 目录 | 是什么 | 出处 |
 * |---|---|---|
 * | `kol/` | 指标算法（体检、受众真实性、频道估值、导出列、批量节奏）与快照类型 | 私有插件 `src/lib/kol/` @ 57fca9c（源自 KOLAgents 旧插件 d25b877），本体逐字不动 |
 * | `kol/utils/` | 快照类型、YouTube 搜索页 / 链接页采集器、数字解析 | 私有插件 `src/lib/kol/utils/` @ 57fca9c |
 * | `collectors/` | 主页 / 内容页 / 列表页采集器（DOM 只读） | 私有插件 `src/contents/utils/` @ 57fca9c |
 * | `wire/` | 快照 → 本机 `ingest` 请求体（主页观测、列表批量、内容观测、链接页观测、公开联系方式） | 私有插件外壳 `pluginApi.ts` / `local-handlers.ts` / `public-contacts.ts` 等 |
 * | `page/` + `page-script*.ts` | 在页面里读一遍（ego 用 `page.evaluate` 注入；插件是 content script 直接调） | 新写 |
 * | `metrics.ts` | 快照 → 面板上那几块算出来的数 | 新写（只调上面的算法） |
 *
 * 不在这里的：面板 / 设置页 / 任何界面、插件框架、浏览器存储、发请求、面板文案——那些只在私有插件里。
 */

export type { ListCaptureTarget } from './collectors/listCaptureTarget.js'
export { resolveListCaptureTarget } from './collectors/listCaptureTarget.js'
export { type PanelRoute, resolvePanelRoute } from './collectors/panelRoute.js'
export {
  bioLinkCacheKey,
  type CachedBioLink,
  expandBioLinks,
  mergeProfileLinks,
} from './kol/bioLinkCache.js'
export { toBulkObservationItem } from './kol/bulkCapture.js'
export type { BulkObservationItem } from './kol/bulkWire.js'
export type { Lang } from './kol/language.js'
export { activeLang, setActiveLang } from './kol/language.js'
export type { BioLinkObservationPayload, BioLinkSnapshot } from './kol/utils/bioLink.js'
export { isBioLinkPage, toBioLinkObservationPayload } from './kol/utils/bioLink.js'
export type { ContentObservationPayload, ContentSnapshot } from './kol/utils/contentSnapshot.js'
export { toContentObservationPayload } from './kol/utils/contentSnapshot.js'
export type {
  CapturePlatform,
  CreatorSnapshot,
  ObservationPayload,
  ProfileLink,
  RecentItem,
  UploadRegularity,
} from './kol/utils/creatorSnapshot.js'
export { toObservationPayload } from './kol/utils/creatorSnapshot.js'
export type { SearchCreatorCandidate } from './kol/utils/youtubeSearch.js'
export {
  type ContentMetrics,
  type CreatorMetrics,
  contentMetrics,
  creatorMetrics,
} from './metrics.js'
export type { PageCapture, PageCaptureOptions, PageListCapture } from './page/capture.js'
export { CREATOR_CAPTURE_PAGE_BUNDLE } from './page-script.generated.js'
export {
  creatorCapturePageExpression,
  creatorCapturePageTemplate,
  PAGE_ARGS_PLACEHOLDER,
  type PageScriptInput,
} from './page-script.js'
export { followersFromText } from './wire/followerCount.js'
export { listContentObservations, listSourcePage, listSourceUrl } from './wire/listContent.js'
export {
  type BioLinkObservationBody,
  bioLinkObservationBodyOf,
  type CaptureObservation,
  type ContentObservationBody,
  contentObservationBodyOf,
  creatorObservationOf,
  type ListBatch,
  listContentBodiesOf,
  listObservationsOf,
} from './wire/observations.js'
export { type IngestPlan, type IngestPlanOptions, ingestPlanOf } from './wire/plan.js'
export { publicContactOfLink, publicContactsOfProfile } from './wire/publicContacts.js'
