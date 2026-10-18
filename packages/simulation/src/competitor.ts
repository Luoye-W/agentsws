/**
 * WP392（docs/104 §3.3）：模拟世界里的**竞品监控**——替身进料口交回几行（场景里写死），和上一次的快照比出变化。
 *
 * 用的是和服务进程同一份快照对比引擎（`@agentsws/social-core` 的 `diffCatalog`）：第一次只当底子、
 * 读不全不判下架、多款式合成一条……都不在这里另写一遍。竞品监控自己零写：不出卡、不改任何外部账号，
 * 只记 `simulation.competitor_read`（每次读）与 `simulation.competitor_change`（每条变化）两种事件。
 */

import {
  type AmazonCloudItem,
  type AmazonPageOutcome,
  type AmazonProductFacts,
  readAmazonAsins,
} from '@agentsws/brand-intake'
import type {
  CatalogSnapshot,
  CatalogSnapshotRow,
  CompetitorChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { diffCatalog, type OwnRef } from '@agentsws/social-core'
import type { ScenarioCompetitorRead } from './scenario/types.js'
import type { World } from './world.js'

export interface CompetitorWatchLoop {
  read(input: ScenarioCompetitorRead): CompetitorChange[]
  /**
   * WP394（docs/104 一期 B）：Amazon 对标款读一次——走和服务进程**同一份**读的那一轮（`@agentsws/brand-intake` 的
   * `readAmazonAsins`：内置浏览器先读、被拦就停不重试、剩下的走云端、积分照扣、划线价 / 优惠券照实空着），
   * 读页和云端都是替身（场景里写死的几行）；自家的那几行（`own`）给竞品比价用（C8）。
   */
  readAmazon(input: ScenarioCompetitorRead): Promise<CompetitorChange[]>
}

const slug = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')

export function installCompetitorWatch(world: World): CompetitorWatchLoop {
  const snapshots = new Map<string, CatalogSnapshot>()
  /** WP394：竞品款 → 对标自家哪一款（场景行里的 `vs_own`）。 */
  const vsOwn = new Map<string, string>()
  const OWN_SOURCE = 'cw_amz__own'
  return {
    async readAmazon(input) {
      const now = world.clock.now()
      const competitor_id = input.own === true ? '_own' : `c_${slug(input.competitor)}`
      const source_id = input.own === true ? OWN_SOURCE : `cw_amz_${competitor_id}`
      const byAsin = new Map(input.rows.map((r) => [r.product.toUpperCase(), r]))
      for (const r of input.rows)
        if (r.vs_own !== undefined)
          vsOwn.set(`${competitor_id}|${r.product.toUpperCase()}`, r.vs_own)
      const facts = (asin: string): AmazonProductFacts => {
        const r = byAsin.get(asin)
        return {
          asin,
          title: r?.title ?? asin,
          ...(r?.price === undefined ? {} : { price: r.price, currency: 'USD' }),
          ...(r?.compare_at === undefined ? {} : { list_price: r.compare_at }),
          ...(r?.coupon === undefined ? {} : { coupon: r.coupon }),
          ...(r?.rating === undefined ? {} : { rating: r.rating }),
          ...(r?.reviews === undefined ? {} : { reviews: r.reviews }),
          ...(r?.available === undefined ? {} : { available: r.available }),
          bsr: r?.bsr === undefined ? [] : [{ rank: r.bsr, category: r.bsr_category ?? 'All' }],
          bullets: [],
          undeliverable: false,
        }
      }
      const perItem = input.cloud_credits ?? 0.18
      const got = await readAmazonAsins(
        {
          id: source_id,
          competitor_id,
          label: input.competitor,
          marketplace: 'US',
          asins: [...byAsin.keys()],
        },
        {
          ...(input.no_browser === true
            ? {}
            : {
                browser: async ({ asin }): Promise<AmazonPageOutcome> =>
                  asin === input.blocked_at?.toUpperCase()
                    ? { status: 'blocked' }
                    : { status: 'ok', facts: facts(asin) },
              }),
          cloud: async ({ asins }) => ({
            credits: Math.round(perItem * asins.length * 100) / 100,
            items: asins.map((asin): AmazonCloudItem => {
              const f = facts(asin)
              return {
                asin,
                ...(f.title === undefined ? {} : { title: f.title }),
                ...(f.price === undefined ? {} : { price: f.price, currency: 'USD' }),
                ...(f.rating === undefined ? {} : { rating: f.rating }),
                ...(f.reviews === undefined ? {} : { reviews_count: f.reviews }),
                ...(f.available === undefined ? {} : { in_stock: f.available }),
                ...(f.bsr[0] === undefined
                  ? {}
                  : { bsr: f.bsr[0].rank, category: f.bsr[0].category }),
              }
            }),
          }),
          now,
        },
      )
      const own = new Map((snapshots.get(OWN_SOURCE)?.rows ?? []).map((r) => [r.product_key, r]))
      const ownRef = (row: CatalogSnapshotRow): OwnRef | undefined => {
        const key = vsOwn.get(`${row.competitor_id}|${row.product_key}`)
        const mine = key === undefined ? undefined : own.get(key.toUpperCase())
        if (key === undefined || mine?.price === undefined) return undefined
        return {
          own_key: key,
          own_title: mine.title,
          own_price: mine.price,
          ...(mine.currency === undefined ? {} : { currency: mine.currency }),
        }
      }
      const out = diffCatalog({
        workspace_id: world.workspace_id as WorkspaceId,
        source: { id: source_id, kind: 'amazon_asin', competitor_id },
        competitor: input.competitor,
        previous: snapshots.get(source_id),
        read: { rows: got.rows, complete: got.complete },
        now,
        ...(input.own === true ? {} : { ownRef }),
      })
      snapshots.set(source_id, out.snapshot)
      world.appendEvent('simulation.competitor_read', {
        competitor: input.competitor,
        source: 'amazon',
        status: got.error === undefined ? 'ok' : 'failed',
        rows: got.rows.length,
        baseline: out.baseline,
        changes: out.changes.length,
        ...(got.via === undefined ? {} : { via: got.via }),
        ...(got.credits === undefined ? {} : { credits: got.credits }),
        ...(got.blocked === true ? { blocked: true } : {}),
        ...(input.own === true ? { own: true } : {}),
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
          ...(c.vs_own === undefined ? {} : { vs_own: c.vs_own.diff }),
        })
      return out.changes
    },
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
