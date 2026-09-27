/**
 * WP154「内容与搜索」：`dtc.content` 那条职责里 SEO 与 GEO 的几个形状（Luoye 09-26 定：
 * SEO / GEO 不新建职责，并进内容那一条——中小公司里写内容的人就是顺手做 SEO 的人）。
 *
 * 一条纪律贯穿全文件：**不堆数据**。Search Console 每天给几千行，卡上只出六个信号挑出来的
 * 最多 5 件事；其余一律不上卡（文章《how we 47x'd our SEO》那张 `ignore: everything else`）。
 *
 * 数都从结构化行算出来（29 原则 ③），模型一个数都碰不到；判断（哪一件先动、归谁动）
 * 是 `@agentsws/seo-core` 里的纯函数，同输入同输出。**只加不删**。
 */
import type { Iso8601 } from './common.js'
import type { AiPlatform } from './search-data.js'

/* ------------------------------------------------------------------ */
/* Search Console 的一行与六个信号                                        */
/* ------------------------------------------------------------------ */

/**
 * Search Console 的一行：近 7 天、按「查询 × 页面」聚合。
 *
 * `clicks_prev_week` 是上一个 7 天同一对（查询, 页面）的点击——周环比要它；拉不到就不写，
 * **不填 0**（填 0 会被读成"上周没人点"，于是这周的每一次点击都成了暴涨）。
 */
export interface GscRow {
  query: string
  /** 完整 URL（Search Console 给什么就是什么）。 */
  page: string
  clicks: number
  impressions: number
  /** 0–1 的小数（0.005 = 0.5%）。 */
  ctr: number
  /** 平均排名，1 起算。 */
  position: number
  clicks_prev_week?: number
}

/**
 * 文章里那六个信号（只算这六个，其余一律不上卡）。
 *
 * - `almost_there`：排名 3–20 的**非品牌**词——Google 已经觉得你还行，只是不确定；
 * - `no_clicks`：曝光 > 500 且点击率 < 0.5%——被看见了但没人点；
 * - `decaying`：点击周环比降 30% 以上；
 * - `untargeted`：有排名但**没有一页专门写它**；
 * - `wrong_intent`：搜索意图与页面类型不符（问"对比"落在一篇随笔上）；
 * - `ai_mode`：7 个词以上的长尾——人在像问 ChatGPT 那样问 Google。
 */
export type SeoSignalId =
  | 'almost_there'
  | 'no_clicks'
  | 'decaying'
  | 'untargeted'
  | 'wrong_intent'
  | 'ai_mode'

export const SEO_SIGNALS: readonly SeoSignalId[] = [
  'almost_there',
  'no_clicks',
  'decaying',
  'untargeted',
  'wrong_intent',
  'ai_mode',
]

/** 搜索意图 / 页面类型（两边用同一套词，才比得了"对不对得上"）。 */
export type SearchIntent =
  | 'informational'
  | 'comparison'
  | 'pricing'
  | 'transactional'
  | 'navigational'

/** 店里的一页（文章 / 独立页 / 商品 / 集合）。判断"有没有专门的页""页面类型对不对"要它。 */
export interface SitePage {
  url: string
  kind: 'article' | 'page' | 'product' | 'collection' | 'home' | 'other'
  title?: string
  /** 这页专门写的是哪几个词（人或 Agent 登记的；没有就按标题粗配）。 */
  target_queries?: string[]
  /** 页面的意图类型；不给就按 `kind` 推（文章 = 信息、商品 = 交易）。 */
  intent?: SearchIntent
  /**
   * 收录与规范网址的状况（Search Console 的「网址检查」）。拉不到就不写——
   * **不写 ≠ 没问题**，只是这一格我们不知道。
   */
  index_status?: 'indexed' | 'not_indexed' | 'redirect' | 'canonical_mismatch'
}

/* ------------------------------------------------------------------ */
/* 每天那张「今天值得动的 5 件事」                                         */
/* ------------------------------------------------------------------ */

/**
 * 一件事往哪条车道走（WP154 §3 动作分流）：
 *
 * - `fix_page`：改现有页面（元信息 / 开头 / 小节 / 内链）→ 本职责出改动卡；
 * - `new_page`：需要一页新的 → 先看一次 SERP 排前面的是不是对的人群，是才出「新页面选题」卡；
 * - `site_handoff`：跳转 / 规范网址 / 没被收录 → 交给「建站」岗位（开一件事项 + 说明）；
 * - `pr_handoff`：需要站外被提及 → 交给「公关」岗位（Reddit / 论坛 / 新闻稿）。
 */
export type SeoLane = 'fix_page' | 'new_page' | 'site_handoff' | 'pr_handoff'

