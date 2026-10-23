/**
 * WP493（决策 1718 / 1708）：ego 只读通道——读页、读 Reddit、读在线表格。见各文件头。
 */
export {
  type ChainPageRead,
  createPageReadChain,
  type PageReadChain,
  type PageReadChainOptions,
  type PageReadVia,
} from './chain.js'
export {
  createEgoPageReader,
  type EgoFetchRead,
  type EgoPageRead,
  type EgoPageReader,
  type EgoPageReaderOptions,
  egoReadWhy,
} from './reader.js'
export { createEgoReadiness, type EgoReadiness, type EgoReadinessOptions } from './ready.js'
export {
  createEgoRedditPump,
  type EgoRedditPump,
  type EgoRedditPumpOptions,
  type EgoRedditWatchPort,
  egoRedditRead,
} from './reddit.js'
export {
  EGO_READ_TIMEOUT_MS,
  type EgoPageSnapshot,
  type EgoReadCall,
  type EgoReadResult,
  type EgoReadStepResult,
  egoReadSpaceName,
  parseEgoReadOutput,
  runEgoRead,
} from './runner.js'
export {
  EGO_READ_FORBID_CLICK,
  EGO_READ_KEYS,
  EGO_READ_SAFE_CLICK,
  type EgoReadScriptConfig,
  type EgoReadStep,
  type EgoReadTarget,
  egoReadScript,
} from './script.js'
export {
  bitableGrid,
  copiedGrid,
  createEgoSheetReader,
  type EgoSheetReaderOptions,
  FEISHU_EXPORT_CLICKS,
  googleCsvPaths,
  type OnlineSheetKind,
  type OnlineSheetRead,
  type OnlineSheetReader,
  type OnlineSheetVia,
  onlineSheetCall,
  onlineSheetKindOf,
  onlineSheetResult,
  onlineSheetWhy,
  parseTsv,
  sheetPageBlock,
  unescapeEntities,
} from './sheet.js'
