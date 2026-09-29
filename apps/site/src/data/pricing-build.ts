/**
 * 构建时取价目：一次构建只打一次网（中英两页共用这一份）。
 * 取不到用仓库里那份固定样例（`packages/stand-ins/src/cloud/pricing-sample.ts`）——直接引它的源码，
 * 不拖整个替身包进官网。`AGENTSWS_SITE_OFFLINE=1` 时不打网、直接用样例。
 */
import { SAMPLE_PRICING_CATALOG } from '../../../../packages/stand-ins/src/cloud/pricing-sample.ts'
import { PRICING_URL } from '../config.js'
import { loadPricing, type SitePricing } from '../lib/pricing.js'

let once: Promise<SitePricing> | undefined

export function buildPricing(): Promise<SitePricing> {
  once ??= loadPricing({
    url: PRICING_URL,
    sample: SAMPLE_PRICING_CATALOG,
    offline: process.env.AGENTSWS_SITE_OFFLINE === '1',
  }).then((p) => {
    console.log(
      `[site] 价目：${p.source === 'cloud' ? `云上 ${PRICING_URL}` : '仓库样例（没连上云）'}`,
    )
    return p
  })
  return once
}
