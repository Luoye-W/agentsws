/**
 * `@agentsws/deck` —— 卡片与积木的纯逻辑层（36 §5.8：为 1c 与 KefuAgent 共享做准备）。
 *
 * 这里没有 IO、没有框架、没有模型：给结构化输入就出结构化输出。
 * 服务端用它算 payload（29 原则 ③「数字不经模型手」），前端用同一份类型渲染。
 */
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
  INSTRUCTION_SCOPES,
  type ResolveOptions,
  resolveDecision,
} from './decide.js'
export { DeckError, type DeckErrorReason, errorCodeFor } from './errors.js'
export { assembleHome, type HomeInput, type HomePosition } from './home.js'
export {
  actionsFor,
  DECIDABLE_STATES,
  labelsFor,
  minutesFor,
  READ_ONLY_ACTIONS,
  riskClassFor,
} from './matrix.js'
export {
  contentVariantsOf,
  entityChipsOf,
  estimatedMinutes,
  evidenceChipsOf,
  highlightsOf,
  MAX_ENTITY_CHIPS,
  MAX_EVIDENCE_CHIPS,
  optionsOf,
  priorityBandOf,
  projectCard,
  sourceOf,
} from './project.js'
export {
  QUERIES,
  type QueryDef,
  queryDef,
  queryNames,
  type RangeWindows,
  rangeWindows,
  runQuery,
  sourceStatus,
  startOfDay,
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
  ALL_DATA_SOURCES,
  ALWAYS_CONNECTED,
  type ConnectionLike,
  dataSourcesFromConnections,
  dataSourcesOfService,
  mergeDataSources,
  SOURCES_BY_SERVICE,
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
