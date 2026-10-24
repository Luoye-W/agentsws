/**
 * WP381（决策 1066）：网站 / 商品体检与 AI 来源流量的**形状**。
 *
 * 三块各自独立，任何一块没读到都照「没读到」落，不补一个「缺」：
 *
 * 1. AI 爬虫：robots.txt 挡没挡 GPTBot / OAI-SearchBot / ClaudeBot…（清单是数据，可更新）；
 * 2. 原始 HTML：价格、库存、卖点、政策这几样关键事实，不开 JS 抓到的页面里有没有；只在渲染后才出现的标出来；
 * 3. 商品信息机器可读：店铺后台（真源）对照页面文字、结构化数据（JSON-LD Product / Offer）、商品 feed、
 *    各平台上架页，价格 / 币种 / 库存 / 规格 / 退换与配送政策是否一致、是否带日期；
 *
 * 外加 AI 来源流量（Shopify 的来源 / 会话数据，标「实测」），GEO 周报读它。
 * 思路借 Aleyda Solis《AI Search Optimization Checklist》（aleydasolis.com），用我们自己的话写。
 */

import type { LlmsTxtCheck } from './seo-plan.js'

/** 一个 AI 爬虫是干什么的：进 AI 搜索 / 替用户临时打开 / 拿去训练模型。 */
export type AiCrawlerPurpose = 'search' | 'user' | 'training'

/** AI 爬虫清单里的一行（数据，可更新：`DEFAULT_AI_CRAWLERS` + 品牌自己加减）。 */
export interface AiCrawler {
  /** robots.txt 里 `User-agent:` 写的那个名字（大小写不敏感）。 */
  token: string
  /** 哪家（OpenAI / Anthropic / Perplexity…）。 */
  vendor: string
  purpose: AiCrawlerPurpose
  /** 挡了它影响哪个 AI（ChatGPT / Claude / Perplexity…）；训练用的可不写。 */
  platform?: string
}

/** AI 来源清单里的一行（数据，可更新）。 */
export interface AiReferrer {
  /** 显示名（ChatGPT / Perplexity / Gemini / Copilot / Claude…）。 */
  platform: string
  /** 来源网址的主机（含子域名即算）。 */
  hosts: string[]
  /** 落地页 `utm_source` 的值（ChatGPT 会自己带 `utm_source=chatgpt.com`）。 */
  utm_sources?: string[]
}

/** 品牌对两张清单的加减（只存差异，默认清单更新了照样跟上）。 */
export interface SiteHealthListOverrides {
  crawlers_add?: AiCrawler[]
  crawlers_remove?: string[]
  referrers_add?: AiReferrer[]
  referrers_remove?: string[]
}

/** 体检设置（每个品牌一份）。 */
export interface SiteHealthSettings extends SiteHealthListOverrides {
  /** 商品 feed 地址（Google Merchant 那种 XML / RSS；不给 = 只看店铺公开的商品 JSON）。 */
  feed_url?: string
  /** 各平台上架页（亚马逊 / 沃尔玛…）：哪件商品、哪个平台、网址。 */
  listings?: { handle: string; platform: string; url: string }[]
  /** 抽查几件商品（默认 5，最多 20）。 */
  sample_products?: number
}

export type AiCrawlerState = 'allowed' | 'blocked' | 'partial' | 'unknown'

/** 一个 AI 爬虫在这家站上的结论。 */
export interface AiCrawlerVerdict {
  token: string
  vendor: string
  purpose: AiCrawlerPurpose
  platform?: string
  state: AiCrawlerState
  /** 挡住它的那一行（「第 12 行 Disallow: /」）。 */
  rule?: string
  /** 挡住的抽查路径（`partial` 时有）。 */
  blocked_paths?: string[]
}

/** 关键事实的种类。 */
export type SiteFactKind =
  | 'price'
  | 'availability'
  | 'title'
  | 'selling_point'
  | 'return_policy'
  | 'shipping_policy'

/**
 * 一页上一样关键事实：原始 HTML（不开 JS）里有没有、渲染后有没有。
 *
 * - `ok`：原始 HTML 里就有；
 * - `js_only`：只有渲染后才出现——不跑 JS 的 AI 爬虫看不到；
 * - `missing`：两边都没有（或没渲染、原始里也没有）；
 * - `unknown`：这一页没抓到。
 */
export interface RawHtmlFactCheck {
  url: string
  page: 'home' | 'product' | 'policy'
  fact: SiteFactKind
  /** 期望出现的说法（从店铺后台来，如「29.99」「30 天」）。 */
  expected: string
  raw: 'present' | 'absent' | 'unknown'
  rendered: 'present' | 'absent' | 'not_checked'
  verdict: 'ok' | 'js_only' | 'missing' | 'unknown'
}

