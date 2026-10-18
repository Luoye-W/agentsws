/**
 * WP396（docs/106 §13）：模拟世界里的**自家 Listing 体检**——读页积木是替身（场景里写死每页读到的那几格），
 * 判法用和服务进程同一份规则表与 `checkListing`（`@agentsws/seo-core`），不在这里另写一遍。
 *
 * 体检自己零写：不出卡、不改 Amazon，只记 `simulation.listing_read`（每读一页）、`simulation.listing_issue`
 * （每处问题）、`simulation.listing_checked`（一次的摘要）。被拦（`blocked`）那一页起都不读、不重试。
 */
import type { AmazonListingFacts } from '@agentsws/contracts'
import { checkListing, resolveClaimRules, resolveListingRules } from '@agentsws/seo-core'
import type { ScenarioListingCheck, ScenarioListingPage } from './scenario/types.js'
import type { World } from './world.js'

export interface ListingCheckOutcome {
  /** 第一处带「向设计岗下需求单」的问题（人点了就用它下单）。 */
  design?: { title: string; need: string }
}

const factsOf = (p: ScenarioListingPage, read_at: string): AmazonListingFacts => {
  const marketplace = (p.marketplace ?? 'US').toUpperCase()
  return {
    asin: p.asin,
    marketplace,
    url: `https://www.amazon.com/dp/${p.asin}`,
    read_at,
    ...(p.title === undefined ? {} : { title: p.title }),
    bullets: p.bullets ?? [],
    has_description: p.description ?? true,
    has_aplus: p.aplus ?? true,
    ...(p.images === undefined ? {} : { image_count: p.images }),
    has_main_image: (p.images ?? 1) > 0,
    has_video: p.video ?? true,
    variants: { present: false, child_asins: [], unavailable_count: 0 },
    ...(p.rating === undefined ? {} : { rating: p.rating }),
    ...(p.reviews === undefined ? {} : { reviews_count: p.reviews }),
    ...(p.price === undefined ? {} : { price: p.price }),
    availability: p.stock ?? 'in_stock',
    buybox: {
      present: (p.stock ?? 'in_stock') === 'in_stock',
      ...(p.seller === undefined ? {} : { seller: p.seller }),
    },
    undeliverable: false,
  }
}

export function runListingCheck(world: World, input: ScenarioListingCheck): ListingCheckOutcome {
  const now = world.clock.now()
  const stopAt = input.blocked ?? Number.POSITIVE_INFINITY
  const facts: AmazonListingFacts[] = []
  input.pages.forEach((p, i) => {
    if (i > stopAt) return
    if (i === stopAt) {
      world.appendEvent('simulation.listing_read', { asin: p.asin, status: 'blocked' })
      return
    }
    world.appendEvent('simulation.listing_read', { asin: p.asin, status: 'ok' })
    facts.push(factsOf(p, now))
  })
  const rules = resolveListingRules()
  let issues = 0
  let design: ListingCheckOutcome['design']
  for (const f of facts) {
    const r = checkListing({
      facts: f,
      rules,
      claimRules: resolveClaimRules({ markets: [f.marketplace], cards: [] }).rules,
      ownSellers: input.own_sellers ?? [],
      siblings: facts,
      now,
    })
    for (const issue of r.issues) {
      issues += 1
      design ??= issue.design_request
      world.appendEvent('simulation.listing_issue', {
        asin: f.asin,
        rule_id: issue.rule_id,
        severity: issue.severity,
        source: issue.source.title,
        draft: issue.draft !== undefined,
        design_request: issue.design_request !== undefined,
      })
    }
  }
  world.appendEvent('simulation.listing_checked', {
    pages: input.pages.length,
    read: facts.length,
    issues,
    ...(input.blocked === undefined ? {} : { stopped: 'blocked' }),
  })
  return design === undefined ? {} : { design }
}
