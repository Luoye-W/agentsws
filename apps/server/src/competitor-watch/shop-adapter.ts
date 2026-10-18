/**
 * WP393（docs/104 一期 A）：`shop_catalog` 进料口——读竞品独立站的公开商品目录，接进 WP392 那条管道。
 *
 * - 先本机直接请求；被挡（429 / 403 / Cloudflare 验证页）改用工坊内置浏览器在那个站里读同一个地址（`kind: 'data'`）；
 *   还读不到就照实说，不重试、不绕（读、翻页、atom 都在 `@agentsws/brand-intake` 的 `readShopCatalog`）；
 * - 每读一页都排进内置浏览器那条全进程节流队（每小时 ≤60 页，决策 914）；满了这一次就停、标没读全；
 * - 读不到别抛：回 `{ rows: [], complete: false, error }`，那一句是人话、不提任何实现名。
 */
import {
  type BrowserTextRead,
  type PageFetch,
  readShopCatalog,
  type ShopCatalogIo,
} from '@agentsws/brand-intake'
import type {
  CatalogSnapshotRow,
  CompetitorIntakeAdapter,
  CompetitorWatchSource,
} from '@agentsws/contracts'
import type { SearchBrowserChannel } from '../web-browser/index.js'

/** 内置浏览器读数据原文要等多久（Shopify 一页 250 件的 JSON 要一会儿）。 */
export const BROWSER_DATA_TIMEOUT_MS = 30_000

/** 内置浏览器那条本机通道 → 「读一个地址的原文」。 */
export function browserTextReadOf(
  channel: SearchBrowserChannel,
  workspace_id: string,
): BrowserTextRead {
  return async (url) => {
    const r = await channel.open({
      workspace_id,
      url,
      kind: 'data',
      timeout_ms: BROWSER_DATA_TIMEOUT_MS,
      settle_ms: 1_500,
      max_chars: 8_000_000,
    })
    if (!r.ok) return { ok: false, message: r.message }
    if (r.page === undefined) return { ok: false, message: '内置浏览器没交回内容' }
    return {
      ok: true,
      status: r.status,
      final_url: r.final_url,
      text: r.page.text,
      truncated: r.page.truncated,
      challenge: r.page.signals.captcha,
    }
  }
}

/** 本机直接请求（跟跳转；不带任何凭据）。 */
export const nodePageFetch: PageFetch = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'follow' })
  return { ok: res.ok, status: res.status, url: res.url, text: () => res.text() }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface ShopCatalogAdapterOptions {
  fetch?: PageFetch
  /** 内置浏览器（懒取：桌面壳那条通道；没有桌面壳 = `undefined`，被挡就照实说）。 */
  browser?(): BrowserTextRead | undefined
  /** 每读一页都经它（全进程那条节流队）；满了回 `undefined`。 */
  page?<T>(task: () => Promise<T>): Promise<T | undefined>
}

export function createShopCatalogAdapter(
  options: ShopCatalogAdapterOptions = {},
): CompetitorIntakeAdapter {
  return {
    kind: 'shop_catalog',
    async read(source: CompetitorWatchSource, ctx) {
      const browser = options.browser?.()
      const io: ShopCatalogIo = {
        fetch: options.fetch ?? nodePageFetch,
        ...(browser === undefined ? {} : { browser }),
        ...(options.page === undefined ? {} : { page: options.page }),
      }
      const out = await readShopCatalog(io, {
        url: source.url,
        platform: source.platform ?? 'unknown',
        now: ctx.now,
      })
      const rows: CatalogSnapshotRow[] = out.rows.map((r) => ({
        ...r,
        source_id: source.id,
        competitor_id: source.competitor_id,
        read_at: ctx.now,
      }))
      if (rows.length === 0 && out.error !== undefined)
        return {
          rows: [],
          complete: false,
          via: out.via,
          error: `读不到 ${hostOf(source.url)} 的商品数据：${out.error}`,
          notes: out.notes,
        }
      return { rows, complete: out.complete, via: out.via, notes: out.notes }
    },
  }
}
