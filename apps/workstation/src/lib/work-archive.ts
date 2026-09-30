/**
 * WP207：左栏职责下的对话 / 任务、归档与找回的客户端。
 *
 * 两条纪律：
 * - **恢复一次一件**，只在人点了之后调（列表里的「恢复」、找回候选卡上的那一下）；
 *   找回（`findArchivedWork`）本身只读，它回来的只是候选。
 * - 查询键都挂在 `['matter', …]` 底下：`matter.*` / `approval.*` / `run.*` / `work.*` 事件一来，
 *   实时刷新那一层（`lib/realtime.ts`）顺手让左栏重取。
 */
import type { ArchivedWorkCandidate, Matter } from '@agentsws/contracts'
import { api } from '@/lib/api'

export type { ArchivedWorkCandidate }

export type RailMatterState = 'running' | 'awaiting' | 'ready' | 'idle'

export interface RailMatter {
  id: string
  title: string
  state: RailMatterState
  last_activity: string
  cards: number
}

export interface RailDuty {
  role_id: string
  matters: RailMatter[]
  more: number
  archived: number
}

export interface RailPosition {
  position_id: string
  /** 等你处理的数：等你批的卡 + 做完待你看的事。 */
  awaiting: number
  duties: RailDuty[]
}

export interface WorkRail {
  idle_days: number | null
  positions: RailPosition[]
}

export interface ArchivedMatter {
  id: string
  title: string
  summary: string
  position_template_id?: string
  role_id?: string
  status: Matter['status']
  last_activity: string
  archived_at?: string
  snippet?: string
}

export interface ArchivedFilter {
  q?: string
  position_id?: string
  role_id?: string
  from?: string
  to?: string
  limit?: number
}

/** 左栏那一份的查询键（在 `['matter']` 底下，事件一来就重取）。 */
export const RAIL_KEY = ['matter', 'rail'] as const
export const ARCHIVED_KEY = ['matter', 'archived'] as const

const qs = (params: Record<string, string | number | undefined>): string => {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') out.set(k, String(v))
  const s = out.toString()
  return s === '' ? '' : `?${s}`
}

export const getWorkRail = (limit?: number): Promise<WorkRail> =>
  api<WorkRail>(`/v1/work/rail${qs({ limit })}`)

export const listArchivedWork = (filter: ArchivedFilter = {}): Promise<ArchivedMatter[]> =>
  api<{ matters: ArchivedMatter[] }>(`/v1/work/archived${qs({ ...filter })}`).then((r) => r.matters)

export const searchWork = (q: string, limit?: number): Promise<ArchivedMatter[]> =>
  api<{ matters: ArchivedMatter[] }>(`/v1/work/search${qs({ q, limit })}`).then((r) => r.matters)

/** 「让 AI 找回」：只读，回候选（`semantic` = 这次用上了模型重排）。 */
export const findArchivedWork = (
  query: string,
): Promise<{ candidates: ArchivedWorkCandidate[]; semantic: boolean }> =>
  api('/v1/work/archived/find', { method: 'POST', body: { query } })

/** 手动归档一件（在跑的、有卡等你批的服务端回 409；界面上按钮本来就灰着）。 */
export const archiveMatter = (id: string): Promise<{ matter: Matter }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/archive`, { method: 'POST' })

/** 放回来（一次一件）。`ai_suggested` = 人点选了 AI 给的候选。 */
export const unarchiveMatter = (
  id: string,
  by: 'user' | 'ai_suggested' = 'user',
): Promise<{ matter: Matter }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/unarchive`, { method: 'POST', body: { by } })

/** 本人点开看过了（左栏「做完待看」的小点灭掉）。失败不打扰人。 */
export const markMatterSeen = (id: string): Promise<void> =>
  api(`/v1/matters/${encodeURIComponent(id)}/seen`, { method: 'POST' })
    .then(() => undefined)
    .catch(() => undefined)

export const getWorkArchiveSettings = (): Promise<{ idle_days: number | null }> =>
  api('/v1/settings/work-archive')

export const setWorkArchiveSettings = (
  idle_days: number | null,
): Promise<{ idle_days: number | null }> =>
  api('/v1/settings/work-archive', { method: 'PUT', body: { idle_days } })

/**
 * 候选卡上「为什么像」：服务端给的是 `种类:词`，这里拆开给界面翻成人话。
 * 认不出的种类原样返回（`kind: 'other'`），不丢字。
 */
export function whyParts(why: string): { kind: string; text: string } {
  const i = why.indexOf(':')
  if (i < 0) return { kind: why, text: '' }
  return { kind: why.slice(0, i), text: why.slice(i + 1) }
}
