/**
 * WP155（docs/81）：**搜索数据接口**的契约——SERP 查询 + 主流 AI 平台问答探测，
 * SEO 与 GEO 共用（WP154「内容与搜索」按这个形状消费）。
 *
 * **只加不删**。下面十个导出的字段名是派工单原样定的，WP154 在并行按它写，
 * 一个都不许改；要加东西只加可选字段（标了 `WP155 可选`）。
 *
 * 数据从哪来（路由照 WP126，docs/75 §1）：
 *
 * 1. `official`：Agents 工坊官方数据接口——云端用我们的服务商 key，用户付积分；
 *    命中缓存也收同样的钱，失败退还预扣（Luoye 09-21 定）。
 * 2. `byo`：用户自己的服务商 key（原生表单填、存本机加密库），本机直连，不扣积分。
 * 3. `none`：都没有，一句人话。
 *
 * 对外叫法：官方那一侧只叫「Agents 工坊官方数据接口」，`source` 里也不写服务商名
 * （docs/75 §4）；自带 key 那一侧是用户自己选的服务商，`source` 里如实写它。
 */

import type { Iso8601 } from './common.js'

/* ------------------------------------------------------------------ */
/* 派工单原样的十个形状（字段名不许改）                                   */
/* ------------------------------------------------------------------ */

export type SearchEngine = 'google' | 'bing'

export type AiPlatform = 'chatgpt' | 'perplexity' | 'gemini' | 'google_ai_overview' | 'copilot'

export interface SerpQuery {
  query: string
  engine: SearchEngine
  /** 国家，ISO 3166-1 alpha-2（`us` / `gb` / `de`…，大小写都认）。 */
  country: string
  /** 语言，ISO 639-1（`en` / `de` / `zh`…）。 */
  language: string
  device?: 'desktop' | 'mobile'
}

export interface SerpItem {
  /** 1 起算，按页面上的出现顺序（只数进了 `items` 的那些）。 */
  position: number
  url: string
  /** 不带 `www.` 的主机名。 */
  domain: string
  title: string
  snippet?: string
  type: 'organic' | 'shopping' | 'video' | 'forum' | 'other'
}

export interface SerpResult {
  query: SerpQuery
  items: SerpItem[]
  ai_overview?: { text: string; cited_urls: string[] }
  people_also_ask?: string[]
  fetched_at: string
  /** `official`（Agents 工坊官方数据接口）或 `byo:<服务商>`。 */
  source: string
  /** WP155 可选：这一次花了多少积分（官方那一侧才有；自带 key 为 0 或不写）。 */
  credits?: number
  /** WP155 可选：云端缓存命中（命中照收同价，docs/75 §2 第 1 条）。 */
  cached?: boolean
}

export interface AiAnswerProbe {
  question: string
  platforms: AiPlatform[]
  country: string
  language: string
  brand: { name: string; domains: string[] }
  /**
   * WP155 可选：竞品名单。给了才能填 `competitors_mentioned`（按名字与域名在回答里找）；
   * 不给就是空数组——我们不猜谁是竞品。
   */
  competitors?: { name: string; domains?: string[] }[]
}

export interface AiAnswerResult {
  platform: AiPlatform
  /** 回答的节选（最多 `AI_ANSWER_EXCERPT_MAX` 个字符）。 */
  answer_excerpt: string
  brand_mentioned: boolean
  our_domain_cited: boolean
  cited_urls: string[]
  competitors_mentioned: string[]
  fetched_at: string
  source: string
  /** WP155 可选：这个平台这一次花了多少积分（每个平台一次计）。 */
  credits?: number
  /** WP155 可选：云端缓存命中。 */
  cached?: boolean
}