/** 商品信息在哪儿看到的。 */
export type ProductFactSource = 'page' | 'jsonld' | 'feed' | 'platform'

export type ProductFactField =
  | 'price'
  | 'currency'
  | 'availability'
  | 'variants'
  | 'return_policy'
  | 'shipping_policy'
  | 'date'

/** 一条不一致 / 缺 / 没日期 / 过期。 */
export interface ProductFactIssue {
  product_id: string
  product_title: string
  handle: string
  field: ProductFactField
  source: ProductFactSource
  /** 平台名（`source: platform`）或 feed 的名字。 */
  source_label?: string
  kind: 'mismatch' | 'missing' | 'undated' | 'expired'
  /** 店铺后台里是什么（真源）。 */
  expected?: string
  /** 那一处写的是什么。 */
  found?: string
  severity: 'high' | 'medium' | 'low'
}

/** 每一处带没带日期（价格有效期、更新时间）。 */
export interface ProductSourceDating {
  source: ProductFactSource
  source_label?: string
  /** 看了几件商品。 */
  checked: number
  /** 其中几件带日期。 */
  dated: number
}

/** 「能否进 ChatGPT 购物」逐字段评估（只评估，不对接）。 */
export interface ChatGptShoppingField {
  field: string
  requirement: 'required' | 'conditional' | 'optional'
  /** 抽查的商品里几件这一格能给出合规的值。 */
  covered: number
  total: number
  state: 'ok' | 'partial' | 'missing'
  /** 缺了怎么补（一句人话）。 */
  fix?: string
}

export interface ChatGptShoppingAssessment {
  verdict: 'ready' | 'almost' | 'not_ready'
  fields: ChatGptShoppingField[]
  /** 对照的规范版本（我们读规范的日期）。 */
  spec_read_at: string
}

/** 一次体检的结论（落库、面板与 GEO 周报都读它）。 */
export interface SiteHealthRun {
  id: string
  started_at: string
  finished_at?: string
  /** `partial` = 有几块没读到（`notes` 里写哪几块）。 */
  status: 'ok' | 'partial' | 'failed'
  /** 体检的站（`https://example.com`）。 */
  origin?: string
  robots: { state: 'found' | 'none' | 'unknown'; crawler_list_version: string }
  crawlers: AiCrawlerVerdict[]
  /** 渲染对比做没做：`done` / 找不到浏览器 / 关掉了。 */
  render: 'done' | 'no_browser' | 'off' | 'failed'
  raw_html: RawHtmlFactCheck[]
  products: {
    checked: number
    issues: ProductFactIssue[]
    dating: ProductSourceDating[]
  }
  chatgpt_shopping?: ChatGptShoppingAssessment
  /** WP448：技术体检（没收录、规范网址、跳转与死链、站点地图、hreflang、结构化数据、页面速度）。 */
  tech?: TechAuditResult
  /**
   * WP450：llms.txt 有没有、内容过不过时（和按店铺结构现生成的那份比：合集 / 政策页少了、写着已经没有的页）。
   * 没知道网站 / 没抓成 = 不写（`notes` 里说）。
   */
  llms_txt?: LlmsTxtCheck
  /** 读不到的地方（人话）。 */
  notes: string[]
  /** 不一致清单派给了网站运营（开了一件事）。 */
  dispatched?: { matter_id: string; at: string; issues: number }
}

/** AI 来源流量的一行（一个 AI 平台）。 */
export interface AiTrafficRow {
  platform: string
  /** 访问（会话）数；没授权读店铺报表就没有。 */
  visits?: number
  /** 首次或最后一次进店来自这个 AI、并成交的订单数。 */
  orders: number
  revenue: number
}

/** AI 来源流量小结——保底数字，标「实测」（Shopify 自己记的来源，不经模型）。 */
export interface AiTrafficSummary {
  measured: true
  since: string
  until: string
  currency: string
  rows: AiTrafficRow[]
  /** 窗口里一共多少单（算占比用）。 */
  total_orders: number
  /** 其中来自 AI 的。 */
  ai_orders: number
  ai_revenue: number
  /** 访问数：`ok` / 店铺授权里没有「店铺报表」/ 没读到。 */
  visits: 'ok' | 'no_scope' | 'unavailable'
  computed_at: string
  /** 前一段同样长的窗口里来自 AI 的（算周变化）；没读那么远就没有。 */
  previous?: { ai_orders: number; ai_revenue: number }
  /** 窗口里逐天来自 AI 的单数（画小折线；最早的一天在前）。 */
  daily?: number[]
}

/* ------------------------------------------------------------------ */
/* WP448（docs/109 §4.4、§5.1 #1–2）：技术体检与改版回归                   */
/* ------------------------------------------------------------------ */

