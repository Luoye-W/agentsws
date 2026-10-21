/**
 * WP447（docs/109 §6.2）：六个新平台**官方导出报表**的列名对照——做成数据，不写进解析逻辑。
 *
 * 每个字段一条：`verified` 是官方帮助页 / 官方文档里写着的列名（`source` 是那一页），`generic` 是各家
 * 通用的写法（Campaign name 之类）——**官方页没写这一列叫什么**时，解析照样按通用写法认，但导入记录里
 * 会照实说「这一列按通用写法认的，没对官方核过」（派工单：拿不准的标「未知」不猜）。`status: 'unknown'`
 * = 官方页没写，我们也不给通用写法以外的猜测。
 *
 * 10-21 读的官方页（只读公开帮助页，没登录任何后台、没下载真导出）：
 * - Microsoft Advertising：help.ads.microsoft.com 报表帮助（50833 / 56760 / 50824）与
 *   learn.microsoft.com 的 reporting-service（CampaignPerformanceReportColumn、Reports 指南）；
 * - Pinterest：help.pinterest.com/en/ad-reporting；
 * - Reddit：business.reddithelp.com 的 the-dashboard、the-report-manager、Reddit-Ads-reporting；
 * - LinkedIn：linkedin.com/help/lms answer a445476、a420212、a441785、a452049、a420851；
 * - Snapchat：businesshelp.snapchat.com 的 story-ad-metrics、metrics、conversion-metrics-glossary、export-reports；
 * - Apple Ads：ads.apple.com/app-store/help/reporting 0023、0026。
 *
 * **真导出没对过**：头一批真用户拖进来一份，按它补这张表（报告「未完成」那一节）。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import type { ExportField } from '../sheets/parse.js'

/** 这六个平台（只读、走导出那几个）。 */
export type ExportPlatform = Extract<
  AdsPlatform,
  'microsoft' | 'pinterest' | 'reddit' | 'linkedin' | 'snapchat' | 'apple'
>

export const EXPORT_PLATFORMS: readonly ExportPlatform[] = [
  'microsoft',
  'pinterest',
  'reddit',
  'linkedin',
  'snapchat',
  'apple',
]

export function isExportPlatform(p: string): p is ExportPlatform {
  return (EXPORT_PLATFORMS as readonly string[]).includes(p)
}

/** 一个字段在这家导出里叫什么。 */
export interface ExportColumn {
  /** 官方页上写着的列名（`source` 那一页）。 */
  verified?: readonly string[]
  /** 官方页没写时按的通用写法（导入记录里会说「没对官方核过」）。 */
  generic?: readonly string[]
  /** `unknown` = 官方页没写这一列叫什么。 */
  status: 'verified' | 'unknown'
  source?: string
}

/** 一家导出的样子。 */
export interface ExportFormat {
  platform: ExportPlatform
  /** 官方说给哪几种文件（只写官方页写了的）。 */
  file_types: readonly ('csv' | 'tsv' | 'xlsx' | 'zip')[]
  /** 字段 → 列名。不在表里的字段 = 这家没有这一项（比如 Apple 没有转化价值）。 */
  columns: Partial<Record<ExportField, ExportColumn>>
  /**
   * 认这一家的那几个列名（只用官方核过的、**归一之后**别家不会撞上的；文件名里的词另算）。
   * 注意归一会去掉空格：「CampaignName」与「Campaign name」是同一个，不能当特征。
   */
  signature_headers: readonly string[]
  /** 表头之外（说明行、版权行）出现就加分的字（小写）。 */
  text_hints?: readonly string[]
  /** 文件名里出现就加分的词（小写）。 */
  file_name_hints: readonly string[]
  /**
   * 报表默认按什么时区出（官方页写了的才填）。文件里写了时区的以文件为准。
   * LinkedIn：官方说报表按 UTC。
   */
  default_timezone?: string
  /** 这家报表的 ROAS 是不是百分数（Microsoft：Revenue ÷ Spend，以百分数表示）。 */
  roas_is_percent?: boolean
  /** 转化数在这家叫什么（卡上那一格的名字：Apple 是「安装」）。 */
  conversions_label?: { zh: string; en: string }
}

