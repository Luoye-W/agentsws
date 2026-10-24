/**
 * WP450（docs/109 §5.2 #9–11、17）：SEO 第二批的**形状**——主题簇与编辑日历、外链体检、llms.txt、改写成社媒稿。
 *
 * - 主题簇：按**搜索结果重叠度**把词分组（前 10 名里共有几个网址，规则算，不经模型），出「一篇总页 + 几篇分页 + 内链怎么连」；
 *   一张卡（`seo_cluster`）批整组，批了按每天 2 篇额度排进日历，到日子给「内容与博客」开一件写作事项。
 * - 外链体检：每月一次（可关）读云上外链概况，看来源域名数变化、锚文本过度集中、可疑来源；竞品有而我们没有的来源站
 *   列 Top 10 **交公关**。用户看得到的字里不提数据商。
 * - llms.txt：按店铺结构与政策页生成内容，交建站放上去；体检里那一项看「有没有、内容过不过时」。
 * - 改写成社媒稿：文章发布后一键起草 X / LinkedIn / Reddit / 短视频脚本，**只起草**、开事项交社媒运营；不编亲身经历与效果数字。
 *
 * 方法借 `AgriciDaniel/claude-seo`（`seo-cluster` / `seo-backlinks` / `seo-agentic`）与 `AgriciDaniel/claude-blog`
 * （`blog-cluster` / `blog-calendar` / `blog-strategy` / `blog-repurpose`），MIT，只借方法（见 THIRD-PARTY-NOTICES）。
 *
 * **只加不删**（契约纪律）。
 */
import type { Iso8601 } from './common.js'

/* ------------------------------------------------------------------ */
/* 主题簇                                                               */
/* ------------------------------------------------------------------ */

/** 搜索意图（按词面认；认不准是 `unknown`）。导航类（品牌名、登录）不进簇。 */
export type SeoKeywordIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational'
  | 'unknown'

/** 一个候选词（从哪来、量多大、我们哪页已经排上了）。 */
export interface SeoClusterKeyword {
  keyword: string
  /** 月搜索量（估算）；没查到不写。 */
  volume?: number
  intent: SeoKeywordIntent
  /** Search Console 近 28 天的曝光 / 点击（有才写）。 */
  impressions?: number
  clicks?: number
  /** 我们已经排上的那一页（Search Console 里这个词点击最多的页）。 */
  ranking_page?: string
  from: 'search_console' | 'related' | 'brand'
}

/** 簇里的一篇（总页或分页）。 */
export interface SeoClusterPost {
  /** 簇内 id（`pillar`、`s1`、`s2`…）。 */
  id: string
  role: 'pillar' | 'spoke'
  keyword: string
  /** 重叠 ≥ 7 个结果的词并进同一篇（一篇接住几个词）。 */
  also?: string[]
  /** 建议标题（规则拼的，写的人可以改）。 */
  title: string
  /** 写一篇新的，还是把已经排上的那页回头改。 */
  kind: 'new' | 'refresh'
  /** `refresh` 时是哪一页。 */
  existing_page?: string
  volume?: number
  /** 第几个小组（重叠 4–6 的归同一组；组内互链）。 */
  group: number
}

/** 一条内链：从哪篇链到哪篇、锚文本用什么词。 */
export interface SeoClusterLink {
  from: string
  to: string
  anchor: string
  /** `mandatory`：分页 ↔ 总页（每篇都要）；`sibling`：同组分页互链；`cross`：只重叠 2–3 个结果的邻组，各链一条。 */
  type: 'mandatory' | 'sibling' | 'cross'
}

/** 两个词前 10 名里共有几个网址（卡上「凭什么分成一组」的证据）。 */
export interface SeoClusterOverlap {
  a: string
  b: string
  shared: number
}

/** 一组主题：一篇总页 + 几篇分页 + 内链怎么连。 */
export interface SeoCluster {
  id: string
  /** 这组讲什么（= 总页的词）。 */
  topic: string
  pillar: SeoClusterPost
  spokes: SeoClusterPost[]
  links: SeoClusterLink[]
  /** 组内重叠最高的几对（证据）。 */
  overlap: SeoClusterOverlap[]
  /** 没进这组的词与原因（导航类、和谁都不重叠……）。 */
  excluded?: { keyword: string; reason: string }[]
}

/** 排进日历的一天（卡上就这么排）。 */
export interface SeoClusterScheduleItem {
  post_id: string
  date: string
}

