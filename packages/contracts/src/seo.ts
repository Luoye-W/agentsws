/**
 * WP154「内容与搜索」：`dtc.seo`「SEO 与 GEO」（WP446 从 `dtc.content` 拆出）那条职责里 SEO 与 GEO 的几个形状（Luoye 09-26 定：
 * SEO / GEO 不新建职责，并进内容那一条——中小公司里写内容的人就是顺手做 SEO 的人）。
 *
 * 一条纪律贯穿全文件：**不堆数据**。Search Console 每天给几千行，卡上只出六个信号挑出来的
 * 最多 5 件事；其余一律不上卡（文章《how we 47x'd our SEO》那张 `ignore: everything else`）。
 *
 * 数都从结构化行算出来（29 原则 ③），模型一个数都碰不到；判断（哪一件先动、归谁动）
 * 是 `@agentsws/seo-core` 里的纯函数，同输入同输出。**只加不删**。
 */
import type { Iso8601 } from './common.js'
import type {
  GeoAnswerInsight,
  GeoConsistencyFinding,
  GeoConsistencyRun,
  GeoFixOwner,
  GeoGapCause,
  GeoOfficialFact,
  GeoQualityView,
  GeoRecheck,
  GeoReportFigure,
  GeoReportSlot,
  GeoSourceMapRow,
} from './geo-quality.js'
import type { AiAnswerVia, AiCitationWhere, AiPlatform, SerpFeatures } from './search-data.js'
import type { AiTrafficSummary } from './site-health.js'

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

/**
 * WP448：卡上一件事的来源——六个信号之一，或每周抢词检测（`cannibalization`，**不算**每日六个信号，
 * `signal_counts` 里也没有它；只有 `merge` 车道那几件是它）。
 */
export type SeoPickSignal = SeoSignalId | 'cannibalization'

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
 * - `pr_handoff`：需要站外被提及 → 交给「公关」岗位（Reddit / 论坛 / 新闻稿）；
 * - `merge`（WP448）：两页抢同一组词 → 定保留哪页，另一页出改动卡（内链指向保留页）或交建站跳转。
 *   只来自每周的抢词检测（严重的那几组），不来自每日六个信号。
 */
export type SeoLane = 'fix_page' | 'new_page' | 'site_handoff' | 'pr_handoff' | 'merge'

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
  /** WP448：`merge` 车道那几件是 `cannibalization`（每周抢词检测），其余都是六个信号之一。 */
  signal: SeoPickSignal
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
  /** WP448：`decaying` 那一件的分诊提示（刷新 / 查询变了 / 该合并 / 该下线），规则判、附证据。 */
  triage?: SeoDecayTriageResult
  /** WP448：`merge` 车道那一组抢词（保留哪页、另一页怎么处理）。 */
  merge?: SeoCannibalizationGroup
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
  /** WP310：进了历史之后**不可改**——改字 = 归档旧的 + 新建一条（历史永远对得上原句）。 */
  text: string
  /** 从哪来：品牌档案 / 排名前列的查询 / 人加的 / WP310 AI 按方向推荐的。 */
  origin: 'brand' | 'top_query' | 'human' | 'ai_suggest'
  enabled: boolean
  /** WP310（决策 463）：哪个方向（品类推荐 / 选购指南 / 和竞品比……）。老数据没有。 */
  topic?: GeoPromptTopic
  /** WP310：Prompt 里带不带我们的品牌名 / 别名（带的与不带的分开看）。 */
  branded?: boolean
  /** WP310（决策 463）：是不是「已选」——持续追踪的那几条（默认 5 条）；没选的是候选。 */
  selected?: boolean
  /** WP310：归档时刻（改字或不要了）；归档的不再问，历史照留。 */
  archived_at?: Iso8601
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
  /** WP380：主要原因（十种之一，规则按手上的信号判）。 */
  cause?: GeoGapCause
  /** WP380：严重度 × 重要度 ÷ 工作量（越大越先做）。 */
  priority?: number
  /** WP380：负责的岗位（岗位模板 id；本职责自己做写 `content`）。 */
  owner?: GeoFixOwner | 'content'
  /** WP380：复查日期（`YYYY-MM-DD`）。 */
  recheck_on?: string
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
  /** WP321：这一轮在历史表里的轮次 id（指标、前后对比都从历史表算）。 */
  run_id?: string
  /** WP321：这一周的几个数（规则算，数不经模型手；覆盖不足 90% 不出变化）。 */
  metrics?: GeoWeekPoint
  /** WP321：排队档还没回来的格数（回来后这张卡按同一周重出）。 */
  pending_cells?: number
  /** WP335：简报那一行（提及率与周变化 · 关注词平均排名与周变化）；这周没拿到回答不写。 */
  brief?: string
  /** WP380：报告里每个数（带来路：实测 / 推算 / 估算，样本量与日期）。 */
  figures?: GeoReportFigure[]
  /** WP380：站外来源地图（被引用的外部来源按市场、类型分，带交给谁）。 */
  source_map?: GeoSourceMapRow[]
  /** WP380：最近一次对外说法一致性检查的几处（没查过不写）。 */
  consistency?: {
    run_id: string
    at: string
    findings: number
    by_owner: { owner: GeoFixOwner; n: number }[]
  }
  /** WP380：复查——这周到期几条、做完几条（各自的建议）。 */
  rechecks?: {
    waiting: number
    done: { id: string; change: string; advice?: string; delta_pp?: number }[]
  }
  /** WP380：给 WP381 留的位置（网站体检 / 商品信息体检 / AI 来源流量）；没有就不显示。 */
  slots?: { site_check?: GeoReportSlot; product_check?: GeoReportSlot; ai_traffic?: GeoReportSlot }
  /**
   * WP381：AI 来源流量（Shopify 自己记的来源，标「实测」），和上面的引用数并排看。
   * 没连店 / 没读到就不写（周报那一格不出）。
   */
  ai_traffic?: AiTrafficSummary
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

