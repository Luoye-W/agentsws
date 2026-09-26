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
  /** 这一件落成了什么：改动卡 / 选题卡 / 事项（服务端回填）。 */
  outcome?: {
    kind: 'change' | 'topic' | 'matter' | 'dropped' | 'none'
    id?: string
    note?: string
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
  brand_mentioned: boolean
  our_domain_cited: boolean
  cited_domains: string[]
  competitors_mentioned: string[]
}

/** 缺位的那一格给的建议：改哪页 / 交公关。 */
export interface GeoGap {
  question: string
  platforms: AiPlatform[]
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
}

export type SeoReportPayload = SeoDailyPayload | SeoWeeklyRevenuePayload | SeoWeeklyGeoPayload

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
  category: 'absolute' | 'medical' | 'other'
  /** 给人看的理由。 */
  reason: string
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
