/**
 * `@agentsws/deck` —— 卡片与积木的纯逻辑层（36 §5.8：为 1c 与 KefuAgent 共享做准备）。
 *
 * 这里没有 IO、没有框架、没有模型：给结构化输入就出结构化输出。
 * 服务端用它算 payload（29 原则 ③「数字不经模型手」），前端用同一份类型渲染。
 */
export {
  type Anomaly,
  type AnomalyInput,
  type AnomalyKind,
  detectAnomalies,
} from './anomalies.js'
// WP125（72 §P0-3 ⑤）：四个优先级带的名字与分组计数（派生，不存列）
export {
  BAND_LABELS,
  BAND_ORDER,
  type BandGroup,
  bandCounts,
  bandSummaryLine,
  groupByBand,
} from './bands.js'
export {
  allBlocks,
  assembleView,
  blockDef,
  blocksForRole,
  COMPONENTS,
  computeBlock,
  isRegisteredComponent,
  SOURCE_LABELS,
  SOURCE_REPORT_URLS,
  validatePayload,
} from './blocks.js'
export {
  DEFAULT_SNOOZE_MS,
  HANDOFF_DECLINE_NO_REASON,
  INSTRUCTION_SCOPES,
  REJECT_NO_REASON,
  type ResolveOptions,
  resolveDecision,
} from './decide.js'
export { DeckError, type DeckErrorReason, errorCodeFor } from './errors.js'
export { assembleHome, type HomeInput, type HomePosition } from './home.js'
// WP459（决策 1497–1505）：收件箱——所有岗位等你批的卡 + 要你判断的信一条队列
export {
  filterInbox,
  INBOX_UNASSIGNED,
  INBOX_URGENCY_ORDER,
  type InboxBrief,
  type InboxCounts,
  type InboxFilter,
  type InboxGuess,
  type InboxItem,
  type InboxMail,
  type InboxPosition,
  type InboxPrimary,
  type InboxTag,
  type InboxUrgency,
  type InboxView,
  inboxCounts,
  inboxUrgencyOfCard,
  inboxUrgencyOfMail,
  sortInbox,
} from './inbox.js'
export {
  DECK_LAYOUTS,
  DEFAULT_LAYOUT,
  type DeckLayout,
  isQueueCard,
  LAYOUT_BY_CHANGE,
  LAYOUT_BY_KIND,
  layoutFor,
  NOT_A_CARD,
} from './layout.js'
export {
  actionsFor,
  DECIDABLE_STATES,
  labelsFor,
  minutesFor,
  READ_ONLY_ACTIONS,
  riskClassFor,
} from './matrix.js'
export {
  CONFIRM_ONLY_FORMS,
  contentVariantsOf,
  entityChipsOf,
  estimatedMinutes,
  evidenceChipsOf,
  highlightsOf,
  isHandoffItem,
  isOwnSubModerationItem,
  isRouteChoiceItem,
  MAX_ENTITY_CHIPS,
  MAX_EVIDENCE_CHIPS,
  optionsOf,
  priorityBandOf,
  projectCard,
  sourceOf,
} from './project.js'
export {
  ANOMALY_DEFAULTS,
  dayLabel,
  PENDING_LANES,
  QUERIES,
  type QueryDef,
  queryDef,
  queryNames,
  type RangeWindows,
  rangeWindows,
  runQuery,
  sourceStatus,
  startOfDay,
  thresholdOf,
  type Window,
} from './queries.js'
export {
  CONTENT_MODES,
  compareCards,
  filterCards,
  foldCards,
  isCustomerWaiting,
  isMergeable,
  isNobodyWaiting,
  mergeKeyOf,
  type PickedContent,
  pickContent,
  sortCards,
  waitingOf,
} from './queue.js'
export {
  BATTLE_REPORT_EVENT_TYPES,
  type BattleReportOptions,
  battleReport,
} from './recap.js'
export {
  DEFAULT_REPORTS,
  defaultReport,
  defaultReportsFor,
  FALLBACK_RECIPE,
  matchRecipe,
  PINNED_REPORT_LIMIT,
  REPORT_EXAMPLES,
  REPORT_RECIPES,
  type ReportRecipe,
  specFromRecipe,
} from './report-catalog.js'
// WP438（WP434 第二阶段，决策 1332–1336）：报表规格、指标表、默认报表与 AI 小报表配方
export {
  type BarsPayload,
  type ComputeReportOptions,
  computeMetric,
  computeReport,
  conclusionOf,
  type FunnelPayload,
  formatReportValue,
  type KpisPayload,
  kpiKeys,
  metricSpark,
  ORDER_CHANNEL_LABELS,
  type OrderChannel,
  orderChannel,
  RANGE_DAYS,
  type RankPayload,
  REPORT_DATASETS,
  REPORT_METRICS,
  REPORT_RANGES,
  type ReportAction,
  type ReportBlockData,
  type ReportBlockSpec,
  type ReportConclusion,
  type ReportData,
  type ReportEvent,
  type ReportFormat,
  type ReportMetricValue,
  type ReportNeed,
  type ReportRange,
  type ReportRefresh,
  type ReportSourceRef,
  type ReportSpec,
  type ReportStatus,
  type ReportSummary,
  type ReportWindows,
  reportDatasetIds,
  reportDay,
  reportEvents,
  reportMetricDef,
  reportSources,
  reportWindows,
  type SharePayload,
  type StackedPayload,
  summarizeReport,
  type TablePayload,
  type TilesPayload,
  type TrendPayload,
  validateReportSpec,
} from './reports.js'
export {
  ALL_DATA_SOURCES,
  ALWAYS_CONNECTED,
  type ConnectionLike,
  dataSourcesFromConnections,
  dataSourcesOfService,
  mergeDataSources,
  PLANNED_SOURCE_NOTES,
  SOCIAL_SOURCE_BY_CHANNEL,
  SOURCES_BY_SERVICE,
  withOwnSources,
  withReadVia,
} from './sources.js'
export {
  computeTile,
  computeTiles,
  DEFAULT_HOME_TILES,
  defaultTilesFor,
  MAX_TILES_PER_POSITION,
  TILE_LIBRARY,
  tileSpec,
  validateTileSelection,
} from './tiles.js'
export type * from './types.js'
export {
  CATEGORY_BY_CHANGE,
  CATEGORY_BY_KIND,
  categoryKey,
  type DeckVerb,
  LAYOUT_VERBS,
  type LayoutVerbs,
  MANUAL_SEND_VERB_KIND,
  verbKey,
  verbRank,
} from './verbs.js'
// WP224（docs/91 §2.2 #1）：本周经营一页纸——各岗位面板上已有的数汇成一页，取不到写「没接」
export {
  composeWeeklyReview,
  mondayOf,
  reviewLength,
  type WeeklyReviewInput,
} from './weekly-review.js'
