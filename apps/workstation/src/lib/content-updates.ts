/**
 * WP219（docs/90 §6）：设置 → 通用「已审的内容更新」与内容更新卡的客户端。
 *
 * 条目 id 形如 `skill:shopify`，进路径前一律 `encodeURIComponent`。
 */
import type { ContentDiffView, ContentUpdateMode, ContentUpdatesView } from '@agentsws/contracts'
import { api } from '@/lib/api'

export type { ContentDiffView, ContentUpdateMode, ContentUpdatesView }

export const CONTENT_UPDATES_KEY = ['settings', 'content-updates'] as const

const item = (id: string): string => `/v1/settings/content-updates/items/${encodeURIComponent(id)}`

export const getContentUpdates = (): Promise<ContentUpdatesView> =>
  api('/v1/settings/content-updates')

export const setContentUpdateMode = (mode: ContentUpdateMode): Promise<ContentUpdatesView> =>
  api('/v1/settings/content-updates', { method: 'PUT', body: { mode } })

export const checkContentUpdates = (): Promise<ContentUpdatesView> =>
  api('/v1/settings/content-updates/check', { method: 'POST', body: {} })

export const applyContentUpdate = (id: string): Promise<ContentUpdatesView> =>
  api(`${item(id)}/apply`, { method: 'POST', body: {} })

export const rollbackContentUpdate = (id: string): Promise<ContentUpdatesView> =>
  api(`${item(id)}/rollback`, { method: 'POST', body: {} })

export const getContentDiff = (id: string): Promise<ContentDiffView> => api(`${item(id)}/diff`)
