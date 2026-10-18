/**
 * WP398：别的几单读到的 Amazon 页 → 词库要的 Listing 文本（{@link AmazonListingText}）。
 *
 * - {@link listingTextsFromSnapshots}：竞品监控的快照（WP392 的 `CatalogSnapshot`，`amazon_asin` 那种源；
 *   自家 ASIN 那组 `competitor_id = _own` 算自家）。标题一直有；五点要 WP394 的进料口顺手填 `bullets`；
 * - {@link listingTextsFromFacts}：Listing 体检读到的商品页（WP396 的 `AmazonListingFacts` 那几格）。
 *
 * 服务端装配时把这两份接到词库的 `competitorListings` / `ownListings` 上（或读到页时 `ingestListings`）。
 */
import {
  type AmazonListingText,
  type CatalogSnapshot,
  type CompetitorWatchSource,
  type Iso8601,
  OWN_BRAND_COMPETITOR_ID,
} from '@agentsws/contracts'

export function listingTextsFromSnapshots(input: {
  sources: readonly CompetitorWatchSource[]
  snapshot(source_id: string): CatalogSnapshot | undefined
  /** 竞品 id → 名字（`BrandWatchCompetitor`）。 */
  names: ReadonlyMap<string, string>
}): AmazonListingText[] {
  const out: AmazonListingText[] = []
  for (const src of input.sources) {
    if (src.kind !== 'amazon_asin') continue
    const snap = input.snapshot(src.id)
    if (snap === undefined) continue
    const own = src.competitor_id === OWN_BRAND_COMPETITOR_ID
    const name = input.names.get(src.competitor_id) ?? src.competitor ?? src.label
    for (const row of snap.rows) {
      if (row.removed === true || row.title.trim() === '') continue
      out.push({
        side: own ? 'own' : 'competitor',
        asin: row.product_key,
        marketplace: src.marketplace ?? 'US',
        title: row.title,
        ...(row.bullets === undefined || row.bullets.length === 0 ? {} : { bullets: row.bullets }),
        ...(own ? {} : { competitor_id: src.competitor_id }),
        ...(own || name === undefined ? {} : { competitor: name, brand: name }),
        read_at: row.last_seen_at,
      })
    }
  }
  return out
}

/** Listing 体检读到的那几格（结构上就是 WP396 `AmazonListingFacts` 的子集）。 */
export interface ListingFactsLike {
  asin: string
  marketplace: string
  read_at: Iso8601
  title?: string
  brand?: string
  bullets: string[]
}

export function listingTextsFromFacts(
  facts: readonly ListingFactsLike[],
  side: AmazonListingText['side'] = 'own',
): AmazonListingText[] {
  return facts
    .filter((f) => (f.title ?? '').trim() !== '' || f.bullets.some((b) => b.trim() !== ''))
    .map((f) => ({
      side,
      asin: f.asin,
      marketplace: f.marketplace,
      title: f.title ?? '',
      bullets: f.bullets.filter((b) => b.trim() !== ''),
      ...(f.brand === undefined ? {} : { brand: f.brand }),
      read_at: f.read_at,
    }))
}
