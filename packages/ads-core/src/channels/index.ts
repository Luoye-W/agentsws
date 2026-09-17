/**
 * 四条平台适配器的分派（57 §2）。
 *
 * **按 `ADS_PLATFORMS` 建，不另排一张表**：契约里那一份是全仓唯一的平台清单，
 * 这里多写一个名字或漏一个，都是一条静悄悄的错（漏的那条在面板上表现为
 * "这个平台永远没数"，而没有任何地方会报）。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import { ADS_PLATFORM_IDS } from '@agentsws/contracts'
import { createGoogleAdsAdapter } from './google.js'
import { createMetaAdsAdapter } from './meta.js'
import { createTiktokAdsAdapter } from './tiktok.js'
import type { AdsChannelAdapter, AdsTransport } from './types.js'
import { createXAdsAdapter } from './x.js'

export * from './google.js'
export * from './meta.js'
export * from './tiktok.js'
export * from './types.js'
export * from './x.js'

const FACTORIES: Record<AdsPlatform, (t: AdsTransport) => AdsChannelAdapter> = {
  meta: createMetaAdsAdapter,
  google: createGoogleAdsAdapter,
  x: createXAdsAdapter,
  tiktok: createTiktokAdsAdapter,
}

/** 建齐四条（顺序 = `ADS_PLATFORMS`）。 */
export function createAdsAdapters(transport: AdsTransport): Record<AdsPlatform, AdsChannelAdapter> {
  const out = {} as Record<AdsPlatform, AdsChannelAdapter>
  for (const id of ADS_PLATFORM_IDS) out[id] = FACTORIES[id](transport)
  return out
}

/** 一条；不认识的平台回 `undefined`（**不给一个空壳**）。 */
export function createAdsAdapter(
  platform: string,
  transport: AdsTransport,
): AdsChannelAdapter | undefined {
  const factory = FACTORIES[platform as AdsPlatform]
  return factory === undefined ? undefined : factory(transport)
}
