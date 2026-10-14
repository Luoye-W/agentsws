/**
 * 对外的总入口：查 → 出表 → 复查「新建都是暂停」→ 摘要 → 指纹（docs/101 §5.1②）。
 *
 * WP316 出审批卡、WP313 插件上传、WP317 素材流水线给人下载，用的都是
 * {@link buildAdUploadBundle} 这一个函数。**有 error 就不出表**（`files` 为空）：
 * 一张必然被平台拒、或者会一上传就花钱的表，不该有「人点一下就传上去」的路径。
 */

import { sha256Hex } from './bytes.js'
import { buildGoogleBulkFiles } from './google.js'
import { GOOGLE_ACTION, GOOGLE_BULK_COLUMNS, GOOGLE_STATUS } from './google-columns.js'
import { metaCreateRows, metaEditSheet, metaFile, rowsToTable } from './meta.js'
import { META_COLUMNS, META_STATUS } from './meta-columns.js'
import type { ParsedAdsExport } from './parse.js'
import { activationOpsFor, summarizeAdSheet } from './summary.js'
import type {
  AdSheetOp,
  AdUploadBundle,
  AdUploadFile,
  SheetContext,
  SheetPlatform,
  SheetProblem,
} from './types.js'
import { validateAdSheetOps } from './validate.js'

export interface BuildAdUploadInput {
  platform: SheetPlatform
  ops: readonly AdSheetOp[]
  /** 改前导出（`parseAdsExport` 的结果）。Meta 改已有的要它；摘要里的「改前」也从它取。 */
  before?: ParsedAdsExport
  context?: SheetContext
}

/**
 * 新建行的状态必须是暂停（决策 553）。按**生成出来的表**查，不按 op 查——
 * 哪天有人改了生成器，这一道还在。
 */
export function checkNewRowsPaused(files: readonly AdUploadFile[]): SheetProblem[] {
  const problems: SheetProblem[] = []
  for (const f of files) {
    const col = (h: string): number => f.headers.indexOf(h)
    if (f.sheet === 'meta_new') {
      const pairs = [
        [
          META_COLUMNS.campaign_id.header,
          META_COLUMNS.campaign_status.header,
          META_COLUMNS.campaign_name.header,
        ],
        [
          META_COLUMNS.ad_set_id.header,
          META_COLUMNS.ad_set_status.header,
          META_COLUMNS.ad_set_name.header,
        ],
        [META_COLUMNS.ad_id.header, META_COLUMNS.ad_status.header, META_COLUMNS.ad_name.header],
      ] as const
      f.rows.forEach((row, r) => {
        for (const [idH, stH, nameH] of pairs) {
          const named = (row[col(nameH)] ?? '') !== ''
          const isNew = named && (row[col(idH)] ?? '') === ''
          if (isNew && row[col(stH)] !== META_STATUS.paused)
            problems.push({
              severity: 'error',
              code: 'new_not_paused',
              message: `${f.name} 第 ${r + 2} 行是新建的，但「${stH}」不是 ${META_STATUS.paused}。`,
            })
        }
      })
      continue
    }
    if (f.sheet === 'meta_edit' || f.sheet === 'editor') continue
    const statusH = {
      campaigns: GOOGLE_BULK_COLUMNS.campaign_status.header,
      ad_groups: GOOGLE_BULK_COLUMNS.ad_group_status.header,
      ads: GOOGLE_BULK_COLUMNS.ad_status.header,
      keywords: GOOGLE_BULK_COLUMNS.keyword_status.header,
    }[f.sheet]
    const a = col(GOOGLE_BULK_COLUMNS.action.header)
    const s = col(statusH)
    f.rows.forEach((row, r) => {
      if (row[a] === GOOGLE_ACTION.add && (s < 0 || row[s] !== GOOGLE_STATUS.paused))
        problems.push({
          severity: 'error',
          code: 'new_not_paused',
          message: `${f.name} 第 ${r + 2} 行是新建的，但状态不是 Paused——Google 留空就是启用，一上传就花钱。`,
        })
    })
  }
  return problems
}

/** Meta：挂在已有上级下面的新建，上级要带编号（没编号的上级会被当成新建一个）。 */
function checkMetaParents(ops: readonly AdSheetOp[]): SheetProblem[] {
  const newCampaigns = new Set<string>()
  const newSets = new Set<string>()
  for (const op of ops) {
    if (op.kind === 'create_campaign') newCampaigns.add(op.campaign)
    if (op.kind === 'create_ad_group') newSets.add(`${op.campaign}\u0000${op.ad_group}`)
  }
  const problems: SheetProblem[] = []
  ops.forEach((op, i) => {
    if (op.kind !== 'create_ad_group' && op.kind !== 'create_ad') return
    if (!newCampaigns.has(op.campaign) && op.campaign_id === undefined)
      problems.push({
        severity: 'error',
        code: 'missing_parent_id',
        op_index: i,
        message: `「${op.campaign}」不是这批新建的，要带它的广告系列编号——Meta 会把没编号的当成再建一个。`,
      })
    if (
      op.kind === 'create_ad' &&
      !newSets.has(`${op.campaign}\u0000${op.ad_group}`) &&
      op.ad_group_id === undefined
    )
      problems.push({
        severity: 'error',
        code: 'missing_parent_id',
        op_index: i,
        message: `广告组「${op.ad_group}」不是这批新建的，要带它的编号。`,
      })
  })
  return problems
}

/** 表的指纹：按文件名排序后把每个文件的名字与内容一起算 SHA-256。 */
export function bundleFingerprint(files: readonly AdUploadFile[]): string {
  const parts = [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}\n${typeof f.content === 'string' ? f.content : sha256Hex(f.content)}`)
  return sha256Hex(parts.join('\n\u0000\n'))
}

/** 查、出表、复查、摘要、指纹，一步到位。 */
export function buildAdUploadBundle(input: BuildAdUploadInput): AdUploadBundle {
  const { platform, ops, before } = input
  const ctx = input.context ?? {}
  const problems: SheetProblem[] = validateAdSheetOps(platform, ops, ctx)
  if (platform === 'meta') problems.push(...checkMetaParents(ops))

  let files: AdUploadFile[] = []
  if (platform === 'google') files = buildGoogleBulkFiles(ops, ctx)
  else {
    const created = metaCreateRows(ops)
    if (created.length > 0) {
      const built = metaFile('meta_new', rowsToTable(created))
      files.push(built.file)
      problems.push(...built.problems)
    }
    const edit = metaEditSheet(ops, before)
    problems.push(...edit.problems)
    if (edit.rows.length > 0) {
      const built = metaFile('meta_edit', edit)
      files.push(built.file)
      problems.push(...built.problems)
    }
  }
  problems.push(...checkNewRowsPaused(files))
  const ok = !problems.some((p) => p.severity === 'error')
  const summary = summarizeAdSheet(platform, ops, {
    ...(before === undefined ? {} : { before }),
    ...(ctx.currency_symbol === undefined ? {} : { currency_symbol: ctx.currency_symbol }),
  })
  const out = ok ? files : []
  return {
    platform,
    ok,
    problems,
    files: out,
    summary,
    approval_level: 'L1',
    fingerprint: bundleFingerprint(out),
    activation_ops: activationOpsFor(platform, ops),
  }
}
