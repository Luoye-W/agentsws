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

/** WP310（决策 460）：加 `claude`（只加；通过 Claude 联网回答取得，与 claude.ai 网页上看到的可能略有不同）。 */
export type AiPlatform =
  | 'chatgpt'
  | 'perplexity'
  | 'gemini'
  | 'google_ai_overview'
  | 'copilot'
  | 'claude'

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
  /** WP310 可选 `aliases`：简称、常见拼错、主推商品名——回答里出现别名也算提到。 */
  brand: { name: string; domains: string[]; aliases?: string[] }
  /**
   * WP155 可选：竞品名单。给了才能填 `competitors_mentioned`（按名字与域名在回答里找）；
   * 不给就是空数组——我们不猜谁是竞品。WP310 可选 `aliases`（同上）。
   */
  competitors?: { name: string; domains?: string[]; aliases?: string[] }[]
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
  /**
   * WP310 可选：回答**全文**（markdown 原样；网页端抓取 / 模型接口 / AI 概览都给）。
   * 原文是真源——提及、位次、引用都可以对它重算（docs/99 §5.5）。
   */
  answer_markdown?: string
  /** WP310 可选：结构化引用（按回答里出现的顺序编号，1 起）。有它时 `cited_urls` 仍照旧给（兼容）。 */
  citations?: AiCitation[]
  /** WP310 可选：回答它的模型（如 `claude-sonnet-5`；网页端抓取拿不到准确模型时写 `web`）。 */
  model?: string
  /** WP310 可选：这条回答怎么取得的（界面不写，只在问号里照实说 Claude 那一列）。 */
  via?: AiAnswerVia
}

/**
 * WP310：一条回答怎么取得的。`web_ui` 网页端真看到的（ChatGPT / Gemini）；`model_api` 调模型接口
 * + 强制联网（Claude——claude.ai 网页端谁都抓不了，决策 461）；`serp` 搜索结果页里的那一块（AI 概览）。
 */
export type AiAnswerVia = 'web_ui' | 'model_api' | 'serp'

/**
 * WP310：一条引用在回答里的位置。`inline` 正文里引用的（带角标 / 标注）；`listed` 只列在来源里；
 * `searched` 只在它搜到的结果里、回答没用上（ChatGPT 的 `search_results`）。
 */
export type AiCitationWhere = 'inline' | 'listed' | 'searched'
export const AI_CITATION_WHERE: readonly AiCitationWhere[] = ['inline', 'listed', 'searched']

/** WP310：回答里的一条引用（docs/99 §5.5 `geo_citations` 的线上形状；分类在本机算）。 */
export interface AiCitation {
  /** 1 起，按回答里出现的顺序（同一网址只记第一次）。 */
  position: number
  /** 原样网址。 */
  url: string
  /** 不带 `www.` 的小写主机名。 */
  domain: string
  title?: string
  /** 来源给的摘要（有就带）。 */
  snippet?: string
  where: AiCitationWhere
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
  'claude',
]

/**
 * WP159（Luoye 09-27 定）：**不再用**的 AI 平台。Perplexity 用的人少、在走弱——GEO 默认不探测、
 * 官方那一侧不列它（适配器代码留着，登记为不用）。枚举值 `perplexity` 不删（契约只加不删）。
 */
export const UNUSED_AI_PLATFORMS: readonly AiPlatform[] = ['perplexity']

/**
 * WP159：GEO 每周探测默认问的平台（ChatGPT、Gemini、Google AI 概览）。
 * 实际问哪几个 = 这里 ∩ 这条路能探测的（`SearchDataStatus.platforms`）。
 */