export type SeoReportPayload =
  | SeoDailyPayload
  | SeoWeeklyRevenuePayload
  | SeoWeeklyGeoPayload
  | SeoCannibalizationPayload

/* ------------------------------------------------------------------ */
/* WP448（docs/109 §5.1 #3–4）：抢词检测与掉量分诊                         */
/* ------------------------------------------------------------------ */

/**
 * 掉量分诊（`decaying` 那一件的提示）：规则判、附证据数字。
 *
 * - `refresh`：还有需求，内容旧了——刷新内容（加小节、更新日期、请 Google 重新收录）；
 * - `query_shift`：这页丢的那个词掉了，别的词在涨——查询变了，按新的词改标题与开头；
 * - `merge`：同一个词我们另一页在涨——两页在抢，该合并；
 * - `retire`：这页整体已经没什么人搜了——该下线（跳到相关的页）。
 */
export type SeoDecayTriage = 'refresh' | 'query_shift' | 'merge' | 'retire'

export interface SeoDecayTriageResult {
  verdict: SeoDecayTriage
  /** 一句人话（模板生成）。 */
  reason: string
  /** 证据数字（全由规则从 Search Console 行算出来）。 */
  evidence: {
    /** 这一页本周 / 上周的点击合计。 */
    page_clicks: number
    page_clicks_prev?: number
    /** 这一页本周的曝光合计。 */
    page_impressions: number
    /** 这一页本周在涨的词带来的点击增量（`query_shift` 看它）。 */
    gaining_clicks?: number
    /** `merge`：同一个词在涨的那一页。 */
    other_page?: string
    other_page_clicks?: number
  }
}

/**
 * 抢词：同一组查询我们两页以上都有可观曝光、互相顶替。
 *
 * - `critical`：同一个词两页都在前 20、曝光都够——互相顶替最明显；
 * - `high`：同一组词里一页明显压着另一页；
 * - `medium`：只在少量曝光上重叠（只列在周报，不进 5 件事）。
 */
export interface SeoCannibalizationGroup {
  /** 稳定键（查询归一后排序拼起来），去重与「已处理」用。 */
  key: string
  severity: 'critical' | 'high' | 'medium'
  queries: string[]
  /** 两页（或更多）各自在这组词上的数（按点击从多到少）。 */
  pages: { url: string; clicks: number; impressions: number; position: number }[]
  /** 建议保留哪一页（点击多的；并列看排名）。 */
  keep: string
  /** 另一页怎么处理：合并后跳过去 / 改写成别的角度并链到保留页。 */
  action: 'redirect' | 'differentiate'
  /** 一句人话（模板生成）。 */
  suggestion: string
}

/** `seo_report` 卡 `variant: 'weekly_cannibalization'` 的 payload（每周一次，不进每日六个信号）。 */
export interface SeoCannibalizationPayload {
  variant: 'weekly_cannibalization'
  week_of: string
  gsc: 'connected' | 'not_connected'
  groups: SeoCannibalizationGroup[]
  notes: string[]
}

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
  rule:
    | 'unsourced_figure'
    | 'banned_claim'
    | 'fact_mismatch'
    /** WP449：引用页打开了，但页面上找不到那个数 / 那句原话。 */
    | 'citation_not_found'
    /** WP449：引用页打不开（404、被挡、超时、不是公网地址）。 */
    | 'citation_unreachable'
    /** WP449：给某个市场的版本里，货币 / 单位 / 数字写法 / 日期 / 称呼不对。 */
    | 'locale_mismatch'
    /** WP449：对比竞品的那句没有出处（指不回事实卡，也没链到公开可核的页面）。 */
    | 'comparison_unsourced'
    /** WP449：对比竞品时用了贬低的词。 */
    | 'comparison_disparaging'
  /** 有问题的那一句原文。 */
  sentence: string
  /** 一句人话：哪里不对。 */
  detail: string
  /** WP449：引用核查那两条——查的是哪个网址。 */
  url?: string
}

/** WP449：引用核查这一轮的小结（每篇有上限，超了只查前几个并注明）。 */
export interface ContentCitationSummary {
  /** 正文里带外链的说法，一共链到几个不同的网址。 */
  links: number
  /** 这次真打开查了几个。 */
  checked: number
  /** 超过上限没查的几个（卡上注明）。 */
  skipped: number
  /** 查了、数 / 原话都在页面上的几个。 */
  verified: number
  /** 每篇最多查几个（职责阈值 `citation_check_max_links`）。 */
  max: number
  /** 没查成的原因（例如「这个进程不能抓网页」）；查了就没有这一格。 */
  note?: string
}

