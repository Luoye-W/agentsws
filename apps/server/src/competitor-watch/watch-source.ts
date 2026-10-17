/**
 * WP392：把竞品监控交成报告积木要的那一份（通用的 `WatchSource`，`apps/server/src/report-tools.ts`）。
 *
 * - `items`：窗口里比出来的变化，变成 `kind: 'change'` 的通用条目（`query_watch_items` 能和帖子混查）；
 * - `changes`：变化本身（`list_competitor_changes` 按竞品 / 种类数）；
 * - `health`：各条源这次读没读到（报告照实写「哪家没读到」）；
 * - `sweepNow`：现在读一次（「立即巡查」）。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { COMPETITOR_WATCH_PLATFORM, watchItemOfChange } from '@agentsws/social-core'
import type { WatchSource } from '../report-tools.js'
import type { CompetitorWatchAssembly } from './service.js'

const LIMIT = 5000

export function competitorWatchSourceOf(cw: CompetitorWatchAssembly): WatchSource {
  // 窗口含 until 那一刻（存储那边是「不含」）
  const changes = (w: { since: Iso8601; until: Iso8601 }) =>
    cw.changes({
      since: w.since,
      until: new Date(Date.parse(w.until) + 1).toISOString(),
      limit: LIMIT,
    })
  return {
    platform: COMPETITOR_WATCH_PLATFORM,
    configured: () => cw.sources().some((s) => s.paused !== true),
    ownPlaces: () => [],
    items: (w) => changes(w).map(watchItemOfChange),
    sweeps: (w) =>
      cw
        .runs(200)
        .map((r) => r.finished_at)
        .filter((t): t is Iso8601 => t !== undefined && t >= w.since && t <= w.until),
    sweepNow: async () => {
      const run = await cw.runNow({ trigger: 'manual' })
      return {
        ...(run.finished_at === undefined ? {} : { finished_at: run.finished_at }),
        parts: run.parts.map((p) => ({
          part: p.label,
          status: p.status,
          fresh: p.changes,
          ...(p.message === undefined ? {} : { message: p.message }),
        })),
      }
    },
    changes,
    health: () => {
      const live = cw.sources().filter((s) => s.paused !== true)
      return {
        sources: live.length,
        failed: [...new Set(live.filter((s) => s.status === 'failed').map((s) => s.label))],
        partial: [
          ...new Set(
            live.filter((s) => s.status === 'ok' && s.last_complete === false).map((s) => s.label),
          ),
        ],
      }
    },
  }
}
