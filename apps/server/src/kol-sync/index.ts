/**
 * WP509（决策 1730 B、1811）：一句话把红人同步到用户自己的飞书表——经 ego 写，不要飞书开发者应用。见各文件头。
 */
export {
  EGO_SHEET_TIMEOUT_MS,
  type EgoSheetCall,
  type EgoSheetResult,
  egoSheetSpaceName,
  parseEgoSheetOutput,
  runEgoSheetWrite,
} from './runner.js'
export {
  EGO_SHEET_ADD_ROW,
  EGO_SHEET_FORBID,
  EGO_SHEET_KEYS,
  type EgoSheetOp,
  type EgoSheetScriptConfig,
  egoSheetScript,
} from './script.js'
export {
  collectSyncRows,
  createKolSync,
  inspectSyncTable,
  KOL_SYNC_DEBOUNCE_MS,
  KOL_SYNC_FORM,
  KOL_SYNC_PROPOSER,
  KOL_SYNC_SETUP_PATH,
  type KolSync,
  type KolSyncCardPayload,
  type KolSyncEgo,
  type KolSyncOptions,
  type KolSyncProposeInput,
  localTime,
  syncWhy,
  tableNameOf,
} from './service.js'
export {
  createKolSyncStore,
  type KolSyncLog,
  type KolSyncSink,
  type KolSyncStore,
} from './store.js'
export {
  bitableColumns,
  isFeishuTableUrl,
  parseTsvKeep,
  type SyncTable,
  syncKindOfUrl,
  syncTableOf,
} from './table.js'
