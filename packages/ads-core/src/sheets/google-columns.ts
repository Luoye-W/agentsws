/**
 * Google 广告「批量上传」的列名（docs/101 §2.1）。**全仓只有这一份**。
 *
 * 出处（2026-10-14 读）：
 * - 官方模板「Create New Campaign(s)」（.xlsx，从「模板和示例」页链出）表头逐字照抄：
 *   https://support.google.com/google-ads/answer/10702525?hl=en
 * - 格式规则（状态列留空 = 启用、要删写 Remove、网址写全、`[ ]` 完全匹配、`" "` 词组匹配）：
 *   https://support.google.com/google-ads/answer/10702623?hl=en
 *
 * 每一列带 `verified`：为真的是在官方模板或帮助页上逐字看到的；为假的是**按同一套
 * 命名推的**（广告组 / 广告 / 关键词那三张官方模板没下载核对），上真站前要先对一遍
 * （报告「没核实到」一节）。改列名只改这一处。
 */

export interface GoogleColumn {
  header: string
  verified: boolean
}

const v = (header: string): GoogleColumn => ({ header, verified: true })
const guess = (header: string): GoogleColumn => ({ header, verified: false })

/** 列 id → 官方表头。 */
export const GOOGLE_BULK_COLUMNS = {
  // 广告系列（官方「Create New Campaign(s)」模板逐字）
  action: v('Action'),
  campaign_status: v('Campaign status'),
  customer_id: v('Customer ID'),
  campaign: v('Campaign'),
  campaign_type: v('Campaign type'),
  networks: v('Networks'),
  budget: v('Budget'),
  budget_type: v('Budget type'),
  bid_strategy_type: v('Bid strategy type'),
  campaign_start_date: v('Campaign start date'),
  campaign_end_date: v('Campaign end date'),
  language: v('Language'),
  location: v('Location'),
  // 格式页上写着「Campaign 与 Campaign ID 都是必填」
  campaign_id: v('Campaign ID'),
  // 格式页：关键词用 Keyword 与 Ad group 两列
  ad_group: v('Ad group'),
  keyword: v('Keyword'),
  final_url: v('Final URL'),
  // 以下按同一套命名推的，没在官方页面上逐字看到
  ad_group_id: guess('Ad group ID'),
  ad_group_status: guess('Ad group status'),
  max_cpc: guess('Max CPC'),
  ad_id: guess('Ad ID'),
  ad_status: guess('Ad status'),
  ad_type: guess('Ad type'),
  keyword_status: guess('Keyword status'),
  path1: guess('Path 1'),
  path2: guess('Path 2'),
} as const satisfies Record<string, GoogleColumn>

export type GoogleColumnId = keyof typeof GOOGLE_BULK_COLUMNS

/** 自适应搜索广告的标题 / 描述列（`Headline 1`…`Headline 15`、`Description 1`…`Description 4`）。 */
export const headlineHeader = (n: number): string => `Headline ${n}`
export const descriptionHeader = (n: number): string => `Description ${n}`

/** 官方模板里 Action 列的三个值。 */
export const GOOGLE_ACTION = { add: 'Add', edit: 'Edit', remove: 'Remove' } as const
/** 官方模板里状态列的三个值。 */
export const GOOGLE_STATUS = { enabled: 'Enabled', paused: 'Paused', removed: 'Removed' } as const

/** 每张表在后台哪里传（docs/101 §2.1，[上传表格并应用更改](https://support.google.com/google-ads/answer/10702433?hl=en)）。 */
export const GOOGLE_UPLOAD_FROM = {
  campaigns: '「广告系列」表右上角三点菜单 → 上传',
  ad_groups: '「广告组」表右上角三点菜单 → 上传',
  ads: '「广告」表右上角三点菜单 → 上传',
  keywords: '「关键词」表右上角三点菜单 → 上传',
} as const

/**
 * Google Ads Editor 的列名对照（决策 561：Editor 不是默认路线，但会用的人可以拿表自己导入）。
 *
 * 出处：[Editor · CSV 文件列](https://support.google.com/google-ads/editor/answer/57747?hl=en)。
 * Editor 认表头时**不分大小写、不管空格**，表头要英文。两处和网页版不一样：
 * 状态列分三种（Campaign Status / Ad Group Status / Status），
 * 匹配方式单独一列（Criterion Type：Broad / Phrase / Exact），关键词不带括号引号。
 */
export const GOOGLE_EDITOR_COLUMN_MAP: readonly {
  bulk: string
  editor: string
  note?: string
}[] = [
  { bulk: 'Customer ID', editor: 'Account ID', note: 'Editor 一次只开一个账户，通常不用这一列' },
  { bulk: 'Campaign', editor: 'Campaign' },
  { bulk: 'Campaign ID', editor: 'Campaign ID' },
  { bulk: 'Campaign type', editor: 'Campaign Type' },
  { bulk: 'Networks', editor: 'Networks' },
  { bulk: 'Budget', editor: 'Budget', note: 'Editor 里也叫 Campaign daily budget，必须大于 0' },
  { bulk: 'Budget type', editor: 'Budget period', note: '对照是推的，没核实' },
  { bulk: 'Bid strategy type', editor: 'Bid Strategy Type' },
  { bulk: 'Language', editor: 'Languages' },
  { bulk: 'Location', editor: 'Location' },
  { bulk: 'Campaign status', editor: 'Campaign Status', note: 'Enabled / Paused / Removed' },
  { bulk: 'Ad group', editor: 'Ad Group' },
  { bulk: 'Ad group status', editor: 'Ad Group Status' },
  { bulk: 'Max CPC', editor: 'Max CPC' },
  {
    bulk: 'Keyword',
    editor: 'Keyword',
    note: 'Editor 里不带 [ ] 和 " "，匹配方式写在 Criterion Type',
  },
  { bulk: '（关键词里的 [ ] / " "）', editor: 'Criterion Type', note: 'Broad / Phrase / Exact' },
  { bulk: 'Keyword status', editor: 'Status' },
  { bulk: 'Ad status', editor: 'Status' },
  { bulk: 'Final URL', editor: 'Final URL' },
  { bulk: 'Path 1', editor: 'Path 1' },
  { bulk: 'Path 2', editor: 'Path 2' },
  { bulk: 'Headline 1…15', editor: 'Headline 1…15' },
  { bulk: 'Description 1…4', editor: 'Description 1…4' },
  {
    bulk: 'Action',
    editor: '（没有）',
    note: 'Editor 按 #Original 列认「改已有」，没有 Action 列',
  },
]