/** WP449：「好不好被 AI 引用」的一项（规则算的，不经模型）。 */
export interface AiCitabilityCheck {
  id: 'answer_first' | 'self_contained' | 'entity_clear' | 'figures_sourced' | 'extractable'
  /** 这一项的中文名（卡与面板上）。 */
  label: string
  points: number
  max: number
  /** 一句人话：怎么得的这个分（数了几段、几段合格）。 */
  detail: string
  /** 没拿满时，下一步怎么改（一句）。 */
  hint?: string
}

/** WP449：「好不好被 AI 引用」打分（0–100；只给建议，**不挡发布**）。 */
export interface AiCitabilityScore {
  score: number
  checks: AiCitabilityCheck[]
}

export interface ContentQualityResult {
  passed: boolean
  issues: ContentQualityIssue[]
  checked_at: Iso8601
  /** 规则从哪来：知识库里的那一份，还是知识库里还没有时的默认表。 */
  rules_from: 'knowledge' | 'default'
  /** WP449：引用核查小结（这篇没有带外链的说法就没有这一格）。 */
  citations?: ContentCitationSummary
  /** WP449：「好不好被 AI 引用」——只是建议，不影响 `passed`。 */
  ai_citability?: AiCitabilityScore
  /** WP449：认出来这篇是给哪个市场的版本（语言 + 品牌档案里说这种语言的市场）。 */
  locale?: { language: string; markets: string[] }
  /** WP449：不挡发布的建议（卡上「建议」那几行）。 */
  advice?: string[]
}

/* ------------------------------------------------------------------ */
/* WP310（docs/99 §5.1 / §5.5，O1）：关注设置与回答历史的形状              */
/* ------------------------------------------------------------------ */

/**
 * 决策 463：AI 从这几个**方向**列候选 Prompt（按方向分组展示）。`branded` 是「带品牌名的直接提问」，
 * 其余方向默认不塞品牌名（不带的才是真实买家搜索的样子，默认占多数）。
 */
export type GeoPromptTopic =
  | 'category'
  | 'buying_guide'
  | 'comparison'
  | 'use_case'
  | 'price_value'
  | 'reviews'
  | 'branded'
  | 'other'

/** 方向的展示顺序与中文名（界面分组用）。 */
export const GEO_PROMPT_TOPICS: readonly { id: GeoPromptTopic; label_zh: string }[] = [
  { id: 'category', label_zh: '品类推荐' },
  { id: 'buying_guide', label_zh: '选购指南' },
  { id: 'comparison', label_zh: '和竞品对比' },
  { id: 'use_case', label_zh: '使用场景' },
  { id: 'price_value', label_zh: '价格与性价比' },
  { id: 'reviews', label_zh: '口碑评价' },
  { id: 'branded', label_zh: '带品牌名的直接提问' },
  { id: 'other', label_zh: '其他' },
]

/** 决策 463：已选 Prompt 的档位（默认 5），上限可配（默认 20，最多 {@link GEO_PROMPT_CAP_MAX}）。 */
export const GEO_PROMPT_TIERS: readonly number[] = [5, 10, 20]
export const GEO_PROMPT_DEFAULT_SELECTED = 5
export const GEO_PROMPT_CAP_DEFAULT = 20
export const GEO_PROMPT_CAP_MAX = 50

/** docs/99 §5.1：关注的关键词（SEO 排名用）默认 20 个、上限 100。 */
export const WATCH_KEYWORDS_DEFAULT = 20
export const WATCH_KEYWORDS_MAX = 100

/**
 * WP392（docs/104 C3）：竞品的独立站（竞品监控读它的公开商品目录）。
 * 平台由 AI 读一下店里那两个公开地址探出来（WP393）；探不出 = `unknown`。
 */
export interface BrandWatchStore {
  /** 店铺首页地址（`https://aventon.com`）。 */
  url: string
  platform: 'shopify' | 'woocommerce' | 'other' | 'unknown'
  /** 上次探平台的时刻。 */
  checked_at?: Iso8601
}

/**
 * WP392（docs/104 C3 / C6 / C8）：Amazon 上一款要盯的商品（竞品的对标款，或自家的那一款）。
 * 每家几款不定死，AI 建议、用户确认（C6）。
 */
export interface BrandWatchAmazonItem {
  /** 站点（`US`、`DE`、`JP`…，按 Amazon 站点的国家码）。 */
  marketplace: string
  asin: string
  /** 人话名（`Level 3`）。 */
  label?: string
  /** 对标自家哪一款：自家 ASIN 或独立站商品 handle（C8 比差价用；竞品那边才有）。 */
  vs_own?: string
}

/** 关注设置里的一个竞品（3–5 个）。`id` 稳定，改名不影响历史（历史里存名字快照）。 */
export interface BrandWatchCompetitor {
  id: string
  name: string
  aliases: string[]
  domains: string[]
  /**
   * WP392（docs/104 C3）：这份是 GEO、信息监控、竞品监控三家共用的**唯一工作清单**，竞品监控只在这里加格子。
   * 竞品的独立站（有才盯上新 / 改价 / 打折 / 断货）。
   */
  store?: BrandWatchStore
  /** WP392：竞品在 Amazon 上的对标款。 */
  amazon?: BrandWatchAmazonItem[]
}

