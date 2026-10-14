/**
 * 广告上传表的公共形状（docs/101 §5.1②、§5.4 WP314；决策 552 / 553）。
 *
 * **WP313（插件动作通道）与 WP317（素材流水线）对接的就是这个文件**：
 * 上游只描述「要改什么」（{@link AdSheetOp}），本包负责把它翻成两家后台认得的表，
 * 在本地先查一遍，再给审批卡一句白话和一张预览。
 *
 * 三条纪律：
 *
 * 1. **新建一律写成已暂停**（决策 553）。Google 新建行的状态列留空 = 启用，
 *    所以生成器在每一行新建上都把状态写死，调用方没有口子改成启用。
 *    「开始投放」是另一张 L1 卡，用 {@link AdUploadBundle.activation_ops} 出。
 * 2. **平台无关的意图，平台相关的列**。一个 op 同时带 Google 与 Meta 用得上的格子，
 *    哪家用不上的就不写；该有没给的由校验报出来（不静默补一个编出来的值）。
 * 3. **只描述，不执行**。这里没有一处 IO：上传、截屏、点「应用 / 发布」都是插件的事，
 *    而且只在审批卡批了之后。
 */

/** 上传表只做这两家（docs/101 第一期）。 */
export type SheetPlatform = 'google' | 'meta'

/** 层级。Meta 的「广告组」叫 Ad Set，这里统一叫 `ad_group`。 */
export type AdEntityLevel = 'campaign' | 'ad_group' | 'ad' | 'keyword'

/** 关键词匹配方式。Google 批量上传里用 `[ ]` 表示完全匹配、`" "` 表示词组匹配。 */
export type KeywordMatch = 'broad' | 'phrase' | 'exact'

/** 指到一个已有（或本批新建）的对象。名字必给；改已有对象时编号也要给。 */
export interface AdEntityRef {
  campaign: string
  campaign_id?: string
  ad_group?: string
  ad_group_id?: string
  /** Meta 的广告名（Google 的广告没有名字，只认编号）。 */
  ad?: string
  ad_id?: string
  /** Google 关键词正文（不带匹配符号）。 */
  keyword?: string
  match?: KeywordMatch
}

/** 新建广告系列。 */
export interface CreateCampaignOp {
  kind: 'create_campaign'
  campaign: string
  /** Google：日预算（必填，> 0）。Meta 的预算在广告组上，这里给了会报错。 */
  daily_budget?: number
  google?: {
    /** 官方模板「新建」只支持 Search / Display / Video。默认 Search。 */
    campaign_type?: 'Search' | 'Display' | 'Video'
    /** 例：`['Google search']`。官方可选值见模板注释。 */
    networks?: readonly string[]
    /** 例：`Manual CPC`、`Maximize clicks`。新建时必填，默认 `Manual CPC`。 */
    bid_strategy_type?: string
    /** `YYYY-MM-DD`（官方模板示例 2024-02-29）。 */
    start_date?: string
    end_date?: string
    /** 语言代码，例 `en`、`zh_tw`。 */
    languages?: readonly string[]
    /** 地点，照官方写法，例 `Seattle, Washington, United States`。 */
    locations?: readonly string[]
    /** 经理账户上传多个账户时才要（`123-456-7890`）。 */
    customer_id?: string
  }
  meta?: {
    /** Campaign Objective，例 `OUTCOME_SALES`、`OUTCOME_TRAFFIC`。新建必填。 */
    objective?: string
    /** Buying Type，默认 `AUCTION`。 */
    buying_type?: string
  }
}

/** 新建广告组（Meta：广告组 = Ad Set）。 */
export interface CreateAdGroupOp {
  kind: 'create_ad_group'
  campaign: string
  campaign_id?: string
  ad_group: string
  google?: { max_cpc?: number }
  meta?: {
    /** Meta 的预算写在这一层：日预算或总预算二选一。 */
    daily_budget?: number
    lifetime_budget?: number
    /** Ad Set Time Start，原样写入。 */
    start_time?: string
    /** 两位国家代码，例 `US`、`GB`。 */
    countries?: readonly string[]
    age_min?: number
    age_max?: number
    /** Optimization Goal，例 `OFFSITE_CONVERSIONS`、`LINK_CLICKS`。 */
    optimization_goal?: string
    /** Billing Event，例 `IMPRESSIONS`。 */
    billing_event?: string
    bid_amount?: number
  }
}

/** Meta「行动号召」可选值（官方字段对照页列出的那几个）。 */
export type MetaCallToAction =
  | 'BOOK_TRAVEL'
  | 'DOWNLOAD'
  | 'LEARN_MORE'
  | 'SEE_DETAILS'
  | 'SHOP_NOW'
  | 'SIGN_UP'
  | 'WATCH_MORE'

/** 新建广告。Google 是自适应搜索广告（RSA），Meta 是单图链接广告。 */
export interface CreateAdOp {
  kind: 'create_ad'
  campaign: string
  campaign_id?: string
  ad_group: string
  ad_group_id?: string
  /** 落地页，必须带 `https://`（Google 官方要求写全）。 */
  final_url: string
  google?: {
    /** 3–15 条，每条 ≤ 30 字符（中日韩字算 2 个）。 */
    headlines: readonly string[]
    /** 2–4 条，每条 ≤ 90 字符。 */
    descriptions: readonly string[]
    /** 显示路径，各 ≤ 15 字符。 */
    path1?: string
    path2?: string
  }
  meta?: {
    /** Ad Name。不给就按「广告组名 · 序号」起。 */
    ad_name?: string
    /** 正文（表里叫 Body）。 */
    body: string
    /** 标题（表里叫 Title）。 */
    title?: string
    link_description?: string
    display_link?: string
    call_to_action?: MetaCallToAction
    /** 主页编号（纯数字；表里写成 `o:编号`）。 */
    page_id: string
    /** 随表一起上传的图片文件名（Image 列）。与 `image_hash` 二选一。 */
    image_file?: string
    /** 已上传图片的哈希（Image Hash 列）。 */
    image_hash?: string
    url_tags?: string
  }
}

