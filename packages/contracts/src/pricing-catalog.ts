/**
 * 公开价目（WP165，docs/83 §2「价目表只放云上」）。
 *
 * 价格是生意，不进开源仓：云上出一条**公开只读**的 `GET /v1/pricing`（不要登录、可缓存），
 * 一次给齐价目表 + 充值档位——和以前本机内置、界面上显示的是同一份数据。
 *
 * 本机那一侧（`apps/server`）从云上取，落一份缓存离线显示：
 * - 取到了 → 用云上那份，顺手存盘；
 * - 取不到 → 用上一份存下来的（`source: 'cache'`）；
 * - 从来没取到过 → 显示「价目暂时拿不到」（`source: 'unavailable'`），**不编数**。
 *
 * demo 与测试用 `@agentsws/stand-ins` 里那份固定样例，不打网。
 */

import type { Pricing, TopupTiers } from './cloud-entry.js'
import type { Iso8601 } from './common.js'

/** 云上的公开价目那条路。不要令牌。 */
export const PRICING_CATALOG_PATH = '/v1/pricing'

/** 云上给的缓存时长（秒，`Cache-Control: public, max-age=…`）。改价是出一个版本，五分钟够用。 */
export const PRICING_CATALOG_MAX_AGE_S = 300

/** `GET /v1/pricing` 的 `data`。 */
export interface PricingCatalog {
  version: 1
  pricing: Pricing
  topup_tiers: TopupTiers
}

/**
 * 本机手上这一份价目是哪来的。
 *
 * - `cloud`：刚从云上取到的；
 * - `cache`：云上这次没取到，用的是上次存下的那份；
 * - `unavailable`：从没取到过，手上没有价目（列表是空的，界面说「价目暂时拿不到」）。
 */
export type LocalPricingSource = 'cloud' | 'cache' | 'unavailable'

/** 本机那一侧的出处说明（附在价目表 / 充值档位上，界面据此多说一句）。 */
export interface LocalPricingOrigin {
  source?: LocalPricingSource
  /** 这份是什么时候从云上取到的。 */
  fetched_at?: Iso8601
  /** `unavailable` 时的一句人话。 */
  unavailable_reason?: string
}

/** 本机 `/v1/cloud/pricing` 回的：价目表 + 出处（出处几格都可选，老客户端照旧读得懂）。 */
export interface LocalPricing extends Pricing, LocalPricingOrigin {}

/** 本机 `/v1/cloud/topup/tiers` 回的：充值档位 + 出处。 */
export interface LocalTopupTiers extends TopupTiers, LocalPricingOrigin {}

/** 从没取到过价目时的那一句。 */
export const PRICING_UNAVAILABLE_REASON =
  '价目暂时拿不到（云上连不通，这台电脑也还没存过一份）。连上网之后再看一眼。'

/** 手上没有价目时回的那一份：列表是空的，**一个数都不编**。 */
export function unavailablePricing(reason: string = PRICING_UNAVAILABLE_REASON): LocalPricing {
  return {
    version: 0,
    as_of: '',
    credit_cny: 1,
    ai_multiplier: 0,
    fx: {},
    entries: [],
    source: 'unavailable',
    unavailable_reason: reason,
  }
}

/** 手上没有充值档位时回的那一份（同上，空的）。 */
export function unavailableTopupTiers(
  reason: string = PRICING_UNAVAILABLE_REASON,
): LocalTopupTiers {
  return {
    version: 0,
    as_of: '',
    credits_per_usd: 0,
    tiers: [],
    source: 'unavailable',
    unavailable_reason: reason,
  }
}

/** 从云上 / 缓存文件读回来的东西像不像一份价目（只查骨架；坏的一律当没取到）。 */
export function isPricingCatalog(value: unknown): value is PricingCatalog {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<PricingCatalog>
  const p = v.pricing as Partial<Pricing> | undefined
  const t = v.topup_tiers as Partial<TopupTiers> | undefined
  return (
    typeof p === 'object' &&
    p !== null &&
    Array.isArray(p.entries) &&
    typeof p.as_of === 'string' &&
    typeof t === 'object' &&
    t !== null &&
    Array.isArray(t.tiers)
  )
}

/** 一项能力一个单位多少积分；价目里没有就 `undefined`（不编）。 */
export function catalogCreditsFor(
  pricing: Pick<Pricing, 'entries'> | undefined,
  capability: string,
  quantity = 1,
): number | undefined {
  const entry = pricing?.entries.find((e) => e.capability === capability)
  if (entry === undefined) return undefined
  return Math.round(entry.credits_per_unit * quantity * 10_000) / 10_000
}