/**
 * 技术体检查的七块（规则表在 `@agentsws/site-core` 的 `TECH_AUDIT_RULES`，是数据）：
 * 没收录 / 规范网址 / 跳转与死链 / 站点地图 / hreflang / 结构化数据 / 页面速度。
 */
export type TechAuditArea =
  | 'indexing'
  | 'canonical'
  | 'redirect'
  | 'sitemap'
  | 'hreflang'
  | 'schema'
  | 'speed'

/** 技术问题交给建站的哪一条：网址骨架（跳转、站点地图、死链）归整站搭建，模板里的标签归主题。 */
export type TechAuditOwner = 'site.shopify-build' | 'site.shopify-theme'

/** 一条技术问题（只列有问题的）。数全由规则算出来，不经模型。 */
export interface TechAuditIssue {
  /** 规则 id（`TECH_AUDIT_RULES` 的键，如 `redirect.chain`）。 */
  rule: string
  area: TechAuditArea
  severity: 'high' | 'medium' | 'low'
  owner: TechAuditOwner
  /** 出问题的那一页（站内路径或完整网址）。 */
  url?: string
  /** 一句人话，带证据（「3 跳：/a → /b → /c」「LCP 4.1 秒」）。 */
  detail: string
  /** 跳转类：可以直接出 `stage_url_redirect` 的那一行（旧路径 → 新路径；都是站内路径）。 */
  redirect?: { path: string; target: string }
  /** 速度类：真实用户数据还是实验室数。 */
  measured?: 'field' | 'lab'
}

/** 一次技术体检（跟着 WP381 那一轮跑，挂在 `SiteHealthRun.tech` 上）。 */
export interface TechAuditResult {
  checked_at: string
  /** 抓了几页（首页、抽查的商品、合集、文章…）。 */
  pages: number
  /** 没收录那一项：Search Console 网址检查读到了 / 没连 / 连了但没读到。 */
  indexing: 'checked' | 'not_connected' | 'no_data'
  sitemap: 'found' | 'missing' | 'unreadable' | 'unknown'
  /** 只有一个市场时不查 hreflang。 */
  hreflang: 'checked' | 'single_market'
  /** 速度：真实用户数据 / 只有实验室数 / 两样都有 / 没读到 / 没开。 */
  speed: 'field' | 'lab' | 'mixed' | 'unavailable' | 'off'
  issues: TechAuditIssue[]
  /** 交给建站的事项（按担哪一条分开；同一份清单 7 天内不重派）。 */
  dispatched?: { owner: TechAuditOwner; matter_id: string; at: string; issues: number }[]
}

/** 改版回归抓的那几页（首页、两件商品、一个合集、一篇文章）。 */
export type DriftPageKind = 'home' | 'product' | 'collection' | 'article'

/** 一页的基线（改版前后各抓一份比）。 */
export interface DriftSnapshot {
  url: string
  kind: DriftPageKind
  /** 状态码（抓不到 = 0）。 */
  status: number
  title?: string
  description?: string
  canonical?: string
  /** robots meta 与 `X-Robots-Tag` 合在一起（小写）。 */
  robots?: string
  h1: string[]
  /** 结构化数据摘要：有哪些类型、Product 的价格与币种（比「被改坏」用，不存全文）。 */
  schema: { types: string[]; product_price?: string; product_currency?: string; hash: string }
  captured_at: string
}

/** 改版回归的三级：严重（出卡）/ 注意 / 知道一下（进简报）。 */
export type DriftSeverity = 'critical' | 'warning' | 'info'

/** 一条回归（比对规则表 `DRIFT_RULES` 里的一条命中了）。 */
export interface DriftFinding {
  rule: string
  severity: DriftSeverity
  url: string
  kind: DriftPageKind
  /** 改版前 → 改版后（人话；比如「index → noindex」）。 */
  before?: string
  after?: string
  detail: string
}

/** 这一次回归是什么引起的（「指到是哪次改版」）。 */
export interface DriftTrigger {
  kind: 'theme_publish' | 'app_change' | 'weekly' | 'manual'
  /** 主题发布那张改动卡的 id。 */
  change_id?: string
  /** 人话：「主题「Dawn 副本」发布」「装了 Judge.me」。 */
  label?: string
  at: string
}

export interface DriftRun {
  id: string
  trigger: DriftTrigger
  started_at: string
  finished_at?: string
  /** `baseline` = 第一次，只存基线不比。 */
  status: 'ok' | 'baseline' | 'partial' | 'failed'
  pages: number
  findings: DriftFinding[]
  notes: string[]
  /** 严重的交给建站开了一件事。 */
  dispatched?: { matter_id: string; at: string }
}

/** 面板 / 告警读的那份改版回归数据。 */
export interface SeoDriftView {
  last?: DriftRun
  /** 上一次有发现的那一轮（最近一次可能是「都没变」）。 */
  last_with_findings?: DriftRun
}
