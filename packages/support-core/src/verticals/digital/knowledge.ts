/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/knowledge.ts
 * （DIGITAL_KNOWLEDGE，S039 FR-020），**逐字节**。
 *
 * 三件事：goods 那七条路径**不删**（用 Shopify 或 Webflow 建落地页的 SaaS 照样可能
 * 把条款放在 `/policies/refund-policy`）；追加 SaaS 的七条；子域加 `docs.`
 * ——SaaS 的文档站十有八九在那儿，而它往往是这类产品**唯一**一份成体系的客服知识。
 * `enumerateCatalog = false`：虚拟产品没有商品可枚举。
 */

import { GOODS_KNOWLEDGE } from '../goods/knowledge.js'
import type { VerticalKnowledgePack } from '../types.js'

/** §3.8 第 1 条的七条 digital 路径（顺序即探测顺序）。 */
const DIGITAL_EXTRA_PATHS = [
  '/docs',
  '/documentation',
  '/help',
  '/changelog',
  '/releases',
  '/pricing',
  '/status',
]

/**
 * goods 七条在前、digital 七条在后，重复项（`/help`）只保留一次。
 *
 * 去重不是洁癖：这个数组每一项都对应 onboarding 期间的一次真实 HTTP 探测，重复项
 * 就是重复的一次请求和一次可能重复入库的候选页。
 */
const DIGITAL_WELL_KNOWN_PATHS = [
  ...GOODS_KNOWLEDGE.wellKnownPaths,
  ...DIGITAL_EXTRA_PATHS.filter((path) => !GOODS_KNOWLEDGE.wellKnownPaths.includes(path)),
]

const DIGITAL_SUPPORT_SUBDOMAINS = [...GOODS_KNOWLEDGE.supportSubdomains, 'docs']

export const DIGITAL_KNOWLEDGE: VerticalKnowledgePack = {
  wellKnownPaths: DIGITAL_WELL_KNOWN_PATHS,
  supportSubdomains: DIGITAL_SUPPORT_SUBDOMAINS,
  enumerateCatalog: false,
}