/** 关注的一个关键词（决策 465：SEO 排名按关键词；GEO 按 Prompt，是另一件事）。 */
export interface BrandWatchKeyword {
  keyword: string
  /** 品牌词（「品牌名」「品牌名 + 品类」「品牌名 reviews」）。 */
  branded: boolean
  enabled: boolean
}

export type BrandWatchFrequency = 'weekly' | 'biweekly' | 'monthly' | 'manual'

/**
 * WP310（docs/99 §5.1，决策 460–473 含 Luoye 10-14 的改动）：每个品牌一份「关注设置」。
 * 存在品牌目录的 `geo.sqlite`（`watch_settings` + `geo_prompts`）；老的 `seo-state.json`
 * 里的问题清单与开关第一次打开时搬进来（老数据不丢）。
 */
export interface BrandWatch {
  /** 我们：品牌名 + 别名（简称、常见拼错、主推商品名）+ 自家域名。 */
  brand: {
    name: string
    aliases: string[]
    domains: string[]
    /** WP392（docs/104 C8）：自家在 Amazon 上的商品（和竞品对标款比价用；`vs_own` 不填）。 */
    amazon?: BrandWatchAmazonItem[]
  }
  /** 竞品 3–5 个。 */
  competitors: BrandWatchCompetitor[]
  /**
   * 决策 463：候选 Prompt（AI 按方向列的，没选的）与已选 Prompt（持续追踪的，默认 5 条）**分开存**。
   * 两边都不含已归档的。
   */
  prompt_candidates: GeoQuestion[]
  prompts: GeoQuestion[]
  /** 已选几条（档位 5 / 10 / 20；默认 5）。 */
  prompt_limit: number
  /** 已选上限（默认 20，可配到 {@link GEO_PROMPT_CAP_MAX}）。 */
  prompt_cap: number
  /** 关注的关键词（SEO 排名用，默认 20、上限 100）。 */
  keywords: BrandWatchKeyword[]
  /** 市场（ISO 国家码，大写；默认取公司档案的目标市场）。 */
  markets: string[]
  /** 关掉探测的市场（只关探测，不改公司档案；沿用 `GeoSettings.markets_off`）。 */
  markets_off?: string[]
  /** 关注的 AI（决策 460：默认 ChatGPT、Gemini、Claude + Google AI 概览，各自可关）。 */
  platforms: AiPlatform[]
  frequency: BrandWatchFrequency
  /** 决策 466：排名默认手机；`both` = 两份钱。 */
  rank_device: 'mobile' | 'desktop' | 'both'
  /** 总开关（沿用 `GeoSettings.enabled`）。 */
  enabled: boolean
  next_run_at?: Iso8601
  updated_at: Iso8601
}

/** 一条引用指向的站是哪类（docs/99 §5.5；先查内置表，认不出的 O2 交模型判一次并缓存）。 */
export type CitedSiteKind =
  | 'ours'
  | 'competitor'
  | 'marketplace'
  | 'media'
  | 'forum'
  | 'video'
  | 'other'

/** 一轮监测（`watch_runs`）。468 改了：品牌词数据从 Search Console 每周取（`brand_gsc`）。 */
export interface WatchRun {
  id: string
  kind: 'geo' | 'rank' | 'brand_gsc'
  trigger: 'scheduled' | 'manual' | 'baseline'
  /** 周一日期（`YYYY-MM-DD`）。 */
  period: string
  status: 'running' | 'done' | 'failed'
  /** 计划问几格 / 拿到回答几格。 */
  planned: number
  answered: number
  credits: number
  started_at: Iso8601
  finished_at?: Iso8601
  /** WP321：这一轮的几句人话（没查成的、跳过 Claude 的……）。 */
  notes?: string[]
}

/** 一次问答（Prompt × AI × 市场 × 那一轮）——**全文是真源**，指标都从它算、可重算。 */
export interface GeoAnswerRecord {
  id: string
  run_id: string
  prompt_id: string
  /** Prompt 原句快照。 */
  prompt_text: string
  /** 翻成市场语言后真问出去的那句（没翻就同 `prompt_text`）。 */
  asked_text: string
  platform: AiPlatform
  /** 如 `claude-sonnet-5`；网页端抓取写 `web`。 */
  model: string
  via: AiAnswerVia
  market: string
  language: string
  /** `empty` / `failed` 不算「没提到」，不进提及率分母（docs/99 §5.3）。 */
  status: 'ok' | 'empty' | 'failed'
  answer_md: string
  answer_hash: string
  fetched_at: Iso8601
  credits: number
}

/** 回答里的一条引用（`geo_citations`）。 */
export interface GeoCitationRecord {
  answer_id: string
  position: number
  url: string
  /** 去跟踪参数（utm / gclid…）、去 `www.`、去尾斜杠之后的网址（反查「按页面」用）。 */
  url_norm: string
  domain: string
  title?: string
  snippet?: string
  where: AiCitationWhere
  site_kind: CitedSiteKind
}

