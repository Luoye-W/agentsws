/**
 * WP394（docs/104 一期 B，C4）：`amazon_asin` 的**进料口适配器**——接进 WP392 那条管道（判变化、入库、调度都在管道里）。
 *
 * 一条源 = 一家竞品（或自家）在一个站点上的几款。读一次：
 * - 内置浏览器读商品页（`amazon-front/reader.ts`：自报 `Agent/AgentsWorkshop`、配送邮编、币种不符重设一次）；
 *   **被拦就停**，这一轮剩下的走工坊云端数据；被拦后的暂停期里整条直接走云端（不再碰 Amazon）；
 * - 没有桌面壳 → 走云端；云端没接上 → 照实说没读；
 * - **ASIN 多的分几个小时读完**：这一小时额度满了，读到的先记在这一批里、标「没读全」（管道不判下架），
 *   隔一小时再接着读剩下的（`due.ts` 对没读全的 Amazon 源隔一小时再试）；一批读全了才算这一天读完；
 *   同一个 ASIN 一批里读两次都不成（配送地址设不对 / 打不开）就先放下，照实说，不一直撞。
 * - WP402（决策 1140 / 1146）：内置浏览器和云端都没读到的，第 3 条路通过插件在用户自己的浏览器里读
 *   （第一次先出卡问同意、每家每天至多一次；规矩在 `amazon-front/own-browser.ts`）。
 */
import {
  type AmazonCloudRead,
  type AmazonOwnBrowserRoute,
  type AmazonPageOutcome,
  readAmazonAsins,
} from '@agentsws/brand-intake'
import type {
  CatalogReadContext,
  CatalogReadResult,
  CatalogSnapshotRow,
  CompetitorIntakeAdapter,
  CompetitorWatchSource,
  CompetitorWatchStore,
} from '@agentsws/contracts'
import type { AmazonFrontReader } from '../amazon-front/reader.js'

/** 一批（一天那一轮）读到哪了。 */
interface AmazonBatch {
  started_at: string
  rows: CatalogSnapshotRow[]
  /** 这一批里每个 ASIN 试过几次没成。 */
  tries: Record<string, number>
}

const BATCH_PREFIX = 'amz_batch:'
/** 同一个 ASIN 一批里最多试几次。 */
export const AMAZON_BATCH_TRIES = 2

export interface AmazonAsinAdapterDeps {
  /** 读前台那一块（没有 = 这台没有桌面壳）。 */
  reader(): AmazonFrontReader | undefined
  /** 云端兜底（没有 = 还没关联账号 / 托管实例）。 */
  cloud():
    | ((input: { marketplace: string; asins: string[] }) => Promise<AmazonCloudRead>)
    | undefined
  store(): CompetitorWatchStore
  /** 这一次走云端扣了积分（记一笔：「这次扣了多少」那一句用）。 */
  onCredits?(source_id: string, credits: number): void
  /**
   * WP402（决策 1140 / 1146）：第 3 条路——通过插件在用户自己的浏览器里读（按竞品源 id 管每天一次；没装插件 = 不给）。
   */
  ownBrowser?(source_id: string): AmazonOwnBrowserRoute | undefined
  /** WP402：取数链说「要问一句同意」（第一次出卡）。 */
  onNeedsConsent?(source_id: string): void
}

export function createAmazonAsinAdapter(deps: AmazonAsinAdapterDeps): CompetitorIntakeAdapter {
  return {
    kind: 'amazon_asin',
    async read(source: CompetitorWatchSource, ctx: CatalogReadContext): Promise<CatalogReadResult> {
      const store = deps.store()
      const asins = [...new Set((source.asins ?? []).map((a) => a.trim().toUpperCase()))]
      // 上次读得最早的在前（没读过的最前）
      const seen = new Map(
        (store.snapshot(source.id)?.rows ?? []).map((r) => [r.product_key, r.last_seen_at]),
      )
      const order = [...asins].sort((a, b) => (seen.get(a) ?? '').localeCompare(seen.get(b) ?? ''))
      const key = `${BATCH_PREFIX}${source.id}`
      const saved = store.kv<AmazonBatch | null>(key) ?? undefined
      const windowMs = Math.max(1, (source.every_hours ?? 24) - 2) * 3_600_000
      const batch =
        saved !== undefined && Date.parse(ctx.now) - Date.parse(saved.started_at) < windowMs
          ? saved
          : undefined
      const done = new Map((batch?.rows ?? []).map((r) => [r.product_key, r]))
      const tries: Record<string, number> = { ...(batch?.tries ?? {}) }
      const gaveUp = order.filter((a) => !done.has(a) && (tries[a] ?? 0) >= AMAZON_BATCH_TRIES)
      const todo = order.filter((a) => !done.has(a) && !gaveUp.includes(a))

      const reader = deps.reader()
      const live = reader?.ready() === true ? reader : undefined
      const browser =
        live === undefined
          ? undefined
          : (i: { marketplace: string; asin: string }): Promise<AmazonPageOutcome> =>
              live.readFacts(i)
      const cloud = deps.cloud()
      const extension = deps.ownBrowser?.(source.id)
      const got = await readAmazonAsins(
        { ...source, asins: todo },
        {
          ...(browser === undefined ? {} : { browser }),
          ...(cloud === undefined ? {} : { cloud }),
          ...(extension === undefined ? {} : { extension }),
          now: ctx.now,
          order,
        },
      )
      if (got.needs_consent === true) deps.onNeedsConsent?.(source.id)
      for (const a of got.unread ?? []) tries[a] = (tries[a] ?? 0) + 1
      if (got.credits !== undefined && got.credits > 0) deps.onCredits?.(source.id, got.credits)
      const rows = [...done.values(), ...got.rows]
      const left = [...gaveUp, ...(got.unread ?? [])]
      const complete = got.complete && left.length === 0
      const notes = [...(got.notes ?? [])]
      if (reader !== undefined && browser === undefined && reader.pausedUntil() !== undefined)
        notes.unshift(
          'Amazon 前几个小时要过人机验证，内置浏览器先不读 Amazon，这一轮走工坊云端数据',
        )
      if (batch !== undefined && done.size > 0)
        notes.push(`接着上一拍读（前面已读 ${done.size} 个）`)
      if (gaveUp.length > 0) notes.push(`${gaveUp.join('、')} 今天试了两次都没读成，先放下`)
      if (complete) store.setKv(key, null)
      else
        store.setKv(key, {
          started_at: batch?.started_at ?? ctx.now,
          rows,
          tries,
        } satisfies AmazonBatch)
      const out: CatalogReadResult = {
        rows,
        complete,
        notes,
        ...(got.via === undefined ? {} : { via: got.via }),
        ...(got.credits === undefined ? {} : { credits: got.credits }),
        ...(got.attempts === undefined ? {} : { attempts: got.attempts }),
        ...(got.needs_consent === true ? { needs_consent: true } : {}),
      }
      if (rows.length === 0 && got.error !== undefined) out.error = got.error
      return out
    },
  }
}
