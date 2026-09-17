/**
 * X Ads 适配器（57 §2：**本 WP 只有接口 + 一句人话**）。
 *
 * 为什么还没做，不是"没排上"，是一道真门槛：**X Ads API 是申请制**——
 * 要先有一个广告账户、提交 Ads API 的使用申请、说明用途并等人工审核，
 * 批下来才拿得到 `ads_account_id` 与那把能动预算的 token。社媒那条
 * （`social.x`）用的是另一套（X API v2 的付费档），两者互不顶替：
 * 买了社媒那个档，广告这边照样是 403。
 *
 * 所以这个文件不是空壳，它有一件正事要做：**把"还没接"与"连接失败"分开说**。
 * 五个口子一律回 `not_implemented` + 一句解释得清的话——提案、审批、额度、
 * 面板骨架照常能用，缺的只有真正动到平台那一跳。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import {
  type AdsChangeRequest,
  type AdsChannelAdapter,
  type AdsResult,
  type AdsTransport,
  notImplemented,
} from './types.js'

const PLATFORM: AdsPlatform = 'x'
const LABEL = 'X Ads'
const PLAN =
  'X Ads API 是申请制：要先有广告账户、提交 Ads API 申请、说明用途、等人工审核。' +
  '社媒那条职责买的 X API 付费档**不管用**，广告这一侧是另一套授权'

/** 官方基址，钉在这里是为了接上那天不用现查文档。 */
export const X_ADS_BASE = 'https://ads-api.x.com/12'

export function createXAdsAdapter(_transport: AdsTransport): AdsChannelAdapter {
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
