/**
 * 广告动作 → 计划 → 一件活（本机服务进队前调；WP316 从审批执行器那一头接进来）。
 */

import type { ActionAccount, ActionJob, ActionPlan } from '../types.js'
import { ADS_ORIGINS, type AdsAction, type AdsOrigins } from './actions.js'
import { googleAdsPlan } from './google.js'
import { metaAdsPlan } from './meta.js'
import {
  type AdsReportAction,
  adsReportActionTitle,
  adsReportPlan,
  isAdsReportAction,
} from './report.js'

export * from './account-hint.js'
export * from './actions.js'
export { GOOGLE_ADS_SELECTORS, googleAdsPlan } from './google.js'
export { META_ADS_SELECTORS, metaAdsPlan } from './meta.js'
export * from './report.js'

export function adsPlan(
  account: ActionAccount,
  action: AdsAction | AdsReportAction,
  origins: AdsOrigins = ADS_ORIGINS,
): ActionPlan {
  // WP315：看数据的两个动作（建「工坊日报」、每天导出）走自己那张步骤表
  if (isAdsReportAction(action))
    return adsReportPlan(
      account,
      action,
      account.platform === 'meta_ads' ? origins.meta_ads : origins.google_ads,
    )
  // WP329：Reddit 不是广告后台，它的写走 `buildRedditJob`（`reddit/index.ts`）
  if (account.platform === 'reddit')
    throw new Error('Reddit 的写不走广告动作表（用 buildRedditJob）。')
  return account.platform === 'google_ads'
    ? googleAdsPlan(account, action, origins.google_ads)
    : metaAdsPlan(account, action, origins.meta_ads)
}

/** 横条 / 工作台上的一句话（卡上没给标题时用）。 */
export function adsActionTitle(action: AdsAction | AdsReportAction): string {
  if (isAdsReportAction(action)) return adsReportActionTitle(action)
  switch (action.kind) {
    case 'upload_sheet':
      return `上传表「${action.sheet.name}」`
    case 'export_report':
      return '导出报表'
    case 'pause':
      return `暂停「${action.entity.name ?? action.entity.id}」`
    case 'enable':
      return `启用「${action.entity.name ?? action.entity.id}」`
    case 'set_budget':
      return `预算改成 ${action.amount}（「${action.entity.name ?? action.entity.id}」）`
    case 'export_snapshot':
      return '导出改前表'
    case 'undo_upload':
      return `撤销上传「${action.upload_name}」`
  }
}

export interface AdsJobInput {
  id: string
  workspace_id: string
  account: ActionAccount
  action: AdsAction | AdsReportAction
  approval_id?: string
  approval_level?: 'L1' | 'L2' | 'L3'
  title?: string
  created_at: string
  origins?: AdsOrigins
}

/** 拼一件活。`zones_allowed` 先空着，进队时 `validateJob` 按设置与审批级别填。 */
export function buildAdsJob(input: AdsJobInput): ActionJob {
  const plan = adsPlan(input.account, input.action, input.origins)
  return {
    id: input.id,
    workspace_id: input.workspace_id,
    account: input.account,
    plan,
    ...(input.approval_id === undefined ? {} : { approval_id: input.approval_id }),
    ...(input.approval_level === undefined ? {} : { approval_level: input.approval_level }),
    ...(input.action.kind === 'upload_sheet' ? { sheet: input.action.sheet } : {}),
    zones_allowed: [],
    title: input.title ?? adsActionTitle(input.action),
    created_at: input.created_at,
  }
}