/** 一条回答里一个品牌（我们 / 某个竞品）的判定（`geo_mentions`；数不经模型手）。 */
export interface GeoMentionRecord {
  answer_id: string
  /** `ours` 或竞品 id。 */
  entity: string
  /** 判定那一刻的名字快照（改名不影响历史）。 */
  name_snapshot: string
  /** 命中的是哪个名字 / 别名 / 域名（没命中不写）。 */
  alias_hit?: string
  mentioned: boolean
  cited: boolean
  /** 首次出现的字符位置（去引用标记之后的正文里；没提到不写）。 */
  first_offset?: number
  /** 在已知品牌（我们 + 竞品）里按首次出现先后排第几（1 起；没提到不写）。 */
  rank?: number
  /** 决策 470：只对我们判，模型判、必须附原话（O2 才有）。 */
  sentiment?: 'positive' | 'neutral' | 'negative'
  sentiment_quote?: string
  rules_version: number
}

/** 一个关注词一次排名（`seo_rank_snapshots`）。 */
export interface SeoRankSnapshot {
  run_id: string
  keyword: string
  market: string
  device: 'mobile' | 'desktop'
  /** 自然结果第几（20 名外 = 不写）。 */
  rank?: number
  url?: string
  serp_features: SerpFeatures
  aio_mentions_us: boolean
  aio_cites_us: boolean
  fetched_at: Iso8601
}

/** 决策 468（Luoye 10-14 改）：品牌词在 Search Console 里一周的曝光 / 点击 / 平均排名。 */
export interface SeoBrandGscWeek {
  /** 周一日期（`YYYY-MM-DD`）。 */
  week: string
  query: string
  impressions: number
  clicks: number
  position: number
  fetched_at: Iso8601
}

/** 决策 473：导出（JSON 一份；CSV 每张表一份）。 */
export interface GeoHistoryExport {
  format: 'json' | 'csv'
  exported_at: Iso8601
  range?: { from?: Iso8601; to?: Iso8601 }
  /** `json`：每张表的行。 */
  tables?: {
    watch: BrandWatch | null
    runs: WatchRun[]
    answers: GeoAnswerRecord[]
    citations: GeoCitationRecord[]
    mentions: GeoMentionRecord[]
    ranks: SeoRankSnapshot[]
    brand_gsc: SeoBrandGscWeek[]
    /** WP321：模型从回答里认出的其他品牌（只用来建议加竞品，不进指标）。 */
    other_brands?: { answer_id: string; name: string }[]
    /** WP380：AI 判断（比较 / 说法）、官方事实表、一致性检查、复查。 */
    insights?: GeoAnswerInsight[]
    facts?: GeoOfficialFact[]
    consistency?: GeoConsistencyRun[]
    rechecks?: GeoRecheck[]
  }
  /** `csv`：表名 → CSV 正文（UTF-8，带表头）。 */
  csv?: Record<string, string>
}

/** 决策 473：删除（按品牌 = 这个品牌的全部历史；按时间段 = `[from, to)` 之间取到的）。 */
export interface GeoHistoryDeleteInput {
  scope: 'brand' | 'range'
  from?: Iso8601
  to?: Iso8601
  /** 按品牌删时连关注设置与 Prompt 一起删（默认只删历史）。 */
  include_settings?: boolean
}

export interface GeoHistoryDeleteResult {
  runs: number
  answers: number
  citations: number
  mentions: number
  ranks: number
  brand_gsc: number
}

/* ------------------------------------------------------------------ */
/* WP321（docs/99 §7 O2）：策略设定、每周监测、指标                        */
/* ------------------------------------------------------------------ */

/** 品牌在搜索上的阶段（AI 按品牌档案与 Search Console 判；决定追几条、带品牌名几条）。 */
export type GeoBrandStage = 'new' | 'growing' | 'established'

/**
 * 决策 531（Luoye 10-14 改）：「带品牌名几条」**不预设**——策略设定时 AI 按品类 / 阶段 / 市场建议、
 * 用户确认。只留这一个兜底值：没模型或模型没给出像样的建议时追几条。
 */
export const GEO_STRATEGY_FALLBACK_PROMPTS = 5

/** 一个方向追几条（策略里的「各方向占多少」）。 */
export interface GeoStrategyTopicShare {
  topic: GeoPromptTopic
  count: number
}

/**
 * WP321：一份「GEO 关注设置」的策略建议（首次 / 改策略时出；用户确认或改了才落成 `BrandWatch`）。
 * `by: 'ai'` = 模型按品牌档案给的；`'rules'` = 没模型时的兜底（追 5 条）。
 */
export interface GeoWatchStrategy {
  by: 'ai' | 'rules'
  /** 品类（模型从档案里认出来的；认不出不写）。 */
  category?: string
  stage?: GeoBrandStage
  /** 建议追几条（已选）。 */
  prompt_limit: number
  /** 其中带品牌名的几条（不预设，按品类 / 阶段建议）。 */
  branded: number
  /** 各方向占几条（合计 = `prompt_limit`）。 */
  topic_mix: GeoStrategyTopicShare[]
  /** 建议已选的 Prompt（`selected: true`）。 */
  prompts: GeoQuestion[]
  /** 其余候选（`selected: false`，按方向分组展示）。 */
  candidates: GeoQuestion[]
  /** 建议的竞品（3–5 个；首次出「改东西」卡）。 */
  competitors: BrandWatchCompetitor[]
  /** 建议的关注关键词（SEO 排名用）。 */
  keywords: BrandWatchKeyword[]
  /** 关注的 AI（决策 460 / 530：默认四家，各自可关）。 */
  platforms: AiPlatform[]
  /** 几句为什么（人话、短）。 */
  why: string[]
  created_at: Iso8601
}

