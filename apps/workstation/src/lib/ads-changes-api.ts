/**
 * WP316：广告改动的执行那一半（`/v1/ads/ledger*`、`/v1/ads/evidence/:id`）。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带一条投放职责的分配（服务端按它判平台：Meta 那条看不见 Google 的账本）。
 */
import type { AdsLedgerEntryView } from '@agentsws/contracts'
import { api } from './api'

export type { AdsLedgerEntryView } from '@agentsws/contracts'

export const ADS_LEDGER_KEY = ['ads-ledger'] as const

export const listAdsLedger = (assignment: string): Promise<{ rows: AdsLedgerEntryView[] }> =>
  api('/v1/ads/ledger', { assignment })

/** 平台预览看过了：确认提交 / 不提交（与插件横条上那两个按钮同一件事）。 */
export const confirmAdChange = (
  assignment: string,
  change_id: string,
  submit: boolean,
): Promise<{ ok: boolean; message: string }> =>
  api(`/v1/ads/ledger/${encodeURIComponent(change_id)}/confirm`, {
    method: 'POST',
    body: { submit },
    assignment,
  })

/** 撤销账本里的一条（出一张 L1 卡）。 */
export const undoAdChange = (
  assignment: string,
  change_id: string,
): Promise<{ views: { staged: boolean; message?: string }[]; message?: string }> =>
  api(`/v1/ads/ledger/${encodeURIComponent(change_id)}/undo`, { method: 'POST', assignment })

export const getAdsEvidence = (assignment: string, id: string): Promise<{ png_base64: string }> =>
  api(`/v1/ads/evidence/${encodeURIComponent(id)}`, { assignment })

/** 这条职责那个平台的广告账户（「交给插件」挑账户用）。 */
export const listAdAccounts = (
  assignment: string,
  platform: string,
): Promise<{ rows: { id: string; name: string; external_id: string }[] }> =>
  api(`/v1/ads/accounts?platform=${encodeURIComponent(platform)}`, { assignment })

export interface AdsChangesResult {
  route: 'sheet' | 'form'
  reason: string
  views: { staged: boolean; message?: string; approval_item_id?: string }[]
  problems?: string[]
  message?: string
  needs_connection?: string
}

/** 素材流水线这一轮交给插件上传（出一张上传表卡，批了插件去传）。 */
export const stageAdCreativeSheet = (
  assignment: string,
  round_id: string,
  input: { account_id: string; meta_page_id?: string; meta_image_hash?: string },
): Promise<AdsChangesResult> =>
  api(`/v1/ads/creative/rounds/${encodeURIComponent(round_id)}/stage`, {
    method: 'POST',
    body: input,
    assignment,
  })
