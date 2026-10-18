/**
 * WP406（私有 docs/107 §5）：「岗位更新」的客户端——第三栏「设定 · 岗位更新」与卡上「挑着看」开的那一页。
 * 条目 id 形如 `role_content:dtc.store`，进路径前一律 `encodeURIComponent`。
 */
import type {
  ContentAiMergeResult,
  ContentApplyInput,
  ContentDigestCardPayload,
  ContentItemDiffView,
  OfficialSubscriptionLocalView,
  PositionContentUpdatesView,
  PositionUpdatePolicy,
} from '@agentsws/contracts'
import { api } from '@/lib/api'

export type {
  ContentDigestCardPayload,
  ContentItemDiffView,
  OfficialSubscriptionLocalView,
  PositionContentUpdatesView,
  PositionUpdatePolicy,
}

/** 卡上「挑着看」开第三栏用的资源地址（与岗位页无关，在哪一页都开得到）。 */
export const CONTENT_UPDATES_ADDRESS_PREFIX = 'agentsws://content-updates/'

export const contentUpdatesAddress = (position_id: string): string =>
  `${CONTENT_UPDATES_ADDRESS_PREFIX}${encodeURIComponent(position_id)}`

export function positionOfAddress(address: string | undefined): string | undefined {
  if (address === undefined || !address.startsWith(CONTENT_UPDATES_ADDRESS_PREFIX)) return undefined
  const id = decodeURIComponent(address.slice(CONTENT_UPDATES_ADDRESS_PREFIX.length))
  return id === '' ? undefined : id
}

export const positionUpdatesKey = (position_id: string) =>
  ['content-updates', 'position', position_id] as const

const base = (position_id: string): string =>
  `/v1/content-updates/positions/${encodeURIComponent(position_id)}`

export const getPositionUpdates = (
  position_id: string,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(base(position_id), assignment === undefined ? {} : { assignment })

export const setPositionUpdatePolicy = (
  position_id: string,
  policy: PositionUpdatePolicy,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(`${base(position_id)}/policy`, {
    method: 'PUT',
    body: { policy },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const getPositionUpdateDiff = (
  position_id: string,
  item_id: string,
  assignment?: string,
): Promise<ContentItemDiffView> =>
  api(
    `${base(position_id)}/items/${encodeURIComponent(item_id)}/diff`,
    assignment === undefined ? {} : { assignment },
  )

export const applyPositionUpdates = (
  position_id: string,
  input: ContentApplyInput,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(`${base(position_id)}/apply`, {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const skipPositionUpdates = (
  position_id: string,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(`${base(position_id)}/skip`, {
    method: 'POST',
    body: {},
    ...(assignment === undefined ? {} : { assignment }),
  })

export const aiMergePositionPart = (
  position_id: string,
  item_id: string,
  part_key: string,
  assignment?: string,
): Promise<ContentAiMergeResult> =>
  api(`${base(position_id)}/ai-merge`, {
    method: 'POST',
    body: { item_id, part_key },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const rollbackPositionUpdates = (
  position_id: string,
  item_id?: string,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(`${base(position_id)}/rollback`, {
    method: 'POST',
    body: item_id === undefined ? {} : { item_id },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const dismissPositionNudge = (
  position_id: string,
  assignment?: string,
): Promise<PositionContentUpdatesView> =>
  api(`${base(position_id)}/nudge/dismiss`, {
    method: 'POST',
    body: {},
    ...(assignment === undefined ? {} : { assignment }),
  })

export const subscribeContentUpdates = (): Promise<OfficialSubscriptionLocalView> =>
  api('/v1/content-updates/subscription', { method: 'POST', body: {} })

export function isContentDigestPayload(p: unknown): p is ContentDigestCardPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { form?: unknown }).form === 'content_update_digest' &&
    Array.isArray((p as { items?: unknown }).items)
  )
}