/** 云上没给价时估算用的兜底价（积分 / 次；界面标「估」）。真价以云上价目为准。 */
export const GEO_ESTIMATE_FALLBACK_PRICES = {
  ai_answer: 0.2,
  claude: 3.6,
  rank_check: 0.1,
} as const
/** 单格 ≥ 这个积分（Claude）时，「现在跑一轮」要一轮合并确认一次（docs/75，不逐格弹）。 */
export const GEO_CONFIRM_UNIT_CREDITS = 1
/** 每月按几轮折算（每周 4.33、每两周 2.17、每月 1、只手动 0）。 */
export const GEO_RUNS_PER_MONTH: Readonly<Record<BrandWatchFrequency, number>> = {
  weekly: 4.33,
  biweekly: 2.17,
  monthly: 1,
  manual: 0,
}

/** WP321（决策 460 / 469）：一轮大概花多少——按 AI 分开、Claude 单列。 */
export interface GeoRunEstimate {
  route: 'official' | 'byo' | 'none'
  prompts: number
  markets: number
  /** 每个 AI 这一轮问几格（Prompt × 市场）、单价、小计。 */
  platforms: { platform: AiPlatform; cells: number; unit_credits?: number; credits?: number }[]
  /** 关注词排名这一轮查几格（词 × 市场 × 设备）。 */
  rank?: { cells: number; unit_credits?: number; credits?: number }
  /** 这一轮合计（官方那条路按单价；自带 key 是 0；没价不写）。 */
  credits?: number
  /** 按频率折算的每月（只手动 = 0）。 */
  credits_per_month?: number
  /** 决策 460：Claude 那一格旁写清每月大概多少。 */
  claude_credits_per_month?: number
  /** 有单价是兜底估的（云上没给价）。 */
  estimated_prices?: boolean
  /** 单格 ≥ {@link GEO_CONFIRM_UNIT_CREDITS}（Claude）：「现在跑一轮」先合并确认一次。 */
  needs_confirm: boolean
}

/** `geo_watch` 卡（改东西家族：通过 / 改 / 不要）的 payload。 */
export type GeoWatchCardPayload =
  | {
      form: 'geo_watch_setup'
      strategy: GeoWatchStrategy
      estimate: GeoRunEstimate
      /** 第一次设定（不是改策略）。 */
      first: boolean
    }
  | {
      form: 'geo_watch_competitors'
      /** 回答里反复出现、还没在竞品名单里的品牌（≥ 3 条回答）。 */
      competitors: (BrandWatchCompetitor & { answers: number })[]
      week_of: string
    }
  | {
      /** WP380：对外说法不一致，按岗位分好（同 WP350 方案卡：就这样 = 各岗位各开一件事）。 */
      form: 'geo_consistency'
      run_id: string
      batch_id: string
      groups: { owner: GeoFixOwner; findings: GeoConsistencyFinding[] }[]
      /** 复查日期（`YYYY-MM-DD`）：到期重跑提到我们的那组问题，看描述准确度。 */
      recheck_on: string
    }
  | {
      /** WP380：改完复查——前后对比与建议（就这样 = 照建议开一件跟进的事；保留则只记下）。 */
      form: 'geo_recheck'
      recheck: GeoRecheck
    }

/** 指标的几条硬规矩（docs/99 §5.3，借 open-seo）。 */
export const GEO_TREND_WEEKS = 4
/** 任一期覆盖（拿到回答的格 ÷ 计划的格）不到这个数，就不出变化。 */
export const GEO_TREND_MIN_COVERAGE = 0.9

/**
 * WP321：一周（或一段）的 GEO 几个数——**规则算，数不经模型手**。分母只算拿到回答的
 * （失败 / 空回答不算「没提到」）。没有拿到回答时比率不写（不出 0）。
 */
export interface GeoWeekPoint {
  /** 周一日期（`YYYY-MM-DD`）。 */
  week: string
  /** 计划几格 / 拿到回答几格（`ok`）。 */
  planned: number
  ok: number
  mentioned: number
  cited: number
  /** 提及率 / 引用率（0–1）。 */
  mention_rate?: number
  citation_rate?: number
  /** 平均名次（只在提到我们的回答里平均；在已知品牌里排）。 */
  avg_rank?: number
  /** 声量份额：我们被提到的次数 ÷（我们 + 各竞品被提到的次数）。 */
  sov?: number
  /** 覆盖 = ok ÷ planned。 */
  coverage?: number
  /** 近 4 周滚动的提及率。 */
  mention_rate_4w?: number
  /** 与上一周比的提及率变化（百分点，只比两期都拿到回答的格；任一期覆盖 < 90% 不写）。 */
  change_pp?: number
  /**
   * WP380 比较胜率：同时提到我们与竞品、且分了高下的回答几条（`compared`）、其中更推荐我们的
   * 几条（`wins`）、胜率（`wins ÷ compared`，没分高下的不进分母；`compared` 为 0 不写）。AI 判断。
   */
  compared?: number
  wins?: number
  win_rate?: number
  /** WP380 描述准确度：回答里说到我们的几句（`claims`）、对 / 错 / 过时各几句、准确度（对 ÷ 说到）。AI 判断。 */
  claims?: number
  claims_correct?: number
  claims_wrong?: number
  claims_outdated?: number
  accuracy?: number
}