/** `seo_cluster` 卡（一组主题，批了整组进日历）的 payload。 */
export interface SeoClusterPayload {
  form: 'seo_cluster'
  cluster: SeoCluster
  /** 每天最多几篇（与发布额度同一个数，缺省 2）。 */
  per_day: number
  /** 批了从哪天起排（`YYYY-MM-DD`，工作区日期）；真排时以批的那天为准往后顺。 */
  start: string
  schedule: SeoClusterScheduleItem[]
  /** 这次规划花了多少（官方数据接口的积分；没花不写）。 */
  cost?: { credits: number; calls: number }
  /** 到日子派给谁写：内容与博客 / 没人担内容时派回 SEO 与 GEO / 都没人。 */
  writer: 'content' | 'seo' | 'none'
}

/** 规划一次的结果（面板「出一组」按钮回的）。 */
export interface SeoClusterPlanResult {
  /** 出了卡才有。 */
  approval_item_id?: string
  cluster?: SeoCluster
  /** 没出卡的理由（没接搜索数据、候选词太少……）。 */
  skipped?: string
  cost: { credits: number; calls: number }
  notes: string[]
}

/** 规划一次大概花多少（按钮上写明）。 */
export interface SeoClusterPlanEstimate {
  available: boolean
  /** 不能规划的一句人话。 */
  reason?: string
  /** 最多查几个词的搜索结果。 */
  serp_calls: number
  credits: number
}

/* ------------------------------------------------------------------ */
/* 编辑日历                                                             */
/* ------------------------------------------------------------------ */

export type SeoCalendarStatus = 'scheduled' | 'opened' | 'published' | 'skipped'

/** 日历上的一篇。 */
export interface SeoCalendarEntry {
  id: string
  cluster_id: string
  cluster_topic: string
  post_id: string
  role: 'pillar' | 'spoke'
  keyword: string
  title: string
  kind: 'new' | 'refresh'
  existing_page?: string
  /** 哪天开写（`YYYY-MM-DD`）。 */
  date: string
  status: SeoCalendarStatus
  /** 到日子开的那件写作事项。 */
  matter_id?: string
  opened_at?: Iso8601
  published_at?: Iso8601
  /** 发出去之后的地址（从发布记录里认出来的）。 */
  url?: string
  /** 这篇要放的内链（从它链出去的）。 */
  links: SeoClusterLink[]
}

/** 「哪篇该回头改」的一行（每日判断里在掉的页 + 发了很久的日历文章）。 */
export interface SeoRefreshItem {
  page: string
  query?: string
  reason: string
  since?: string
}

/** 最近发布的一篇文章（「改写成社媒稿」从这里一键起草）。 */
export interface SeoPublishedPost {
  change_id: string
  title: string
  url?: string
  published_at: Iso8601
  /** 起草过社媒稿（起草时间与开出去的事项）。 */
  repurposed_at?: Iso8601
  repurpose_matters?: string[]
}

/** 第三栏「编辑日历」那一块要的全部。 */
export interface SeoCalendarView {
  today: string
  per_day: number
  /** 从今天往前 7 天到往后 28 天的日历。 */
  entries: SeoCalendarEntry[]
  refresh: SeoRefreshItem[]
  published: SeoPublishedPost[]
  clusters: { id: string; topic: string; total: number; published: number }[]
  /** 出一组新的大概花多少 / 能不能出。 */
  plan: SeoClusterPlanEstimate
  /** 还没批的主题簇卡（中栏那张）。 */
  pending?: { approval_item_id: string; topic: string }[]
}

/* ------------------------------------------------------------------ */
/* 外链体检                                                             */
/* ------------------------------------------------------------------ */

/** 外链概况（云上 `seo.backlink_summary` 那一行，规范化之后；都是估算）。 */
export interface BacklinkSummary {
  target: string
  /** 权重 0–100（估算）。 */
  rank?: number
  backlinks?: number
  referring_domains?: number
  referring_main_domains?: number
  broken_backlinks?: number
  /** 外链的垃圾分（0–100，估算）。 */
  spam_score?: number
  at: Iso8601
}

/** 一条外链（云上 `seo.backlinks` 一行，规范化之后）。 */
export interface BacklinkRow {
  url_from: string
  domain_from: string
  url_to?: string
  anchor?: string
  /** 来源站权重（0–100，估算）。 */
  domain_rating?: number
  spam_score?: number
  nofollow?: boolean
}

/** 锚文本的种类（借 claude-seo `seo-backlinks` 的分法）。 */
export type BacklinkAnchorKind = 'brand' | 'url' | 'generic' | 'exact' | 'other'

export interface BacklinkAnchorShare {
  anchor: string
  kind: BacklinkAnchorKind
  count: number
  /** 占比（0–1）。 */
  share: number
}

export type BacklinkIssueRule =
  | 'domains_drop'
  | 'anchor_concentration'
  | 'exact_anchor_high'
  | 'suspicious_sources'
  | 'spam_score_high'
  | 'single_domain_heavy'

export interface BacklinkIssue {
  rule: BacklinkIssueRule
  severity: 'high' | 'medium' | 'low'
  /** 一句人话（带证据数字）。 */
  text: string
}

