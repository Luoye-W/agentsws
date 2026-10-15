/**
 * 广告上传表（docs/101 §5.1②、§5.4 WP314；决策 552 / 553）。
 *
 * 对外入口：`buildAdUploadBundle`（查 → 出表 → 复查 → 摘要 → 指纹）、
 * `parseAdsExport` + `exportEntities`（读两家导出）、`readBackCheck`（读回核对）、
 * `routeAdChange`（走表还是直接点）、`buildGoogleEditorCsv`（Editor 用）。
 */
export * from './build.js'
export { columnLetter, sha256Hex, writeXlsx } from './bytes.js'
export { decodeExportBytes, detectDelimiter, encodeDelimited, parseDelimited } from './csv.js'
export * from './editor.js'
export { buildGoogleBulkFiles, formatGoogleKeyword, googleMatchType } from './google.js'
export * from './google-columns.js'
export { metaCreateRows, metaEditSheet, protectMetaCell } from './meta.js'
export * from './meta-columns.js'
export * from './parse.js'
export * from './readback.js'
export * from './report.js'
export * from './summary.js'
export * from './types.js'
export * from './undo.js'
export * from './validate.js'