/** 一条趋势线：全部 / 某个 AI / 某个市场 / 带不带品牌名。 */
export interface GeoTrendLine {
  kind: 'all' | 'platform' | 'market' | 'branded'
  /** `all`、平台名、国家码、`branded` / `unbranded`。 */
  key: string
  points: GeoWeekPoint[]
}

/** 一个品牌（我们 / 竞品）这一周被提到几次与声量份额。 */
export interface GeoBrandShare {
  entity: string
  name: string
  mentioned: number
  sov?: number
}

/** 被引用的一个站（按域名）或一页（按 `url_norm`）。 */
export interface GeoCitedSource {
  domain: string
  /** 按页面看时才有。 */
  url_norm?: string
  url?: string
  title?: string
  site_kind: CitedSiteKind
  /** 我们 / 竞品 / 站外。 */
  group: 'ours' | 'competitor' | 'offsite'
  /** 这一段被引用几次、出现在几条 Prompt、哪几个 AI。 */
  citations: number
  prompts: number
  platforms: AiPlatform[]
  /** 上一段（同样长）被引用几次；上一段没有、这一段有 = `new`。 */
  previous: number
  new: boolean
}

/** 同一格（Prompt × AI × 市场）这周与上周比（只比两期都拿到回答的格，有变化才列）。 */
export interface GeoCellChange {
  prompt_id: string
  prompt_text: string
  platform: AiPlatform
  market: string
  mentioned: { before: boolean; after: boolean }
  rank?: { before?: number; after?: number }
  sentiment?: { before?: GeoMentionRecord['sentiment']; after?: GeoMentionRecord['sentiment'] }
  /** 引用来源的增减（按域名）。 */
  sources_added: string[]
  sources_removed: string[]
  /** 全文一字没变。 */
  same_text: boolean
}

/** 一个关注词的排名行（每个市场 × 设备分开）。 */
export interface RankKeywordRow {
  keyword: string
  market: string
  device: 'mobile' | 'desktop'
  /** 这周第几（20 名外不写）。 */
  rank?: number
  previous?: number
  four_weeks_ago?: number
  /** 与上周比（正 = 升了几名；上周没数不写）。 */
  change?: number
  url?: string
  features: SerpFeatures
  aio_mentions_us: boolean
  aio_cites_us: boolean
  /** Search Console 的平均排名（真实，同一个词；没有就不写）。 */
  gsc_position?: number
}

export interface RankMetricsView {
  week?: string
  rows: RankKeywordRow[]
  /** 只平均进了前 20 的词。 */
  avg_rank?: number
  in_top20: number
  out_of_20: number
  entered_top10: number
  left_top10: number
}

/** WP321：看板要的全部 GEO / SEO 数（O3 用组件画；这里只给数）。 */
export interface GeoMetricsView {
  /** 最新一周（周一日期）；还没有历史不写。 */
  week?: string
  trends: GeoTrendLine[]
  /** 最新一周：我们与各竞品被提到几次、声量份额。 */
  brands: GeoBrandShare[]
  /** 最新一周提到我们的回答的情感（AI 判断，附原话）。 */
  sentiment: { positive: number; neutral: number; negative: number; by: 'ai' }
  /** 近 4 周被引用最多的站 / 页（各前 10），我们自己的页、竞品的页单列。 */
  top_domains: GeoCitedSource[]
  top_pages: GeoCitedSource[]
  our_pages: GeoCitedSource[]
  competitor_pages: GeoCitedSource[]
  changes: GeoCellChange[]
  rank: RankMetricsView
  brand_gsc: {
    connected: boolean
    weeks: { week: string; impressions: number; clicks: number; position?: number }[]
  }
  notes: string[]
  /** WP335：Prompt × AI 方格（最新一周）。还没有历史不写。 */
  grid?: GeoGridView
  /** WP335：简报那一行（「AI 里提到我们 38%（+5）· 关注词平均第 12（−1）」）；这周没跑成不写。 */
  brief?: string
  /** WP380：比较胜率与描述准确度那一块（官方事实、说错的几句、和各竞品比、一致性、复查）。 */
  quality?: GeoQualityView
}

/* ------------------------------------------------------------------ */
/* WP335（docs/99 §5.4 / §5.6，O3）：方格与「一条回答」                    */
/* ------------------------------------------------------------------ */

/** 方格里一格的状态：提到了 / 没提到 / 没查成（失败 / 空回答，不算「没提到」）。 */
export type GeoCellState = 'mentioned' | 'absent' | 'failed'

