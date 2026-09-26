/**
 * WP155（docs/81）**搜索数据接口**的契约：SERP 查询 + 主流 AI 平台问答探测，SEO 与 GEO 共用。
 *
 * 这一份是 WP154「内容与搜索」为了能编译，**按 WP155 派工单原样**建的（WP155 在并行实现它，
 * 路由、计费、服务商适配器都在那边）。字段名一个不改；合并时若 WP155 已先合，以它为准，
 * 两边只要形状一致就行（WP155 只会加可选字段）。
 *
 * WP154 只消费 {@link SearchDataPort}：`status().configured === false` 时 SERP 检查与
 * GEO 探测跳过，卡上一句人话「搜索数据接口还没接」，其余照跑。
 */

export type SearchEngine = 'google' | 'bing'
export type AiPlatform = 'chatgpt' | 'perplexity' | 'gemini' | 'google_ai_overview' | 'copilot'
export interface SerpQuery {
  query: string
  engine: SearchEngine
  country: string
  language: string
  device?: 'desktop' | 'mobile'
}
export interface SerpItem {
  position: number
  url: string
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
  source: string
}
export interface AiAnswerProbe {
  question: string
  platforms: AiPlatform[]
  country: string
  language: string
  brand: { name: string; domains: string[] }
}
export interface AiAnswerResult {
  platform: AiPlatform
  answer_excerpt: string
  brand_mentioned: boolean
  our_domain_cited: boolean
  cited_urls: string[]
  competitors_mentioned: string[]
  fetched_at: string
  source: string
}
export interface SearchDataStatus {
  configured: boolean
  route: 'official' | 'byo' | 'none'
  reason?: string
}
export interface SearchDataPort {
  status(): Promise<SearchDataStatus>
  serp(q: SerpQuery): Promise<SerpResult>
  aiAnswers(p: AiAnswerProbe): Promise<AiAnswerResult[]>
}
