/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/knowledge.ts
 * （GOODS_KNOWLEDGE，S039 FR-005），**逐字节**。
 *
 * onboarding 期间值得各探一次的路径与子域。故意保持短：这在运营正在等的时候跑，
 * 探不到也不亏——常规抓取仍然会走完整个站。
 */

import type { VerticalKnowledgePack } from '../types.js'

/**
 * 非 Shopify 站上值得各探一次的路径。
 *
 * 故意保持短：这在 onboarding 期间跑、运营正在等，探不到也不亏 —— 常规爬取仍然
 * 会走完整个站。
 */
const GOODS_WELL_KNOWN_PATHS = [
  '/pages/faq',
  '/faq',
  '/help',
  '/support',
  '/pages/shipping-policy',
  '/policies/refund-policy',
  '/policies/shipping-policy',
]

/** 值得各发一次 HEAD 请求的子域。 */
const GOODS_SUPPORT_SUBDOMAINS = ['support', 'help', 'faq']

export const GOODS_KNOWLEDGE: VerticalKnowledgePack = {
  wellKnownPaths: GOODS_WELL_KNOWN_PATHS,
  supportSubdomains: GOODS_SUPPORT_SUBDOMAINS,
  enumerateCatalog: true,
}