/** Prompt × AI 方格里的一格（最新一周；同一周同一格好几条取最新那条）。没问的格不出现。 */
export interface GeoGridCell {
  platform: AiPlatform
  market: string
  state: GeoCellState
  /** 在已知品牌里排第几（提到了才有）。 */
  rank?: number
  /** 引用来源里有我们的站。 */
  cited: boolean
  /** 点开看这条回答（`GET /v1/seo/watch/answers/:id`）。 */
  answer_id: string
  /** 和上一期同一格比：`up` 没提到 → 提到 / 名次往前；`down` 反过来。两期有一期没拿到回答不写。 */
  change?: 'up' | 'down'
}

export interface GeoGridRow {
  prompt_id: string
  prompt_text: string
  branded?: boolean
  cells: GeoGridCell[]
  /** 行尾小箭头：这一行提到我们的格数比上一期多 / 少（只比两期都拿到回答的格）。 */
  change?: 'up' | 'down'
}

export interface GeoGridView {
  /** 哪一周（周一日期）。 */
  week: string
  /** 列：这一周问过的 AI（按 `AI_PLATFORMS` 的顺序）。 */
  platforms: AiPlatform[]
  /** 这一周问过的市场（≥ 2 个时每格按市场再分）。 */
  markets: string[]
  rows: GeoGridRow[]
}

/** 一条回答的一面（这一期 / 上一期）。 */
export interface GeoAnswerSide {
  /** 那一轮的周（周一日期）。 */
  week: string
  answer: GeoAnswerRecord
  /** 按回答里出现的顺序（`position`）。 */
  citations: GeoCitationRecord[]
  mentions: GeoMentionRecord[]
}

/**
 * WP335：「一条回答」组件要的读视图（`GET /v1/seo/watch/answers/:id`）——全文、编号引用、
 * 各品牌判定、同一格上一期（「和上周比」）、这一格近 12 周的时间线、高亮用的名字。
 */
export interface GeoAnswerDetail extends GeoAnswerSide {
  /** 同一格（Prompt × AI × 市场）上一期拿到的那条（最近的更早一周）；没有不写。 */
  previous?: GeoAnswerSide
  /** 这一格近 12 周：每周一个点（同一周取最新那条），旧的在前。 */
  history: { week: string; state: GeoCellState; rank?: number; answer_id: string }[]
  /** 高亮用：我们（`ours`）与各竞品的名字、别名、域名。 */
  names: { entity: string; name: string; terms: string[] }[]
}

/** WP321：「GEO 关注设置」面板 / 设定卡要的一份读视图。 */
export interface GeoWatchView {
  watch: BrandWatch
  /** 这一轮（按现在的设置）大概花多少。 */
  estimate: GeoRunEstimate
  /** 策略定没定：`needed` = 还没定（出设定卡）；`pending_card` = 卡在等人；`done` = 定过了。 */
  setup: 'needed' | 'pending_card' | 'done'
  setup_card_id?: string
  /** 最近几轮（每种最多 3 轮，新的在前）。 */
  last_runs: WatchRun[]
  /** 排队档还没回来的任务数。 */
  pending_tasks: number
  search_data: 'configured' | 'not_configured'
  /** 没连 Search Console：品牌词那一块不显示，提示去连（决策 468）。 */
  gsc_connected: boolean
  /** 几句人话（跳过 Claude 的原因……）。 */
  notes: string[]
}

/** WP321：改「GEO 关注设置」（用户确认 / 改策略；每样都可以单给）。 */
export interface GeoWatchPatch {
  /** 整份采用一份策略（设定卡「通过」/「改」走这里）。 */
  strategy?: GeoWatchStrategy
  brand_aliases?: string[]
  /** WP392（docs/104 C8）：自家在 Amazon 上的商品（整份替换；空数组 = 清掉）。 */
  brand_amazon?: BrandWatchAmazonItem[]
  competitors?: BrandWatchCompetitor[]
  keywords?: BrandWatchKeyword[]
  platforms?: AiPlatform[]
  markets_off?: string[]
  frequency?: BrandWatchFrequency
  rank_device?: BrandWatch['rank_device']
  enabled?: boolean
  /** 已选几条（5 / 10 / 20，不超过上限）。 */
  prompt_limit?: number
  /** 已选 = 这几条（其余变候选）。 */
  select?: string[]
  /** 加几条（人加的，`origin: 'human'`；`id` 不给就按原句算一个稳定的）。 */
  add_prompts?: { id?: string; text: string; topic?: GeoPromptTopic; selected?: boolean }[]
  /** 改字 = 归档旧的 + 新建一条。 */
  edit_prompts?: { id: string; text: string }[]
  archive_prompts?: string[]
}

/** WP321：「现在跑一轮」的结果。要合并确认时不跑、只回估算。 */
export interface GeoWatchRunResult {
  started: boolean
  /** 单格 ≥ 1 积分（Claude）还没确认：带上 `confirm: true` 再来一次。 */
  needs_confirm?: boolean
  estimate: GeoRunEstimate
  runs: WatchRun[]
  pending_tasks: number
  notes: string[]
}

/** WP321：`POST /v1/seo/watch/strategy` 的结果（出了设定卡才有卡 id）。 */
export interface GeoWatchSuggestion {
  strategy: GeoWatchStrategy
  estimate: GeoRunEstimate
  approval_item_id?: string
}
