/**
 * Google 广告「批量上传」的列名（docs/101 §2.1）。**全仓只有这一份**。
 *
 * 出处（四份官方模板都从 [模板和示例](https://support.google.com/google-ads/answer/10702525?hl=en)
 * 链出，实际是 .xlsx；表头逐字照抄，10-14 核对）：
 * - 「Create New Campaign(s)」→ 广告系列表。
 * - 「Create Ad Group(s)」→ 广告组表：Action / Customer ID / Campaign / Campaign ID / Ad group /
 *   **Status**（广告组的状态列就叫 Status，取值 Enabled / Paused，留空默认 Enabled）/ Ad group type。
 * - 「Create Responsive Search Ad(s)」→ 广告表：Action / **Ad status** / Customer ID / Campaign ID /
 *   Campaign / Ad group / Ad group ID / Ad type（`Responsive search ad`）/ Headline 1–15 /
 *   **Description**（第一条没有序号）/ Description 2–4 / Headline N position / Final URL / Mobile final URL。
 * - 「Add Keyword(s)」→ 关键词表：Action / **Keyword status**（Enabled / Removed / Paused）/ Account /
 *   Customer ID / Campaign ID / Campaign / Ad group ID / Ad group / Keyword ID / Keyword /
 *   **Match Type**（示例值 `Exact Match`）/ Default max. CPC / Final URL …
 * - 格式规则（状态列留空 = 启用、要删写 Remove、网址写全、Campaign 与 Campaign ID 必填）：
 *   https://support.google.com/google-ads/answer/10702623?hl=en
 *
 * 每一列带 `verified`：为真的是在上面四份模板或帮助页上逐字看到的；为假的还没看到
 * （见各行注释），上真站前要先对一遍。改列名只改这一处。
 */

export interface GoogleColumn {
  header: string
  verified: boolean
}

const v = (header: string): GoogleColumn => ({ header, verified: true })
const guess = (header: string): GoogleColumn => ({ header, verified: false })

/** 列 id → 官方表头。 */
export const GOOGLE_BULK_COLUMNS = {
  // 广告系列（「Create New Campaign(s)」模板）
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
  // 广告组 / 广告 / 关键词三份模板里都有
  campaign_id: v('Campaign ID'),
  ad_group: v('Ad group'),
  ad_group_id: v('Ad group ID'),
  final_url: v('Final URL'),
  // 广告组（「Create Ad Group(s)」模板）：状态列就叫 Status
  ad_group_status: v('Status'),
  // 广告（「Create Responsive Search Ad(s)」模板）
  ad_status: v('Ad status'),
  ad_type: v('Ad type'),
  // 关键词（「Add Keyword(s)」模板）
  keyword_status: v('Keyword status'),
  keyword_id: v('Keyword ID'),
  keyword: v('Keyword'),
  match_type: v('Match Type'),
  // 关键词模板里有；广告组模板里**没有**这一列，广告组上写出价时用的是同名列（没核实）
  max_cpc: v('Default max. CPC'),
  // 还没在模板里看到：改单条广告状态要的广告编号；显示路径（广告模板表头在
  // 「Headline N position」之后的部分我们拿到的摘录被截断了）
  ad_id: guess('Ad ID'),
  path1: guess('Path 1'),
  path2: guess('Path 2'),
} as const satisfies Record<string, GoogleColumn>

export type GoogleColumnId = keyof typeof GOOGLE_BULK_COLUMNS

/** 自适应搜索广告的标题列（`Headline 1`…`Headline 15`）。 */
export const headlineHeader = (n: number): string => `Headline ${n}`
/** 描述列：官方模板第一条叫 `Description`（没有序号），之后是 `Description 2`…`Description 4`。 */
export const descriptionHeader = (n: number): string =>
  n === 1 ? 'Description' : `Description ${n}`

/**
 * 关键词表 Match Type 列的值。官方模板示例只出现了 `Exact Match`；
 * `Phrase Match` / `Broad Match` 按同一写法推的（没核实）。
 */
export const GOOGLE_MATCH_TYPE = {
  exact: 'Exact Match',
  phrase: 'Phrase Match',
  broad: 'Broad Match',
} as const

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
  { bulk: 'Ad group ID', editor: 'Ad Group ID', note: '对照是推的，没核实' },
  { bulk: 'Status（广告组表）', editor: 'Ad Group Status' },
  { bulk: 'Default max. CPC', editor: 'Max CPC' },
  { bulk: 'Keyword', editor: 'Keyword', note: '两边都是纯关键词，不带 [ ] 和 " "' },
  {
    bulk: 'Match Type',
    editor: 'Criterion Type',
    note: '网页版写 Exact Match，Editor 写 Exact（Broad / Phrase 同理）',
  },
  { bulk: 'Keyword status', editor: 'Status' },
  { bulk: 'Ad status', editor: 'Status' },
  { bulk: 'Final URL', editor: 'Final URL' },
  { bulk: 'Path 1', editor: 'Path 1' },
  { bulk: 'Path 2', editor: 'Path 2' },
  { bulk: 'Headline 1…15', editor: 'Headline 1…15' },
  { bulk: 'Description、Description 2…4', editor: 'Description 1…4' },
  {
    bulk: 'Action',
    editor: '（没有）',
    note: 'Editor 按 #Original 列认「改已有」，没有 Action 列',
  },
]