/** 本职责自己动的那几种改法（每一种对应一条 `ChangeKind`）。 */
export type SeoFixKind = 'page_seo_edit' | 'page_section_add' | 'internal_link_edit'

/** 证据数字：卡上写的每个数都在这里，一个不经模型手。 */
export interface SeoEvidence {
  clicks: number
  impressions: number
  ctr: number
  position: number
  clicks_prev_week?: number
  /** 周环比（%，负数 = 降）；没有上周数就不写。 */
  wow_pct?: number
  /** 这个查询有几个词（`ai_mode` 看它）。 */
  words: number
}

/** 新页面选题之前看的那一眼 SERP（WP155 接了才有）。 */
export interface SeoSerpCheck {
  /** `true` = 排前面的是我们要的人（商店 / 评测 / 论坛），可以写；`false` = 人群不对，这个词不写。 */
  right_crowd: boolean
  /** 一句人话：看到了什么。 */
  reason: string
  top_domains: string[]
  fetched_at: Iso8601
  source: string
  /** WP166：在哪个市场看的（ISO 国家码，大写）。只探一个市场时也写。 */
  market?: string
}

export interface SeoPick {
  /** 1 起算，就是卡上的顺序（先修再写）。 */
  rank: number
  signal: SeoSignalId
  query: string
  /** 现有页面（没有专门页面的 `untargeted` 也可能有一页"顺带排上"的）。 */
  page?: string
  evidence: SeoEvidence
  lane: SeoLane
  /** `fix_page` 那条车道的具体改法。 */
  fix?: SeoFixKind
  /** `internal_link_edit`：从哪一页链过来（这批数据里点击最多的那一页；改的是它）。 */
  link_from?: string
  /** 建议动作（一句人话，模板生成，不经模型）。 */
  suggestion: string
  /** `new_page` 车道：SERP 看过的结论（没接搜索数据接口就没有，`serp_skipped` 说为什么）。 */
  serp_check?: SeoSerpCheck
  serp_skipped?: string
  /**
   * WP166：好几个目标市场时每个市场各看一眼的结论（`serp_check` 是其中人群对的那一个）。
   * 只有一个市场时不写。
   */
  serp_markets?: SeoSerpCheck[]
  /** 这一件落成了什么：改动卡 / 选题卡 / 事项（服务端回填）。 */
  outcome?: {
    kind: 'change' | 'topic' | 'matter' | 'dropped' | 'none'
    id?: string
    note?: string
    /**
     * WP159：改动卡里的文字是谁写的初稿——`model`（模型按品牌口吻写）/ `rules`（规则版兜底：
     * 模型没配、超出每天上限、超预算、回文不合规矩时）。不是改文字的那几件不写。
     */
    draft?: 'model' | 'rules'
    /**
     * WP166：模型写初稿前读到这一页正文没有——`store`（店铺连接的只读口）/ `web`（公开网址）/
     * `none`（没读到，卡上注明）。规则版不写。
     */
    body?: 'store' | 'web' | 'none'
  }
}

/** `seo_report` 卡 `variant: 'daily'` 的 payload。 */
export interface SeoDailyPayload {
  variant: 'daily'
  date: string
  /** Search Console 没连 = 没有 picks，卡上明说「接上才看得到」。 */
  gsc: 'connected' | 'not_connected'
  search_data: 'configured' | 'not_configured'
  picks: SeoPick[]
  /** 每个信号今天命中几条（只报数，不列行——列行就是数据倾倒）。 */
  signal_counts: Record<SeoSignalId, number>
  /** 人话备注：「搜索数据接口还没接」「Search Console 还没连，接上才看得到」…… */
  notes: string[]
  /**
   * WP159：今天的改动卡初稿，模型写了几份、规则版兜底几份、每天上限几份（服务端回填；
   * 这一轮没有要改文字的就不写）。
   */
  drafts?: { model: number; rules: number; cap: number }
}

/* ------------------------------------------------------------------ */
/* 收入归因（文章第三步：点击之后看转化）                                  */
/* ------------------------------------------------------------------ */

/**
 * 按页面并排「点击 / 订单 / 收入」。订单归到落地页靠 Shopify 的 `landing_site`
 * （没接 GA4 也算得出）；接了 GA4 再补 `conversion_rate`。
 *
 * - `leak`：点击多但没订单（看着像赢，其实是漏）；
 * - `gem`：点击少但出订单（照这个再写三篇）。
 */
