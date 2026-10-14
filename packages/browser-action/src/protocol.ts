/**
 * 插件 ↔ 本机服务的动作通道（线上形状）。路由在 `packages/api/src/routes/extension-actions.ts`。
 *
 * **还是插件主动找本机**（docs/101 §1.4）：插件长轮询来领活、回报进度与结果；
 * 本机服务永远不能直接伸手进浏览器，安全模型与现在一样。
 */

import type {
  ActionJob,
  ActionJobStatus,
  ActionPlatform,
  ActionResult,
  DownloadTag,
  EvidenceTag,
  GuardedZoneId,
} from './types.js'

/** 长轮询最多挂多久（秒）。插件那边的 fetch 超时要比它长。 */
export const ACTION_POLL_WAIT_MAX_S = 25

/** 插件领活：`GET /v1/extension/actions/next?platforms=google_ads,meta_ads&wait=25`。 */
export interface ActionNextResponse {
  job?: ActionJob
  /** 没活时多久再来问（毫秒）。 */
  retry_after_ms: number
  /** 这几家还没在插件里勾过「看过风险告知，同意」（或文案改版了要重新同意）：这几家的活不发。 */
  needs_consent?: ActionPlatform[]
}

export interface ActionProgressInput {
  step: number
  of: number
  label: string
  waiting_confirm?: boolean
}

export interface ActionProgressResponse {
  /** 工作台上点了停止。 */
  stop: boolean
  /** 工作台的卡上点了「确认提交」。 */
  confirmed: boolean
}

/** 上传表本体（插件拿到后自己再算一次指纹）。 */
export interface ActionSheetResponse {
  name: string
  mime: string
  base64: string
  fingerprint: string
}

export interface ActionEvidenceInput {
  tag: EvidenceTag
  /** PNG 的 base64（`captureVisibleTab` 给的 data URL 去掉头）。 */
  png_base64: string
  url: string
  taken_at: string
}

export interface ActionEvidenceReceipt {
  id: string
  kept_until: string
}

export interface ActionDownloadInput {
  tag: DownloadTag
  /** 浏览器下载到的绝对路径（桌面端去读）。 */
  path: string
  name: string
  bytes?: number
}

export type ActionResultInput = ActionResult

/** 工作台看的一件活。 */
export interface ActionJobView {
  id: string
  title: string
  platform: ActionPlatform
  account_id: string
  kind: string
  status: ActionJobStatus
  approval_id?: string
  created_at: string
  progress?: { step: number; of: number; label: string }
  result?: { outcome: string; message: string; step: number; finished_at: string }
  /** 排着但因为限速暂时领不走的原因。 */
  waiting?: string
}

/** 连接时的白话风险告知（决策 562）：同意过的记录。文案在 WP318。 */
export interface AdsConsentRecord {
  platform: ActionPlatform
  accepted_at: string
  /** 同意的是哪一版告知文案（文案改了要重新同意）。 */
  text_version: string
}

export interface AdsActionSettings {
  /** 「默认不碰」十个区域放没放开（决策 557；全部默认关）。 */
  zones: Record<GuardedZoneId, boolean>
  consent: Partial<Record<ActionPlatform, AdsConsentRecord>>
}
