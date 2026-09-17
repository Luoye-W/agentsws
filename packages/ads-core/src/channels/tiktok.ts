/**
 * TikTok Ads 适配器（57 §2：**本 WP 只有接口 + 一句人话**）。
 *
 * 为什么还没做：**要先在 TikTok Business Center 里把广告账户授权给一个应用**，
 * 而那个应用要过 TikTok 的开发者审核。与社媒那条（`social.tiktok` 的
 * Content Posting API）是两套申请、两把 token——批了一个不等于批了另一个。
 *
 * 另外 Spark Ads（投一条已经发过的有机视频）还要**有机账号那一侧**先给授权码，
 * 所以它天然依赖 `social.tiktok` 那条连接。接上那天这一条要一起做，
 * 不然面板上会出现"能建广告但投不了自己的视频"这种半截状态。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import {
  type AdsChangeRequest,
  type AdsChannelAdapter,
  type AdsResult,
  type AdsTransport,
  notImplemented,
} from './types.js'

const PLATFORM: AdsPlatform = 'tiktok'
const LABEL = 'TikTok Ads'
const PLAN =
  '要先在 Business Center 里把广告账户授权给一个过了审的开发者应用；' +
  'Spark Ads 还要有机账号那一侧再给一次授权码（依赖 `social.tiktok` 那条连接）'

/** 官方基址，钉在这里是为了接上那天不用现查文档。 */
export const TIKTOK_ADS_BASE = 'https://business-api.tiktok.com/open_api/v1.3'

export function createTiktokAdsAdapter(_transport: AdsTransport): AdsChannelAdapter {
  const off = <T>(): Promise<AdsResult<T>> => Promise.resolve(notImplemented(LABEL, PLAN))
  return {
    platform: PLATFORM,
    implemented: false,
    accounts: () => off(),
    campaigns: () => off(),
    adSets: () => off(),
    insights: () => off(),
    pixels: () => off(),
    applyChange: (_input: AdsChangeRequest) => off(),
  }
}
