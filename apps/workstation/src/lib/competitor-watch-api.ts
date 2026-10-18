/**
 * WP392（docs/104）：竞品监控的接口（`/v1/competitor-watch*`）。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带「店铺管理」或「亚马逊店铺运营」那条职责的分配（服务端按它判读商品的权限）。
 */
import type {
  CompetitorChange,
  CompetitorChangeKind,
  CompetitorWatchRun,
  CompetitorWatchView,
} from '@agentsws/contracts'
import { api } from './api'

export type { CompetitorChange, CompetitorWatchRun, CompetitorWatchView } from '@agentsws/contracts'

/** 变化表的一行（服务端拼好了一句人话，中英各一句）。 */
export type CompetitorChangeRow = CompetitorChange & { text: { zh: string; en: string } }

/** 担竞品监控的职责（docs/104 C1 / C2）。 */
export const COMPETITOR_WATCH_ROLES: readonly string[] = ['dtc.store', 'amz.store']

export const competitorWatchKey = (assignment: string) => ['competitor-watch', assignment] as const
export const competitorChangesKey = (assignment: string) =>
  ['competitor-watch', assignment, 'changes'] as const

/** 老版本服务端 / 替身回的不是这个形状：当没有（卡上什么都不出）。 */
export const isCompetitorWatchView = (v: unknown): v is CompetitorWatchView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as CompetitorWatchView).summary === 'object' &&
  (v as CompetitorWatchView).summary !== null &&
  Array.isArray((v as CompetitorWatchView).sources)

export const getCompetitorWatch = async (
  assignment: string,
): Promise<CompetitorWatchView | null> => {
  const v = await api<unknown>('/v1/competitor-watch', { assignment })
  return isCompetitorWatchView(v) ? v : null
}

export const getCompetitorChanges = async (
  assignment: string,
  query: { competitor?: string; kinds?: CompetitorChangeKind[]; limit?: number } = {},
): Promise<CompetitorChangeRow[]> => {
  const q = new URLSearchParams()
  if (query.competitor !== undefined) q.set('competitor', query.competitor)
  if (query.kinds !== undefined && query.kinds.length > 0) q.set('kind', query.kinds.join(','))
  q.set('limit', String(query.limit ?? 500))
  const out = await api<{ changes: CompetitorChangeRow[] }>(
    `/v1/competitor-watch/changes?${q.toString()}`,
    { assignment },
  )
  return Array.isArray(out?.changes) ? out.changes : []
}

export const runCompetitorWatch = (assignment: string): Promise<CompetitorWatchRun> =>
  api('/v1/competitor-watch/run', { method: 'POST', assignment })

/**
 * WP402（决策 1140 / 1146）：Amazon 读不到时用你自己的浏览器读（只读、每家每天至多一次）——同意 / 撤回
 * （撤回 = 不用、不再问）。
 */
export const setOwnBrowserConsent = (
  assignment: string,
  consent: 'granted' | 'revoked',
): Promise<{ state: string; at?: string }> =>
  api('/v1/competitor-watch/own-browser', { method: 'PUT', assignment, body: { consent } })