/** 各家通用的写法（只在那家官方页没写这一列时用）。 */
const GENERIC: Partial<Record<ExportField, readonly string[]>> = {
  account: ['Account', 'Account name', 'Account Name', 'Ad account', 'Ad account name'],
  account_id: ['Account ID', 'Ad account ID'],
  campaign: ['Campaign', 'Campaign name', 'Campaign Name'],
  campaign_id: ['Campaign ID'],
  campaign_status: ['Campaign status', 'Campaign Status'],
  ad_group: ['Ad group', 'Ad group name', 'Ad Group Name', 'Ad set', 'Ad set name', 'Ad Set Name'],
  ad_group_id: ['Ad group ID', 'Ad set ID'],
  ad: ['Ad', 'Ad name', 'Ad Name'],
  ad_id: ['Ad ID'],
  status: ['Status'],
  day: ['Date', 'Day'],
  currency: ['Currency', 'Currency code'],
}

const MS =
  'https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportcolumn'
const MS_UI = 'https://help.ads.microsoft.com/#apex/ads/en/50824/2-500'
const PIN = 'https://help.pinterest.com/en/ad-reporting'
const RDT = 'https://business.reddithelp.com/s/article/the-dashboard'
const LI_M = 'https://www.linkedin.com/help/lms/answer/a445476'
const LI_C = 'https://www.linkedin.com/help/lms/answer/a420212'
const SNAP_S = 'https://businesshelp.snapchat.com/s/article/story-ad-metrics'
const SNAP_M = 'https://businesshelp.snapchat.com/s/article/metrics'
const SNAP_C = 'https://businesshelp.snapchat.com/s/article/conversion-metrics-glossary'
const APPLE =
  'https://ads.apple.com/app-store/help/reporting/0023-reporting-options-and-definitions'

const v = (names: readonly string[], source: string): ExportColumn => ({
  verified: names,
  status: 'verified',
  source,
})
/** 官方页没写：只按通用写法认（没有通用写法的就是认不出）。 */
const unknown = (field: ExportField): ExportColumn => {
  const g = GENERIC[field]
  return g === undefined ? { status: 'unknown' } : { status: 'unknown', generic: g }
}
/** 名字 / 编号这几格：官方页写了就用官方的，没写就是 `unknown` + 通用写法。 */
const NAMES_UNKNOWN: Partial<Record<ExportField, ExportColumn>> = {
  account: unknown('account'),
  account_id: unknown('account_id'),
  campaign: unknown('campaign'),
  campaign_id: unknown('campaign_id'),
  campaign_status: unknown('campaign_status'),
  ad_group: unknown('ad_group'),
  ad_group_id: unknown('ad_group_id'),
  ad: unknown('ad'),
  ad_id: unknown('ad_id'),
  status: unknown('status'),
  day: unknown('day'),
  currency: unknown('currency'),
}

