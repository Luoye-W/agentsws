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
