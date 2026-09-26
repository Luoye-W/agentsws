/**
 * WP155：一家搜索数据服务商的适配器长什么样（docs/81 §3）。
 *
 * 适配器只做两件事：**拼请求**、**把回来的 JSON 翻成契约形状**。计费、缓存、
 * 路由、判断「提没提到我们」都不在这里——那些在 `routes.ts`（官方）与本机那一侧
 * （自带 key），两条路共用同一批适配器。
 *
 * 三条纪律：
 *
 * 1. key 只在拼请求那一行出现（头或查询串），**不进返回值、不进错误信息**；
 *    服务商的错误原文用 `redact` 过一遍再带回去。
 * 2. 超时：SERP 30 秒、AI 问答 90 秒（大模型现答本来就慢）；超时是 `timeout`，不是「没结果」。
 * 3. 不重试：限流重试只会更糟；照实说（`rate_limited`），让上层决定。
 */
import type {
  AiPlatform,
  SearchDataProvider,
  SearchEngine,
  SerpItem,
  SerpQuery,
  SerpResult,
} from '@agentsws/contracts'
import { redact, SearchDataError } from './analyze.js'

/** 适配器只用到 Response 的这一小面（测试替身、本机注入的 fetch 都好满足）。 */
export interface SearchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}
export type SearchFetch = (input: string, init: RequestInit) => Promise<SearchResponseLike>

/** 适配器翻出来的 SERP（`query` / `fetched_at` / `source` 由上层补）。 */
export type ProviderSerp = Pick<SerpResult, 'items' | 'ai_overview' | 'people_also_ask'>

/** 适配器翻出来的一段 AI 回答（判断由 `judgeAnswer` 做）。 */
export interface ProviderAnswer {
  text: string
  cited_urls: string[]
}

export interface AiAnswerInput {
  question: string
  country: string
  language: string
  platform: AiPlatform
}

export interface SearchProviderAdapter {
  id: SearchDataProvider
  engines: readonly SearchEngine[]
  platforms: readonly AiPlatform[]
  serp(q: SerpQuery, key: string, fetch: SearchFetch): Promise<ProviderSerp>
  aiAnswer(input: AiAnswerInput, key: string, fetch: SearchFetch): Promise<ProviderAnswer>
  /**
   * 「测试连接」：打这家最便宜的那个口验 key（能不花钱就不花钱——有的家有免费的账户口）。
   * 通了什么都不回，没通抛 `SearchDataError`。
   */
  test(key: string, fetch: SearchFetch): Promise<void>
  /** 成本表里的键（`cost-table.json` 的 `unit_prices`）：SERP 一次 / 某平台问答一次。 */
  costKey(kind: 'serp' | AiPlatform): string
}

export const SERP_TIMEOUT_MS = 30_000
export const AI_ANSWER_TIMEOUT_MS = 90_000

/**
 * 打一次服务商：超时、HTTP 错误、不是 JSON，各翻成一个码 + 一句人话。
 * `errorText` 从服务商的错误体里挑那句原话（各家字段名不同）。
 */
export async function callProvider(
  fetch: SearchFetch,
  url: string,
  init: RequestInit,
  opts: {
    key: string
    timeoutMs: number
    label: string
    errorText?: (body: unknown) => string | undefined
  },
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  let res: SearchResponseLike
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new SearchDataError(
      aborted ? 'timeout' : 'provider_error',
      aborted
        ? `${opts.label} ${opts.timeoutMs / 1000} 秒没应答，这次先停了。`
        : `连不上${opts.label}（网络不通）。`,
    )
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new SearchDataError(
      'provider_error',
      `${opts.label}回的不是 JSON（HTTP ${res.status}）。`,
    )
  }
  if (!res.ok) {
    const said = opts.errorText?.(body)
    const tail = said === undefined ? '' : `：${redact(said, opts.key)}`
    if (res.status === 401 || res.status === 403)
      throw new SearchDataError('unauthorized', `${opts.label}说 key 不对或没权限${tail}`)
    if (res.status === 402)
      throw new SearchDataError('provider_error', `${opts.label}那边的余额不够了${tail}`)
    if (res.status === 429)
      throw new SearchDataError('rate_limited', `${opts.label}说请求太快了，过一会儿再试${tail}`)
    throw new SearchDataError(
      'provider_error',
      `${opts.label}没答上来（HTTP ${res.status}）${tail}`,
    )
  }
  return body
}

/** 取对象里的字符串 / 数组（服务商的 JSON 形状不可信，一律防着读）。 */
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** 按出现顺序重排 `position`（1 起算）。 */
export function renumber(items: Omit<SerpItem, 'position'>[]): SerpItem[] {
  return items.map((it, i) => ({ ...it, position: i + 1 }))
}