export const GEO_DEFAULT_PLATFORMS: readonly AiPlatform[] = [
  'chatgpt',
  'gemini',
  'google_ai_overview',
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

/* ------------------------------------------------------------------ */
/* WP310（docs/99 §7 O1）：Claude、全文与引用、排名追踪的线上形状          */
/* ------------------------------------------------------------------ */

/**
 * 决策 460：GEO 关注的 AI 默认这四个（ChatGPT、Gemini、Claude + Google AI 概览），每个可单独关。
 * 这是「关注设置」（`BrandWatch.platforms`）的默认；现在每周探测仍按 {@link GEO_DEFAULT_PLATFORMS}，
 * O2 接上历史表时再切过来（Claude 一次约 3.6 积分，不在 O1 里悄悄开）。
 */
export const BRAND_WATCH_DEFAULT_PLATFORMS: readonly AiPlatform[] = [
  'chatgpt',
  'gemini',
  'claude',
  'google_ai_overview',
]

/**
 * 决策 461：这几个平台**不走** `/v1/data/search/ai-answers` 那一个通吃价（0.2 / 平台·次）——
 * Claude 一次的成本是另几家的 25 倍，单独定价（决策 462：3.6 积分）。官方那一侧走能力目录
 * `ai_answer.claude`（`POST /v1/data/call/ai_answer.claude`）；自带 key 那一侧照常直连。
 */
export const AI_PLATFORMS_PRICED_SEPARATELY: readonly AiPlatform[] = ['claude']

/** 决策 461：Claude 用哪个模型、强制联网、输出上限（DataForSEO LLM Responses）。 */
export const CLAUDE_GEO_MODEL = 'claude-sonnet-5'
export const CLAUDE_GEO_MAX_OUTPUT_TOKENS = 1024

/** 网页端抓取拿不到准确模型名时 `model` 写这个。 */
export const AI_ANSWER_MODEL_WEB = 'web'

/**
 * 能力目录里 `ai_answer.*`（含 `ai_answer.claude`）每一条结果的形状——云端（WP309 / C1）与
 * 自带 key 的适配器都按这个给：**全文与结构化引用原样带回**，不再只给节选。判断（提没提到、
 * 第几位、引用归类）在本机做，云端不判。
 */
export interface AiAnswerDataItem {
  platform: AiPlatform
  /** 纯文本 / markdown 都行（判断用）；空串 = 空回答（不收钱，docs/81 §4）。 */
  text: string
  /** 兼容老形状：引用网址（去重保序）。 */
  cited_urls: string[]
  /** WP310：全文 markdown（与 `text` 相同时也照给）。 */
  answer_markdown?: string
  /** WP310：结构化引用（顺序即回答里的顺序）。 */
  citations?: AiCitation[]
  model?: string
  via?: AiAnswerVia
  /** WP310：开了联网却一条引用都没有（Claude 偶尔这样，照收但标出，docs/99 §7 C1）。 */
  no_citations?: boolean
}

/** 决策 465 / 466：关注词排名查前几名、默认设备。 */
export const RANK_CHECK_DEPTH = 20
export const RANK_CHECK_DEFAULT_DEVICE: 'mobile' | 'desktop' = 'mobile'

/** 结果页上我们关心的几种特征（`seo_rank_snapshots.serp_features`）。 */
export interface SerpFeatures {
  ai_overview: boolean
  people_also_ask: boolean
  shopping: boolean
  video: boolean
}

/**
 * 能力目录 `seo.rank_check` 每一条结果（一个关注词一次）：云端只给结果页原样的自然结果与特征，
 * **「我们排第几」在本机算**（子域名也算我们；只数自然结果，`rank_group`）。
 */
export interface SeoRankCheckItem {
  keyword: string
  country: string
  language: string
  device: 'mobile' | 'desktop'
  /** 自然结果（`rank_group` 顺序，最多 {@link RANK_CHECK_DEPTH} 条）。 */
  organic: { rank: number; url: string; domain: string; title: string }[]
  features: SerpFeatures
  /** 有 AI 概览时它的全文与引用（判「AI 概览里提没提 / 引没引我们」用）。 */
  ai_overview?: { text: string; citations: AiCitation[] }
  people_also_ask?: string[]
  fetched_at: string
}