export interface SearchDataStatus {
  configured: boolean
  route: 'official' | 'byo' | 'none'
  reason?: string
  /** WP155 可选：当前这条路能查的搜索引擎（没接时不写）。 */
  engines?: SearchEngine[]
  /** WP155 可选：当前这条路能探测的 AI 平台（不在里面的平台 `aiAnswers` 会跳过）。 */
  platforms?: AiPlatform[]
  /** WP155 可选：官方那条路的单价（积分 / 次；AI 问答按「每个平台一次」）。 */
  prices?: { serp: number; ai_answer: number }
  /** WP155 可选：自带 key 时用的是哪家服务商。 */
  provider?: SearchDataProvider
}

export interface SearchDataPort {
  status(): Promise<SearchDataStatus>
  serp(q: SerpQuery): Promise<SerpResult>
  aiAnswers(p: AiAnswerProbe): Promise<AiAnswerResult[]>
}

/* ------------------------------------------------------------------ */
/* WP155 另加的（全是新名字，不碰上面十个）                               */
/* ------------------------------------------------------------------ */

/** 全部搜索引擎 / AI 平台（界面与校验用，顺序即展示顺序）。 */
export const SEARCH_ENGINES: readonly SearchEngine[] = ['google', 'bing']
export const AI_PLATFORMS: readonly AiPlatform[] = [
  'chatgpt',
  'perplexity',
  'gemini',
  'google_ai_overview',
  'copilot',
]

/**
 * 自带 key 能选的服务商（docs/81 调研过的三家）。官方那一侧用哪家不进契约——
 * 那是我们的运维决定，对外只叫「Agents 工坊官方数据接口」。
 */
export type SearchDataProvider = 'dataforseo' | 'serpapi' | 'serper'
export const SEARCH_DATA_PROVIDERS: readonly SearchDataProvider[] = [
  'dataforseo',
  'serpapi',
  'serper',
]

/** 两条计费能力（`pricing.json`，block: data）。AI 问答按「每个平台一次」计。 */
export const SEARCH_SERP_CAPABILITY = 'data.search.serp'
export const SEARCH_AI_ANSWER_CAPABILITY = 'data.search.ai_answer'

/** 官方数据接口在云端入口的路径（`packages/cloud-entry`；令牌要 `data` 这一项）。 */
export const SEARCH_DATA_CLOUD_PREFIX = '/v1/data/search'
export const SEARCH_DATA_CLOUD_PATHS = {
  status: '/v1/data/search/status',
  serp: '/v1/data/search/serp',
  aiAnswers: '/v1/data/search/ai-answers',
} as const

/** 官方那一侧 `source` 的固定写法（不写服务商名，docs/75 §4）。 */
export const SEARCH_SOURCE_OFFICIAL = 'official'
/** 自带 key 那一侧 `source` 的写法：`byo:<服务商>`。 */
export const searchSourceByo = (provider: SearchDataProvider): string => `byo:${provider}`

/** `answer_excerpt` 最长多少字符（节选，不是全文）。 */
export const AI_ANSWER_EXCERPT_MAX = 600

/** 一次 AI 问答探测最多问几个平台（= 最多预扣几次）。 */
export const AI_ANSWER_MAX_PLATFORMS = AI_PLATFORMS.length

/**
 * `SearchDataPort` 失败时抛的错误的码表。实现方抛 `Error` 并带 `code` 与一句人话
 * `message`；调用方（WP154）只需要认 `not_configured`（跳过、卡上说一句）与
 * `insufficient_credits`（给充值入口），其余当「这次没查成」。
 */
export type SearchDataErrorCode =
  | 'not_configured'
  | 'insufficient_credits'
  | 'invalid_input'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'unsupported'

export interface SearchDataFailure {
  code: SearchDataErrorCode
  message: string
}

/** 连接页「搜索数据」那一行用户选的档：官方（用积分）/ 自带 key / 不接。`auto` = 没选过。 */
export type SearchDataRouteChoice = 'auto' | 'official' | 'byo' | 'none'

/** 连接页那一行的读视图（**key 永不回传**，只有设没设过）。 */
export interface SearchDataSettingsView {
  choice: SearchDataRouteChoice
  byo?: { provider: SearchDataProvider; has_key: boolean; updated_at: Iso8601 }
  status: SearchDataStatus
}
