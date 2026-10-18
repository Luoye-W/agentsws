/**
 * WP392（docs/104 §3.3）：模拟世界里的**竞品监控**——替身进料口交回几行（场景里写死），和上一次的快照比出变化。
 *
 * 用的是和服务进程同一份快照对比引擎（`@agentsws/social-core` 的 `diffCatalog`）：第一次只当底子、
 * 读不全不判下架、多款式合成一条……都不在这里另写一遍。竞品监控自己零写：不出卡、不改任何外部账号，
 * 只记 `simulation.competitor_read`（每次读）与 `simulation.competitor_change`（每条变化）两种事件。
 */
import type {
  CatalogSnapshot,
  CatalogSnapshotRow,
  CompetitorChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { diffCatalog } from '@agentsws/social-core'
import type { ScenarioCompetitorRead } from './scenario/types.js'
import type { World } from './world.js'

export interface CompetitorWatchLoop {
  read(input: ScenarioCompetitorRead): CompetitorChange[]
}

const slug = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')

export function installCompetitorWatch(world: World): CompetitorWatchLoop {
  const snapshots = new Map<string, CatalogSnapshot>()
  return {
    read(input) {
      const now = world.clock.now()
      const competitor_id = `c_${slug(input.competitor)}`
      const kind = input.source === 'amazon' ? ('amazon_asin' as const) : ('shop_catalog' as const)
      const source_id = `cw_${input.source === 'amazon' ? 'amz' : 'shop'}_${competitor_id}`
      if (input.error !== undefined && input.rows.length === 0) {
        world.appendEvent('simulation.competitor_read', {
          competitor: input.competitor,
          source: input.source,
          status: 'failed',
          message: input.error,
        })
        return []
      }
      const rows: CatalogSnapshotRow[] = input.rows.map((r) => ({
        source_id,
        competitor_id,
        product_key: r.product,
        ...(r.variant === undefined ? {} : { variant_key: r.variant }),
        title: r.title,
        ...(r.price === undefined ? {} : { price: r.price }),
        ...(r.compare_at === undefined ? {} : { compare_at_price: r.compare_at }),
        currency: 'USD',
        ...(r.available === undefined ? {} : { available: r.available }),
        ...(r.rating === undefined ? {} : { rating: r.rating }),
        ...(r.reviews === undefined ? {} : { reviews: r.reviews }),
        ...(r.created_at === undefined ? {} : { product_created_at: r.created_at }),
        read_at: now,
      }))
      const out = diffCatalog({
        workspace_id: world.workspace_id as WorkspaceId,
        source: { id: source_id, kind, competitor_id },
        competitor: input.competitor,
        previous: snapshots.get(source_id),
        read: { rows, complete: input.complete ?? true },
        now,
      })
      snapshots.set(source_id, out.snapshot)
      world.appendEvent('simulation.competitor_read', {
        competitor: input.competitor,
        source: input.source,
        status: 'ok',
        rows: rows.length,
        baseline: out.baseline,
        changes: out.changes.length,
      })
      for (const c of out.changes)
        world.appendEvent('simulation.competitor_change', {
          competitor: c.competitor,
          kind: c.kind,
          product: c.product_key,
          title: c.title,
          ...(c.before === undefined ? {} : { before: c.before }),
          ...(c.after === undefined ? {} : { after: c.after }),
          ...(c.pct === undefined ? {} : { pct: c.pct }),
          ...(c.variants === undefined ? {} : { variants: c.variants }),
        })
      return out.changes
    },
  }
}