export const EXPORT_FORMATS: Readonly<Record<ExportPlatform, ExportFormat>> = {
  microsoft: {
    platform: 'microsoft',
    // 报表页下载：.zip（CSV）/ .zip（TSV）/ .xlsx；广告系列页即时报表：.csv / Excel
    file_types: ['csv', 'tsv', 'xlsx', 'zip'],
    columns: {
      ...NAMES_UNKNOWN,
      // 界面帮助页的写法 + 接口报表的写法（定时报表两种都可能出现）
      account: v(['Account', 'Account name', 'AccountName'], MS_UI),
      account_id: v(['Account ID', 'Account number', 'AccountId', 'AccountNumber'], MS_UI),
      campaign: v(['Campaign', 'Campaign name', 'CampaignName'], MS_UI),
      campaign_id: v(['Campaign ID', 'CampaignId'], MS_UI),
      campaign_status: v(['Campaign status', 'CampaignStatus'], MS_UI),
      ad_group: v(['Ad group', 'AdGroupName'], MS_UI),
      ad_group_id: v(['Ad group ID', 'AdGroupId'], MS_UI),
      ad_id: v(['Ad ID', 'AdId'], MS_UI),
      day: v(['Date', 'TimePeriod'], MS),
      currency: v(['Currency', 'Currency code', 'CurrencyCode'], MS),
      cost: v(['Spend'], MS),
      impressions: v(['Impressions'], MS),
      clicks: v(['Clicks'], MS),
      conversions: v(['Conversions'], MS),
      conversion_value: v(['Revenue'], MS),
      roas: v(['Return on ad spend (ROAS)', 'ReturnOnAdSpend'], MS),
    },
    // 「CurrencyCode」归一后与 Google 的「Currency code」撞，「Revenue」太常见，都不当特征
    signature_headers: ['TimePeriod', 'AccountNumber', 'ReturnOnAdSpend'],
    text_hints: ['microsoft corporation', 'report aggregation:', 'last completed available day'],
    file_name_hints: ['microsoft', 'bing', 'msads'],
    roas_is_percent: true,
  },
  pinterest: {
    platform: 'pinterest',
    file_types: ['csv'],
    columns: {
      ...NAMES_UNKNOWN,
      cost: v(['Spend'], PIN),
      impressions: v(['Impressions'], PIN),
      // 「Pin clicks」当点击；「Outbound clicks」（点出去到你网站的）原样留在行里
      clicks: v(['Pin clicks'], PIN),
      conversions: { status: 'unknown' },
      conversion_value: { status: 'unknown' },
      roas: { status: 'unknown' },
    },
    signature_headers: ['Pin clicks', 'Outbound clicks'],
    file_name_hints: ['pinterest'],
  },
  reddit: {
    platform: 'reddit',
    file_types: ['csv'],
    columns: {
      ...NAMES_UNKNOWN,
      campaign_id: v(['Campaign ID'], RDT),
      cost: v(['Amount spent'], RDT),
      impressions: v(['Impressions'], RDT),
      clicks: v(['Clicks'], RDT),
      // 「Total results」是按目标算的结果数，不一定是购买——不当转化（原样留在行里）
      conversions: { status: 'unknown' },
      conversion_value: v(['Total value'], RDT),
      roas: v(['ROAS (Return on ad spend)'], RDT),
    },
    signature_headers: ['Total results', 'Pacing', 'Total value'],
    file_name_hints: ['reddit'],
  },
  linkedin: {
    platform: 'linkedin',
    file_types: ['csv'],
    columns: {
      ...NAMES_UNKNOWN,
      cost: v(['Spent'], LI_M),
      impressions: v(['Impressions'], LI_M),
      clicks: v(['Clicks'], LI_M),
      conversions: v(['Conversions'], LI_M),
      conversion_value: v(['Total conversion value'], LI_C),
      roas: v(['Return on ad spend'], LI_C),
    },
    signature_headers: ['Spent', 'Total conversion value', 'Click conversions', 'View conversions'],
    file_name_hints: ['linkedin', 'campaign_manager'],
    // 官方：Campaign Manager 的报表按 UTC（answer a420851）
    default_timezone: 'UTC',
  },
  snapchat: {
    platform: 'snapchat',
    // 官方页写了 CSV 与 Excel
    file_types: ['csv', 'xlsx'],
    columns: {
      ...NAMES_UNKNOWN,
      cost: v(['Amount Spent'], SNAP_S),
      impressions: v(['Paid Impressions'], SNAP_M),
      // 点击那一列叫「Swipe Ups」还是「Swipes」官方页没写
      clicks: { status: 'unknown' },
      conversions: v(['Purchases'], SNAP_C),
      conversion_value: v(['Purchases Value'], SNAP_C),
      roas: v(['ROAS (return on ad spend)'], SNAP_C),
    },
    signature_headers: ['Paid Impressions', 'Paid eCPM', 'Purchases Value', 'Paid Frequency'],
    file_name_hints: ['snapchat', 'snap'],
  },
  apple: {
    platform: 'apple',
    // 自定义报表只给 .xlsx（Apple Ads Basic 的国家 / 地区结果是 CSV）
    file_types: ['xlsx', 'csv'],
    columns: {
      ...NAMES_UNKNOWN,
      day: v(['Day'], 'https://ads.apple.com/app-store/help/reporting/0026-create-custom-reports'),
      cost: v(['Spend'], APPLE),
      impressions: v(['Impressions'], APPLE),
      clicks: v(['Taps'], APPLE),
      // 转化 = 安装（先认合计，没有合计认点击后安装）
      conversions: v(['Installs (Total)', 'Installs (Tap-Through)'], APPLE),
      // Apple Ads 后台没有转化价值 / ROAS（App 内收入要看归因平台）
    },
    signature_headers: ['Taps', 'TTR', 'Average CPT', 'Installs (Total)', 'Installs (Tap-Through)'],
    file_name_hints: ['apple', 'searchads', 'search_ads'],
    conversions_label: { zh: '安装', en: 'Installs' },
  },
}
