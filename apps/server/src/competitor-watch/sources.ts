/**
 * WP392（docs/104 C3）：竞品清单**只有一份**——`BrandWatch.competitors`（GEO 关注设置那份，三家共用）。
 * 监控源由它同步出来（纯函数）：
 *
 * - 竞品写了独立站（`store.url`）→ 一条 `shop_catalog`（`cw_shop_<竞品 id>`）；
 * - 竞品写了 Amazon 对标款 → 按站点各一条 `amazon_asin`（`cw_amz_<竞品 id>_<站点>`）；
 * - 自家写了 Amazon 商品（`brand.amazon`，C8 对照）→ 按站点各一条（`cw_amz__own_<站点>`，`group: 'own'`）。
 *
 * 清单里删掉的竞品 / 格子，对应的源一起删、快照一起删（变化表里的历史留着）；店址改了 = 换了一家店，快照重来。
 * 不另建清单、不另建设置页（C3）。
 */
import {
  type BrandWatch,
  type BrandWatchAmazonItem,
  type CompetitorWatchSource,
  type Iso8601,
  OWN_BRAND_COMPETITOR_ID,
  type WorkspaceId,
} from '@agentsws/contracts'

/** Amazon 各站点的首页（连接卡上给人看的那一格）。认不出的站点按 `amazon.<cc>`。 */
const AMAZON_HOSTS: Readonly<Record<string, string>> = {
  US: 'www.amazon.com',
  CA: 'www.amazon.ca',
  MX: 'www.amazon.com.mx',
  BR: 'www.amazon.com.br',
  UK: 'www.amazon.co.uk',
  GB: 'www.amazon.co.uk',
  DE: 'www.amazon.de',
  FR: 'www.amazon.fr',
  IT: 'www.amazon.it',
  ES: 'www.amazon.es',
  NL: 'www.amazon.nl',
  SE: 'www.amazon.se',
  PL: 'www.amazon.pl',
  JP: 'www.amazon.co.jp',
  AU: 'www.amazon.com.au',
  IN: 'www.amazon.in',
  AE: 'www.amazon.ae',
  SA: 'www.amazon.sa',
  SG: 'www.amazon.sg',
}

export function amazonHomeOf(marketplace: string): string {
  const mk = marketplace.trim().toUpperCase()
  return `https://${AMAZON_HOSTS[mk] ?? `www.amazon.${mk.toLowerCase()}`}`
}

/** 想要的那几条源（不含状态格）。 */
type Wanted = Omit<
  CompetitorWatchSource,
  | 'status'
  | 'created_at'
  | 'last_ok_at'
  | 'last_try_at'
  | 'last_error'
  | 'last_fetched'
  | 'last_fresh'
  | 'last_complete'
  | 'last_rows'
  | 'last_via'
>

const byMarket = (items: readonly BrandWatchAmazonItem[]): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const it of items) {
    const mk = it.marketplace.trim().toUpperCase()
    const asin = it.asin.trim().toUpperCase()
    if (mk === '' || asin === '') continue
    out.set(mk, [...new Set([...(out.get(mk) ?? []), asin])])
  }
  return out
}

/** 按关注设置算出该有的源。 */
export function wantedSources(
  watch: Pick<BrandWatch, 'brand' | 'competitors'>,
  ctx: { workspace_id: WorkspaceId; every_hours: number },
): Wanted[] {
  const base = {
    workspace_id: ctx.workspace_id,
    every_hours: ctx.every_hours,
    added_via: 'suggest' as const,
  }
  const out: Wanted[] = []
  for (const c of watch.competitors) {
    const url = c.store?.url.trim()
    if (c.store !== undefined && url !== undefined && url !== '')
      out.push({
        ...base,
        id: `cw_shop_${c.id}`,
        kind: 'shop_catalog',
        url,
        group: 'competitor',
        label: c.name,
        competitor: c.name,
        competitor_id: c.id,
        platform: c.store.platform,
      })
    for (const [mk, asins] of byMarket(c.amazon ?? []))
      out.push({
        ...base,
        id: `cw_amz_${c.id}_${mk}`,
        kind: 'amazon_asin',
        url: amazonHomeOf(mk),
        group: 'competitor',
        label: c.name,
        competitor: c.name,
        competitor_id: c.id,
        marketplace: mk,
        asins,
      })
  }
  for (const [mk, asins] of byMarket(watch.brand.amazon ?? []))
    out.push({
      ...base,
      id: `cw_amz_${OWN_BRAND_COMPETITOR_ID}_${mk}`,
      kind: 'amazon_asin',
      url: amazonHomeOf(mk),
      group: 'own',
      label: watch.brand.name,
      competitor_id: OWN_BRAND_COMPETITOR_ID,
      marketplace: mk,
      asins,
    })
  return out
}

export interface SourceSync {
  /** 新的 / 改了的（整条写回）。 */
  put: CompetitorWatchSource[]
  /** 不要了的源 id。 */
  remove: string[]
  /** 快照要重来的源 id（店址改了 = 换了一家店）。 */
  reset: string[]
}

/** 现有的源 vs 该有的源 → 要写 / 要删 / 快照要重来的。 */
export function syncSources(
  existing: readonly CompetitorWatchSource[],
  wanted: readonly Wanted[],
  now: Iso8601,
): SourceSync {
  const have = new Map(existing.map((s) => [s.id, s]))
  const want = new Set(wanted.map((w) => w.id))
  const out: SourceSync = { put: [], remove: [], reset: [] }
  for (const w of wanted) {
    const cur = have.get(w.id)
    if (cur === undefined) {
      out.put.push({ ...w, status: 'unchecked', created_at: now })
      continue
    }
    const moved = cur.url !== w.url
    const next: CompetitorWatchSource = moved
      ? {
          ...w,
          status: 'unchecked',
          created_at: cur.created_at,
          ...(cur.paused === undefined ? {} : { paused: cur.paused }),
        }
      : {
          ...cur,
          ...w,
          // 频率跟着设置走；状态格保留
          every_hours: w.every_hours,
        }
    if (!moved && w.platform === undefined) delete next.platform
    if (!moved && w.asins === undefined) delete next.asins
    if (!moved && w.competitor === undefined) delete next.competitor
    if (moved) out.reset.push(w.id)
    if (moved || JSON.stringify(next) !== JSON.stringify(cur)) out.put.push(next)
  }
  for (const s of existing) if (!want.has(s.id)) out.remove.push(s.id)
  return out
}