/** 加关键词（只有 Google）。 */
export interface AddKeywordOp {
  kind: 'add_keyword'
  campaign: string
  campaign_id?: string
  ad_group: string
  ad_group_id?: string
  text: string
  match: KeywordMatch
  max_cpc?: number
}

/** 改预算（Google：广告系列日预算；Meta：广告组日预算）。 */
export interface SetBudgetOp {
  kind: 'set_budget'
  ref: AdEntityRef
  level: 'campaign' | 'ad_group'
  /** 改前（卡面上「从 ¥200」那个数；也用来算 delta）。 */
  before: number
  after: number
}

/** 暂停 / 启用。启用是「开始投放」，调用方要按 L1 出卡（决策 553）。 */
export interface SetStatusOp {
  kind: 'set_status'
  ref: AdEntityRef
  level: AdEntityLevel
  status: 'paused' | 'enabled'
}

export type AdSheetOp =
  | CreateCampaignOp
  | CreateAdGroupOp
  | CreateAdOp
  | AddKeywordOp
  | SetBudgetOp
  | SetStatusOp

/** 一条校验结论。`error` 拦住不出表；`warning` 照出，但上卡面。 */
export interface SheetProblem {
  severity: 'error' | 'warning'
  /** 机器读的代号（`too_long` / `forbidden_copy` / `budget_over_cap` …）。 */
  code: string
  /** 第几个 op（从 0 起）；整张表的问题没有这一格。 */
  op_index?: number
  field?: string
  /** 一句人话，原样上卡面。 */
  message: string
}

/** 生成表时的上下文（额度、币种、品牌禁用词）。全部可选。 */
export interface SheetContext {
  /** 额度（不给按 docs/57 默认：预算 delta 20%）。 */
  caps?: { max_budget_delta_pct?: number; max_daily_spend?: number }
  /**
   * 这张卡是不是「超额提预算」的 L1 卡（人明确要提这么多）。
   * 不是的话，超额度的预算改动按错误拦下。
   */
  allow_over_cap?: boolean
  /** 今天各平台已经花了多少（给了就按岗位级总闸再判一次）。 */
  spend_today_by_platform?: Readonly<Record<string, number | undefined>>
  /** 卡面上金额前面那个符号，默认 `¥`。 */
  currency_symbol?: string
  /** 品牌禁用词（公司层技能那一份）。 */
  banned_terms?: readonly string[]
  /** Google：经理账户批量传多个账户时的客户编号（`123-456-7890`）。 */
  customer_id?: string
}

/** 一个要上传的文件。 */
export interface AdUploadFile {
  /** 建议文件名（只用 ASCII，插件放进上传框用）。 */
  name: string
  mime: string
  /** CSV / 文字是字符串；Excel 是字节。 */
  content: string | Uint8Array
  /**
   * Google 是按表分开传的（广告系列 / 广告组 / 广告 / 关键词各一张，按这个顺序）；
   * Meta 是平表（每行一条广告，带着它的广告组与广告系列），新建与改已有分两张。
   */
  sheet: 'campaigns' | 'ad_groups' | 'ads' | 'keywords' | 'meta_new' | 'meta_edit' | 'editor'
  /** 在后台哪里上传，一句白话（插件步骤表与帮助文档用）。 */
  upload_from: string
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  /** Meta：同一张表的制表符文字，可直接粘贴进「批量导入广告 → 复制粘贴」框。 */
  paste_text?: string
}

/** 审批卡上表格预览的一行。 */
export interface SheetPreviewRow {
  /** 新建 / 改预算 / 暂停 / 启用 */
  action: '新建' | '改预算' | '暂停' | '启用'
  /** 广告系列 / 广告组 / 广告 / 关键词 */
  level: string
  /** 这一条叫什么（广告系列 › 广告组 › 名字）。 */
  name: string
  before?: string
  after?: string
}

/** 改前 / 改后对比（给审批卡）。 */
export interface SheetSummary {
  /** 一句白话，例「新建 2 个广告组、12 条广告，都先暂停；A 系列预算从 ¥200 改到 ¥230」。 */
  sentence: string
  counts: {
    create: Record<AdEntityLevel, number>
    budget_changes: number
    pause: number
    enable: number
  }
  rows: SheetPreviewRow[]
}

/** 生成结果：WP313 拿去上传，WP316 拿去出卡，WP317 拿去给人下载。 */
export interface AdUploadBundle {
  platform: SheetPlatform
  /** 没有 `error` 级问题。为假时 `files` 为空——**有错的表不出**。 */
  ok: boolean
  problems: SheetProblem[]
  /**
   * Google：1–4 个 CSV，按上传顺序。
   * Meta：新建一张、改已有一张（各一个 .xlsx，带 `paste_text`），**分开导入**——
   * 改已有的那张照官方做法用改前导出的原行改（见 meta.ts 文件头）。
   */
  files: AdUploadFile[]
  summary: SheetSummary
  /** 审批级别：上传表一律 L1（docs/101 §5.3：表里可能夹带新建）。 */
  approval_level: 'L1'
  /** 表的指纹（SHA-256，十六进制）。审批卡与插件执行时都带着它，表被改过就拒绝上传。 */
  fingerprint: string
  /** 本批新建的东西，「开始投放」那张 L1 卡要启用的就是这些（决策 553）。 */
  activation_ops: SetStatusOp[]
}
