/**
 * WP386：信息监控（`/v1/pr/watch*`）的接口。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带「信息监控」（`pr.monitoring`）那条职责的分配。
 */
import type {
  MonitorGroup,
  MonitorPlanItem,
  MonitorRun,
  MonitorSettings,
  MonitorSource,
} from '@agentsws/contracts'
import { api, type PositionInstanceData } from './api'

/** 一条监控源（地址只有脱敏那一格）。 */
export interface PrWatchSourceRow extends Omit<MonitorSource, 'url'> {
  url_masked: string
}

export interface PrWatchView {
  sources: PrWatchSourceRow[]
  plan: MonitorPlanItem[]
  settings: MonitorSettings
  summary: string
  failed: number
  next_run_at?: string
  last_run?: MonitorRun
}

export interface PrWatchLinkResult {
  input_masked: string
  ok: boolean
  message: string
  source_id?: string
  plan_item_id?: string
  label?: string
  kind?: MonitorSource['kind']
}

export const PR_WATCH_KEY = ['pr-watch'] as const
export const PR_MONITORING_ROLE = 'pr.monitoring'

export const getPrWatch = (assignment: string): Promise<PrWatchView> =>
  api('/v1/pr/watch', { assignment })

export const addPrWatchLinks = (
  assignment: string,
  input: { links: string; plan_item_id?: string; group?: MonitorGroup },
): Promise<{ results: PrWatchLinkResult[]; view: PrWatchView }> =>
  api('/v1/pr/watch/links', { method: 'POST', body: input, assignment })

export const runPrWatch = (
  assignment: string,
): Promise<{ run?: MonitorRun; message: string; view: PrWatchView }> =>
  api('/v1/pr/watch/run', { method: 'POST', assignment })

export const removePrWatchSource = (assignment: string, id: string): Promise<PrWatchView> =>
  api(`/v1/pr/watch/sources/${encodeURIComponent(id)}`, { method: 'DELETE', assignment })

/** 本人「信息监控」那条职责的分配（指定岗位就只在那个岗位里找）；没担这条职责回 `undefined`。 */
export function monitorAssignmentOf(
  instances: readonly PositionInstanceData[] | undefined,
  position_id?: string,
): string | undefined {
  for (const p of instances ?? []) {
    if (position_id !== undefined && p.position_id !== position_id) continue
    const hit = p.roles.find((r) => r.role_id === PR_MONITORING_ROLE)?.my_assignment_id
    if (hit !== undefined) return hit
  }
  return undefined
}

/** WP419（自查 P5）：拉回来的提及（`/v1/pr/mentions`，最近 30 天、最多 200 条）。 */
export interface PrMentionRowView {
  id: string
  url: string
  title?: string
  text: string
  origin: string
  published_at: string
  observed_at: string
  sentiment?: 'negative' | 'neutral' | 'positive'
  group?: MonitorGroup
  competitor?: string
  seen_count: number
}

export const prMentionsKey = (assignment: string) => ['pr-mentions', assignment] as const

export const getPrMentions = (assignment: string): Promise<{ rows: PrMentionRowView[] }> =>
  api(
    `/v1/pr/mentions?limit=200&since=${encodeURIComponent(new Date(Date.now() - 30 * 86_400_000).toISOString())}`,
    { assignment },
  )
