/**
 * Meta「批量导入广告」表的列名（docs/101 §3.1）。**全仓只有这一份**。
 *
 * 出处（2026-10-14 读，英文美国版页面）：
 * - [导入 / 导出模板里的列](https://www.facebook.com/business/help/1471948569691450)：
 *   广告 / 广告组 / 广告系列三层的列名逐字照抄（下面 `META_TEMPLATE_COLUMNS` 的顺序也照它）。
 * - [后台字段名与表格列名对照](https://www.facebook.com/business/help/1462433740708893)：
 *   正文叫 Body、标题叫 Title、主页写成 `o:主页编号`、行动号召的取值。
 * - [导出广告](https://www.facebook.com/business/help/849477685213347)：
 *   以 `+ - = @` 开头的值导出时前面加 `< >`，导入时自动去掉。
 * - [用 Excel 新建广告](https://www.facebook.com/business/help/257638938498557)：
 *   新建要把编号列留空；新系列连「Campaign ID」也留空。
 * - [模板导入排错](https://www.facebook.com/business/help/216243691909235)：
 *   别删模板里的列；可以存成 Unicode .txt 再导入。
 *
 * 帮助页的列表**不全**：「Call to Action」只在对照页出现、状态取值
 * （ACTIVE / PAUSED）官方页没写。这两处标 `verified: false`。
 */

export interface MetaColumn {
  header: string
  level: 'campaign' | 'ad_set' | 'ad'
  verified: boolean
}

const c = (header: string, verified = true): MetaColumn => ({ header, level: 'campaign', verified })
const s = (header: string, verified = true): MetaColumn => ({ header, level: 'ad_set', verified })
const a = (header: string, verified = true): MetaColumn => ({ header, level: 'ad', verified })

/** 列 id → 官方表头。 */
export const META_COLUMNS = {
  campaign_id: c('Campaign ID'),
  campaign_name: c('Campaign Name'),
  campaign_status: c('Campaign Status'),
  campaign_objective: c('Campaign Objective'),
  buying_type: c('Buying Type'),
  campaign_spend_limit: c('Campaign Spend Limit'),
  ad_set_id: s('Ad Set ID'),
  ad_set_name: s('Ad Set Name'),
  ad_set_status: s('Ad Set Status'),
  ad_set_daily_budget: s('Ad Set Daily Budget'),
  ad_set_lifetime_budget: s('Ad Set Lifetime Budget'),
  ad_set_time_start: s('Ad Set Time Start'),
  link_object_id: s('Link Object ID'),
  countries: s('Countries'),
  age_min: s('Age Min'),
  age_max: s('Age Max'),
  optimization_goal: s('Optimization Goal'),
  billing_event: s('Billing Event'),
  bid_amount: s('Bid Amount'),
  ad_id: a('Ad ID'),
  ad_name: a('Ad Name'),
  ad_status: a('Ad Status'),
  creative_type: a('Creative Type'),
  title: a('Title'),
  body: a('Body'),
  link: a('Link'),
  link_description: a('Link Description'),
  display_link: a('Display Link'),
  image: a('Image'),
  image_hash: a('Image Hash'),
  story_id: a('Story ID'),
  url_tags: a('URL Tags'),
  call_to_action: a('Call to Action', false),
} as const satisfies Record<string, MetaColumn>

export type MetaColumnId = keyof typeof META_COLUMNS

/** 生成的表按这个顺序出列（广告系列 → 广告组 → 广告）。 */
export const META_COLUMN_ORDER: readonly MetaColumnId[] = Object.keys(
  META_COLUMNS,
) as MetaColumnId[]

/** 状态值（官方帮助页没写取值，这是导出文件里常见的写法，没核实）。 */
export const META_STATUS = { active: 'ACTIVE', paused: 'PAUSED' } as const

/** 行动号召（官方对照页列出的取值）。 */
export const META_CALL_TO_ACTIONS = [
  'BOOK_TRAVEL',
  'DOWNLOAD',
  'LEARN_MORE',
  'SEE_DETAILS',
  'SHOP_NOW',
  'SIGN_UP',
  'WATCH_MORE',
] as const

/** 导入文件大约 2MB 封顶（docs/101 §3.1，[批量上传和导入广告](https://www.facebook.com/business/help/122918328469908)）。 */
export const META_IMPORT_MAX_BYTES = 2 * 1024 * 1024

export const META_UPLOAD_FROM =
  '广告管理工具「广告系列 / 广告组 / 广告」标签 → 更多 → 批量导入广告（可上传 Excel，或选「复制粘贴」贴文字）→ 导入后点「审核并发布」'

/** 导出时加在 `+ - = @` 开头的值前面的那个前缀（官方：不是错误，别删，导入时自动去掉）。 */
export const META_FORMULA_PREFIX = '< >'