export interface PageRevenueRow {
  page: string
  clicks: number
  orders: number
  revenue: number
  currency: string
  /** GA4 的落地页转化率（0–1）；没接 GA4 就没有这一格。 */
  conversion_rate?: number
  flag?: 'leak' | 'gem'
  /**
   * WP158：GA4 口径（只算自然搜索来的会话）的会话数、购买数、购买收入（币种按 GA4 媒体资源）。
   * **并排口径**：`orders` / `revenue` 仍是 Shopify `landing_site` 那条主口径，两边对不上是常态。
   */
  ga4_sessions?: number
  ga4_purchases?: number
  ga4_revenue?: number
}

/** `seo_report` 卡 `variant: 'weekly_revenue'` 的 payload。 */
export interface SeoWeeklyRevenuePayload {
  variant: 'weekly_revenue'
  week_of: string
  rows: PageRevenueRow[]
  /** 归不上任何页面的订单数（照实报，不猜给谁）。 */
  unmatched_orders: number
  ga4: 'connected' | 'not_connected'
  notes: string[]
}

/* ------------------------------------------------------------------ */
/* GEO：各 AI 平台怎么回答买家会问的问题                                   */
/* ------------------------------------------------------------------ */

/** 一个买家会问的问题（自动生成，人可在面板里改）。 */
export interface GeoQuestion {
  id: string
  text: string
  /** 从哪来：品牌档案 / 排名前列的查询 / 人加的。 */
  origin: 'brand' | 'top_query' | 'human'
  enabled: boolean
}

/** 一个问题在一个平台上的结果（从 `AiAnswerResult` 投影来，只留判断要的几格）。 */
export interface GeoProbeRow {
  question: string
  platform: AiPlatform
  /** WP166：在哪个市场问的（ISO 国家码，大写）。 */
  market?: string
  /** WP169：用什么语言问的（ISO 639-1）。 */
  language?: string
  /** WP169：真问出去的那句（翻成市场语言时才有；`question` 仍是品牌语言的原句）。 */
  asked?: string
  brand_mentioned: boolean
  our_domain_cited: boolean
  cited_domains: string[]
  competitors_mentioned: string[]
}

/** 缺位的那一格给的建议：改哪页 / 交公关。 */
export interface GeoGap {
  question: string
  platforms: AiPlatform[]
  /** WP166：哪个市场缺位（每个市场分开算，不混在一起）。 */
  market?: string
  /** `fix_page` = 我们有相关页面但没被引用 → 改那页；`pr_handoff` = 引用的都是站外 → 交公关。 */
  lane: 'fix_page' | 'pr_handoff'
  page?: string
  cited_domains: string[]
  competitors: string[]
  suggestion: string
}

/** `seo_report` 卡 `variant: 'weekly_geo'` 的 payload。 */
export interface SeoWeeklyGeoPayload {
  variant: 'weekly_geo'
  week_of: string
  search_data: 'configured' | 'not_configured'
  questions: number
  rows: GeoProbeRow[]
  gaps: GeoGap[]
  notes: string[]
  /** 这一轮大概花了多少（官方数据接口按积分；自带 key 不扣积分）。 */
  estimate?: GeoCostEstimate
  /** WP166：每个市场各自的可见度（按市场分开算，不混在一起）。 */
  markets?: GeoMarketSummary[]
}

/** WP166：一个市场这一周的 AI 可见度小结。 */
export interface GeoMarketSummary {
  /** ISO 国家码（大写）。 */
  market: string
  /** 这个市场问了几个问题。 */
  questions: number
  /** 其中几个在某个平台上提到或引用了我们。 */
  seen: number
  /** 这个市场缺位几个。 */
  gaps: number
  /** WP169：这个市场用什么语言问的（ISO 639-1）。 */
  language?: string
  /**
   * WP169：市场语言与品牌语言不同、却没能翻译（没配模型）时为 `true`——这一周按原语言问的，
   * 面板上注明。
   */
  untranslated?: boolean
}

/**
 * 每周 AI 探测的开关与问几个（面板上可改）。WP155 提醒：探测按「每个问题 × 每个平台一次」
 * 计费，10 个问题 × 4 个平台一周约 16 积分——所以要让人看得到、调得动、关得掉。
 */
export interface GeoSettings {
  enabled: boolean
  /** 每周最多问几个（1–10）。 */
  max_questions: number
  /**
   * WP166：在面板上关掉探测的市场（ISO 国家码，大写）。只关探测（SERP 与 AI 问答都不查这几个），
   * **不改**公司档案里的目标市场。没写 = 每个目标市场都探。
   */
  markets_off?: string[]
}

