/**
 * WP316（docs/101 §5.1② ③ / §5.3，决策 552–558）：广告改动的**接线**——卡 → 插件上传 → 平台预览 →
 * 人再确认 → 提交 → 读回 → 变更账本。
 *
 * 两样东西在这里定形：
 *
 * 1. **上传表卡的卡面**（`after.form === 'ads_sheet'`）：一句白话 + 表格预览 + 可下载原表 +
 *    表的指纹。卡上带的就是批了之后插件要传的那几份字节（`_files`，下划线开头不上键值对），
 *    执行前按指纹再核一次，改过就不传。
 * 2. **广告变更账本的一条**：上传表、改前 / 改后导出、平台预览截图、提交前后截图、审批编号、
 *    读回核对，一起存 180 天（决策 556）。
 */

import type { Iso8601 } from './common.js'

/** 卡面 `after.form` 的值（工作台据此换卡身）。 */
export const ADS_SHEET_FORM = 'ads_sheet'

/** 截图 / 账本保留多久（决策 556）。 */
export const ADS_LEDGER_KEEP_DAYS = 180

/** 磨合期（决策 554）：每个广告账户接入后的前 14 天，插件执行的 L2 一律升 L1。 */
export const ADS_BREAK_IN_DAYS = 14

/** 卡上表格预览的一行（与 `ads-core` 的 `SheetPreviewRow` 同形）。 */
export interface AdsSheetPreviewRow {
  action: string
  level: string
  name: string
  before?: string
  after?: string
}

/** 卡上带的一份原表（给人下载、给插件上传）。 */
export interface AdsSheetCardFile {
  name: string
  mime: string
  /** `campaigns` / `ad_groups` / `ads` / `keywords` / `meta_new` / `meta_edit`。 */
  sheet: string
  /** 原样字节的 base64（CSV / 制表符文字 / .xlsx）。 */
  base64: string
  /** 插件那一侧的指纹（`sha256:<hex>`，按原样字节算）。 */
  fingerprint: string
  bytes: number
}

/**
 * 上传表卡 / 开始投放卡 / 撤销卡的 `after`（`ads_sheet` / `ads_activate` / `ads_undo` 三种 kind 共用）。
 *
 * 走表单那几条（暂停 / 启用 / 改预算，决策 552）没有 `_files`，带 `_form`：插件去点哪一格。
 */
export interface AdsSheetCardAfter {
  form: typeof ADS_SHEET_FORM
  /** `google` / `meta`。 */
  platform: string
  platform_label?: string
  /** 广告库里那个账户的 id（`AdAccount.id`）。 */
  account_id: string
  account_name?: string
  /** 一句白话（「新建 2 个广告组、12 条广告，都先暂停」）。 */
  sentence: string
  rows: AdsSheetPreviewRow[]
  /** 平台没报、本地查出来的提醒（不拦）。 */
  warnings?: string[]
  /** 整份表的指纹（`ads-core` 的 `bundleFingerprint`；审批绑的就是它）。 */
  fingerprint?: string
  spend_gate_note?: string
  /** 撤销的是哪一条改动（`ads_undo`）。 */
  undo_of?: string
  /** 开始投放跟着哪一张上传表来（`ads_activate`）。 */
  activation_of?: string
  _files?: AdsSheetCardFile[]
  /** 原始意图（`ads-core` 的 `AdSheetOp[]`；读回核对、出「开始投放」、撤销都要它）。 */
  _ops?: unknown[]
  /** 走表单的那一条（插件点哪一格）。 */
  _form?: {
    action: 'pause' | 'enable' | 'set_budget' | 'undo_upload'
    level?: 'campaign' | 'ad_group' | 'ad'
    entity_id?: string
    entity_name?: string
    amount?: string
    /** `undo_upload`：撤销哪一次上传（Google「所有批量操作」里那一行的文件名）。 */
    upload_name?: string
  }[]
}

/** 账本里一条改动走到哪了。 */
export type AdsLedgerState =
  | 'queued'
  | 'running'
  | 'waiting_confirm'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'handover'
  | 'stopped'
  | 'expired'

export interface AdsLedgerJob {
  job_id: string
  /** 第几份表（多张表按顺序一张一张传）；走表单的没有。 */
  file?: string
  status: AdsLedgerState
  message?: string
  finished_at?: Iso8601
}

export interface AdsLedgerEvidence {
  id: string
  /** `before` / `preview` / `after`。 */
  tag: string
  job_id: string
}

export interface AdsLedgerFile {
  /** `snapshot`（改前导出）/ `result`（改后导出）/ `report`。 */
  tag: string
  name: string
  job_id: string
  /** 账本自己存了一份（读得到）。 */
  kept: boolean
}

/** 变更账本的一条（工作台「广告改动」列表 / `GET /v1/ads/ledger`）。 */
export interface AdsLedgerEntryView {
  change_id: string
  approval_id?: string
  /** `ads_sheet` / `ads_activate` / `ads_undo` / `budget_change` / `pause_ad` / `create_campaign`。 */
  kind: string
  platform: string
  account_id: string
  title: string
  sentence?: string
  state: AdsLedgerState
  /** 止损（L3 自动）。 */
  stop_loss?: boolean
  jobs: AdsLedgerJob[]
  evidence: AdsLedgerEvidence[]
  /** 没截到的那几格（决策 600 C：止损先停、用前后导出作证）。 */
  evidence_missing: string[]
  files: AdsLedgerFile[]
  /** 平台预览读到的那句（几条错误 / 警告）。 */
  preview_summary?: string
  platform_errors?: string
  readback?: { ok: boolean; sentence: string }
  /** 能不能撤销；不能的话为什么（一句）。 */
  undo: { available: boolean; why?: string }
  undone_by?: string
  created_at: Iso8601
  updated_at: Iso8601
  kept_until: Iso8601
}