/** 竞品有、我们没有的一个来源站。 */
export interface BacklinkGapSite {
  domain: string
  /** 链了哪几家竞品。 */
  competitors: string[]
  domain_rating?: number
}

/** 一次外链体检。 */
export interface BacklinkAuditRun {
  id: string
  at: Iso8601
  status: 'ok' | 'partial' | 'skipped'
  trigger: 'scheduled' | 'manual'
  ours?: BacklinkSummary
  /** 上一次的来源域名数与外链数（有才比）。 */
  previous?: { at: Iso8601; referring_domains?: number; backlinks?: number }
  /** 来源域名数变了多少（正 = 多了）。 */
  change?: { referring_domains: number; pct?: number }
  anchors: BacklinkAnchorShare[]
  suspicious: { domain: string; why: string }[]
  issues: BacklinkIssue[]
  /** 竞品有而我们没有的来源站 Top 10（按链了几家竞品、再按权重）。 */
  gap: BacklinkGapSite[]
  competitors: string[]
  /** 没读到 / 没开通的块照实说。 */
  notes: string[]
  /** 这一次花了多少积分（官方数据接口的口径）。 */
  cost: { credits: number; calls: number }
  /** 交公关的那件事。 */
  handed_to_pr?: { matter_id: string; at: Iso8601; sites: number }
}

export interface BacklinkAuditSettings {
  /** 每月一次（可关）。 */
  enabled: boolean
  every_days: number
  /** 比哪几家竞品（不给 = 关注设置里的竞品前 3 家）。 */
  competitors?: string[]
}

export interface BacklinkAuditView {
  settings: BacklinkAuditSettings
  last?: BacklinkAuditRun
  /** 下一次什么时候（关了不写）。 */
  next_due?: string
  /** 一次大概花多少积分（按官方数据接口的价目算；不知道价写 `unknown`）。 */
  estimate: { credits?: number; calls: number; unknown?: boolean }
  available: boolean
  reason?: string
}

/* ------------------------------------------------------------------ */
/* llms.txt                                                             */
/* ------------------------------------------------------------------ */

/** 生成的一份 llms.txt。 */
export interface LlmsTxtDraft {
  content: string
  generated_at: Iso8601
  sections: { title: string; links: number }[]
  /** 店铺结构从哪读的（店铺后台 / 站点地图 / 两样都有）。 */
  source: 'shop' | 'sitemap' | 'mixed'
}

/** 体检里「llms.txt」那一项：有没有、内容过不过时。 */
export interface LlmsTxtCheck {
  state: 'missing' | 'current' | 'stale' | 'invalid' | 'unknown'
  url?: string
  /** 过时 / 不合格的理由（一条一句）。 */
  reasons: string[]
  /** 现在店里有、文件里没写的（合集、政策页……）。 */
  missing_links?: string[]
  /** 文件里写了、店里已经没有的。 */
  dead_links?: string[]
  /**
   * 谁写的：Shopify 自己生成的（2026-05 起店铺默认就有 `/llms.txt`，照抄 `/agents.md`，会跟着店铺变）/ 自己放的。
   * 认不出不写。
   */
  generated_by?: 'shopify' | 'custom'
  checked_at: Iso8601
}

export interface LlmsTxtView {
  draft?: LlmsTxtDraft
  live?: LlmsTxtCheck
  /** 交建站的那件事。 */
  handed_to_site?: { matter_id: string; at: Iso8601 }
  /** 在 Shopify 上怎么放到根目录（几步人话）。 */
  placement: string[]
}

/* ------------------------------------------------------------------ */
/* 改写成社媒稿                                                         */
/* ------------------------------------------------------------------ */

export type RepurposeChannel = 'x' | 'linkedin' | 'reddit' | 'short_video'

export const REPURPOSE_CHANNELS: readonly RepurposeChannel[] = [
  'x',
  'linkedin',
  'reddit',
  'short_video',
]

/** 一个渠道的草稿。 */
export interface RepurposeDraft {
  channel: RepurposeChannel
  /** 正文（X 是串推时各条用空行隔开，另见 `parts`）。 */
  text: string
  parts?: string[]
  /** 要人填的真实经历占位（`[你的真实经历：……]`）。 */
  placeholders: string[]
  /** 起草时拿掉的说法（原文里没有的数字、编的亲身经历）。 */
  removed: string[]
  /** 模型写的还是规则拼的。 */
  by: 'model' | 'rules'
}

/** 一键起草的结果。 */
export interface RepurposeResult {
  source: { title: string; url?: string; change_id?: string }
  drafts: RepurposeDraft[]
  /** 开给社媒运营的事项（一个渠道一件；没人担的渠道不开）。 */
  matters: { channel: RepurposeChannel; role_id: string; matter_id: string }[]
  skipped: { channel: RepurposeChannel; reason: string }[]
}