/** 每周大概花多少：问几个 × 几个平台 × 单价（官方那条路才有积分数）。 */
export interface GeoCostEstimate {
  questions: number
  platforms: number
  route: 'official' | 'byo' | 'none'
  /** 官方数据接口：积分 / 周；自带 key 是 0；没接就不写。 */
  credits_per_week?: number
  /** WP166：探几个市场（花费 = 问题 × 平台 × 市场 × 单价）。老数据没有 = 1 个。 */
  markets?: number
  /** WP166：探的是哪几个市场（ISO 国家码，大写）。 */
  market_codes?: string[]
}

export type SeoReportPayload = SeoDailyPayload | SeoWeeklyRevenuePayload | SeoWeeklyGeoPayload

/** `seo_topic` 卡（新页面选题）的 payload。 */
export interface SeoTopicPayload {
  query: string
  /** 现在排上的那一页（写好后从它链过去）。 */
  ranking_page?: string
  evidence: SeoEvidence
  /** 为什么要新写一页（模板生成的那句建议）。 */
  why: string
  serp: SeoSerpCheck
  /** 批了之后开的那件事项（服务端回填）。 */
  matter_id?: string
}

/* ------------------------------------------------------------------ */
/* 发布前的内容质检门禁                                                   */
/* ------------------------------------------------------------------ */

/**
 * 一条违规宣称规则（规则表放知识库，人可改）：知识库里 `subject.type === 'content_rule'`
 * 的事实卡，`structured` 就是这个形状。
 */
export interface ContentClaimRule {
  id: string
  /** 子串匹配（不区分大小写）；`regex: true` 时按正则。 */
  pattern: string
  regex?: boolean
  /**
   * WP159 加了五类（只加）：`green` 环保宣称、`origin` 产地（Made in …）、`endorsement` 评价与代言、
   * `comparison` 与竞品比较、`performance` 性能 / 寿命 / 效果。
   */
  category:
    | 'absolute'
    | 'medical'
    | 'other'
    | 'green'
    | 'origin'
    | 'endorsement'
    | 'comparison'
    | 'performance'
  /** 给人看的理由（一句人话）。 */
  reason: string
  /** WP159：属于哪个市场组（`global` / `us` / `eu_uk` / `ca` / `au`；自己加的规则可以不写 = 通用）。 */
  market?: ClaimMarketGroup
  /** WP159：出处（官方指南）的标题与链接。 */
  source_title?: string
  source_url?: string
  /** WP159：`regex` 规则给人看的写法（「eco-friendly、environmentally friendly…」），界面不露正则。 */
  label?: string
}

/**
 * WP159：违规宣称规则按市场分组。`global` 永远启用（绝对化用语、医疗功效）；其余按品牌档案里的
 * 目标市场启用（美国 → `us`；欧盟国家与英国 → `eu_uk`；加拿大 → `ca`；澳大利亚 → `au`）。
 */
export type ClaimMarketGroup = 'global' | 'us' | 'eu_uk' | 'ca' | 'au'

/** WP159：知识库「违规宣称规则」那张表的一行（带开关与来路）。 */
export interface ClaimRuleRow extends ContentClaimRule {
  market: ClaimMarketGroup
  enabled: boolean
  /** `builtin` 自带没动过 / `edited` 自带但人改过或关过 / `custom` 人自己加的。 */
  origin: 'builtin' | 'edited' | 'custom'
}

/** WP159：一个市场组（标题、开没开、为什么开）。 */
export interface ClaimMarketGroupView {
  id: ClaimMarketGroup
  label: string
  enabled: boolean
  /** `always` 通用组 / `market` 按目标市场自动开关 / `manual` 人在知识库里拨过。 */
  why: 'always' | 'market' | 'manual'
}

/** WP159：知识库里那张「违规宣称规则」表（`GET /v1/knowledge/claim-rules`）。 */
export interface ClaimRulesView {
  /** 品牌档案里的目标市场（ISO 国家码）；档案里没写就是按默认国家算的那一个。 */
  markets: string[]
  markets_from: 'brand_profile' | 'default'
  groups: ClaimMarketGroupView[]
  rules: ClaimRuleRow[]
}

export interface ContentQualityIssue {
  /**
   * - `unsourced_figure`：这个数字在知识库里找不到出处；
   * - `banned_claim`：命中违规宣称规则；
   * - `fact_mismatch`：说法与知识库里那一条对不上（价格、保修月数……）。
   */
  rule: 'unsourced_figure' | 'banned_claim' | 'fact_mismatch'
  /** 有问题的那一句原文。 */
  sentence: string
  /** 一句人话：哪里不对。 */
  detail: string
}

export interface ContentQualityResult {
  passed: boolean
  issues: ContentQualityIssue[]
  checked_at: Iso8601
  /** 规则从哪来：知识库里的那一份，还是知识库里还没有时的默认表。 */
  rules_from: 'knowledge' | 'default'
}
