/**
 * WP155：DataForSEO 适配器（docs/81 §1 的首选；官方数据接口用它，用户也可以自带它的 key）。
 *
 * | 要什么 | 打哪个口（都是 Live，一次一个任务） |
 * |---|---|
 * | SERP（Google / Bing） | `/v3/serp/{google,bing}/organic/live/advanced`，Google 带 `load_async_ai_overview` |
 * | AI 概览 | 同 Google SERP，取 `ai_overview` 那一项 |
 * | ChatGPT / Gemini | `/v3/ai_optimization/{chat_gpt,gemini}/llm_scraper/live/advanced`（网页端真看到的回答） |
 * | Perplexity | `/v3/ai_optimization/perplexity/llm_responses/live`（sonar 模型 API + 联网搜索） |
 * | Copilot | **没有**（docs/81 §1.1）；不列进 `platforms` |
 *
 * 鉴权：HTTP Basic，key 就是 `login:password` 这一串。形状照官方文档示例（出处见 docs/81 §3），
 * 替身响应在 `test/fixtures/search/dataforseo-*.json`。
 */
import type { SerpItem, SerpQuery } from '@agentsws/contracts'
import { domainOf, SearchDataError, uniqueUrls } from '../analyze.js'
import {
  AI_ANSWER_TIMEOUT_MS,
  type AiAnswerInput,
  arr,
  callProvider,
  obj,
  type ProviderAnswer,
  type ProviderSerp,
  renumber,
  SERP_TIMEOUT_MS,
  type SearchFetch,
  type SearchProviderAdapter,
  str,
} from '../provider.js'

export const DATAFORSEO_BASE = 'https://api.dataforseo.com/v3'
const LABEL = 'DataForSEO'

/** ISO 国家码 → DataForSEO 认的国家名（`location_name`）。用 Intl 的英文名，几个写法不同的单列。 */
const NAME_OVERRIDES: Record<string, string> = {
  us: 'United States',
  gb: 'United Kingdom',
  kr: 'South Korea',
  tw: 'Taiwan',
  hk: 'Hong Kong',
  cz: 'Czechia',
  vn: 'Vietnam',
  ru: 'Russia',
}
export function locationNameOf(country: string): string {
  const cc = country.toLowerCase()
  const fixed = NAME_OVERRIDES[cc]
  if (fixed !== undefined) return fixed
  try {
    return (
      new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase()) ?? cc.toUpperCase()
    )
  } catch {
    return cc.toUpperCase()
  }
}

/** 语言：中文要分简繁（`zh-CN` / `zh-TW`），其余取前段。 */
export function languageCodeOf(language: string): string {
  const l = language.toLowerCase()
  if (l === 'zh' || l === 'zh-cn' || l === 'zh-hans') return 'zh-CN'
  if (l === 'zh-tw' || l === 'zh-hk' || l === 'zh-hant') return 'zh-TW'
  return l.split('-')[0] ?? l
}

function basic(key: string): string {
  return `Basic ${btoa(key)}`
}

/** 信封里的状态码（顶层与任务级都要看；20000 才是成）。 */
function taskOf(body: unknown): { result: Record<string, unknown> | undefined } {
  const top = obj(body)
  const task = obj(arr(top.tasks)[0])
  const code = typeof task.status_code === 'number' ? task.status_code : top.status_code
  if (code === 20000) return { result: obj(arr(task.result)[0]) }
  // 40102 = 没有搜索结果：是一个正常回答，不是错
  if (code === 40102) return { result: undefined }
  const said = str(task.status_message) ?? str(top.status_message) ?? ''
  const n = typeof code === 'number' ? code : 0
  if (n === 40100 || n === 40104 || n === 40204)
    throw new SearchDataError('unauthorized', `${LABEL}说 key 不对或账号没开通：${said}`)
  if (n === 40202 || n === 40209)
    throw new SearchDataError('rate_limited', `${LABEL}说请求太快了：${said}`)
  if (n === 40200 || n === 40203 || n === 40210)
    throw new SearchDataError('provider_error', `${LABEL}那边的余额不够了：${said}`)
  throw new SearchDataError('provider_error', `${LABEL}没答上来（${String(n)}）：${said}`)
}

async function post(
  path: string,
  task: Record<string, unknown>,
  key: string,
  fetch: SearchFetch,
  timeoutMs: number,
): Promise<unknown> {
  return callProvider(
    fetch,
    `${DATAFORSEO_BASE}${path}`,
    {
      method: 'POST',
      headers: { authorization: basic(key), 'content-type': 'application/json' },
      body: JSON.stringify([task]),
    },
    { key, timeoutMs, label: LABEL, errorText: (b) => str(obj(b).status_message) },
  )
}

/** `ai_overview` 那一项 → 文字 + 引用（元素级与整块顶层的 references 都收）。 */
export function aiOverviewOf(item: Record<string, unknown>): ProviderAnswer | undefined {
  const parts: string[] = []
  const urls: (string | undefined)[] = []
  for (const el of arr(item.items).map(obj)) {
    const text = str(el.text) ?? str(el.markdown)
    if (text !== undefined) parts.push(text)
    for (const r of arr(el.references).map(obj)) urls.push(str(r.url))
  }
  for (const r of arr(item.references).map(obj)) urls.push(str(r.url))
  const text = parts.length > 0 ? parts.join('\n') : (str(item.markdown) ?? '')
  if (text.trim() === '') return undefined
  return { text, cited_urls: uniqueUrls(urls) }
}

/** 一页结果 → 契约的 items / AI 概览 / 大家还在问。 */
export function parseDataForSeoSerp(result: Record<string, unknown> | undefined): ProviderSerp {
  const items: Omit<SerpItem, 'position'>[] = []
  const paa: string[] = []
  let overview: ProviderAnswer | undefined
  const push = (type: SerpItem['type'], el: Record<string, unknown>): void => {
    const url = str(el.url)
    if (url === undefined) return
    const snippet = str(el.description)
    items.push({
      url,
      domain: domainOf(url),
      title: str(el.title) ?? url,
      ...(snippet === undefined ? {} : { snippet }),
      type,
    })
  }
  for (const item of arr(result?.items).map(obj)) {
    switch (item.type) {
      case 'organic':
        push('organic', item)
        break
      case 'video':
      case 'short_videos':
        for (const el of arr(item.items).map(obj)) push('video', el)
        break
      case 'shopping':
      case 'popular_products':
        for (const el of arr(item.items).map(obj)) push('shopping', el)
        break
      case 'discussions_and_forums':
        for (const el of arr(item.items).map(obj)) push('forum', el)
        break
      case 'people_also_ask':
        for (const el of arr(item.items).map(obj)) {
          const q = str(el.title)
          if (q !== undefined) paa.push(q)
        }
        break
      case 'ai_overview':
        overview = overview ?? aiOverviewOf(item)
        break
      default:
        // 精选摘要、新闻、图片……有网址的算 other，没有的不进（不编）
        if (str(item.url) !== undefined) push('other', item)
    }
  }
  return {
    items: renumber(items),
    ...(overview === undefined ? {} : { ai_overview: overview }),
    ...(paa.length === 0 ? {} : { people_also_ask: paa }),
  }
}

/** LLM Scraper（ChatGPT / Gemini）→ 回答 + 引用。 */
export function parseLlmScraper(result: Record<string, unknown> | undefined): ProviderAnswer {
  if (result === undefined) return { text: '', cited_urls: [] }
  const urls: (string | undefined)[] = []
  for (const s of arr(result.sources).map(obj)) urls.push(str(s.url))
  for (const s of arr(result.search_results).map(obj)) urls.push(str(s.url))
  const fromItems: string[] = []
  for (const it of arr(result.items).map(obj)) {
    const t = str(it.markdown) ?? str(it.original_text)
    if (t !== undefined) fromItems.push(t)
    for (const s of arr(it.sources).map(obj)) urls.push(str(s.url))
  }
  return { text: str(result.markdown) ?? fromItems.join('\n'), cited_urls: uniqueUrls(urls) }
}

/** LLM Responses（Perplexity）→ 回答 + 引用（Gemini 那一家的真网址在 `direct_url`，一起认）。 */
export function parseLlmResponses(result: Record<string, unknown> | undefined): ProviderAnswer {
  if (result === undefined) return { text: '', cited_urls: [] }
  const parts: string[] = []
  const urls: (string | undefined)[] = []
  for (const it of arr(result.items).map(obj)) {
    if (it.type !== 'message') continue
    for (const sec of arr(it.sections).map(obj)) {
      const t = str(sec.text)
      if (t !== undefined) parts.push(t)
      for (const a of arr(sec.annotations).map(obj)) urls.push(str(a.direct_url) ?? str(a.url))
    }
  }
  return { text: parts.join('\n'), cited_urls: uniqueUrls(urls) }
}

function serpTask(q: SerpQuery): Record<string, unknown> {
  return {
    keyword: q.query,
    location_name: locationNameOf(q.country),
    language_code: languageCodeOf(q.language),
    device: q.device ?? 'desktop',
    depth: 10,
    // Google 的 AI 概览常是异步加载的，不带这一格就拿不到内容（拿不到时服务商退那笔加价）
    ...(q.engine === 'google' ? { load_async_ai_overview: true } : {}),
  }
}

export const dataforseo: SearchProviderAdapter = {
  id: 'dataforseo',
  engines: ['google', 'bing'],
  platforms: ['chatgpt', 'perplexity', 'gemini', 'google_ai_overview'],
  async serp(q, key, fetch) {
    const body = await post(
      `/serp/${q.engine}/organic/live/advanced`,
      serpTask(q),
      key,
      fetch,
      SERP_TIMEOUT_MS,
    )
    return parseDataForSeoSerp(taskOf(body).result)
  },
  async aiAnswer(input: AiAnswerInput, key, fetch) {
    const where = {
      location_name: locationNameOf(input.country),
      language_code: languageCodeOf(input.language),
    }
    switch (input.platform) {
      case 'chatgpt':
      case 'gemini': {
        const path = input.platform === 'chatgpt' ? 'chat_gpt' : 'gemini'
        const body = await post(
          `/ai_optimization/${path}/llm_scraper/live/advanced`,
          { keyword: input.question.slice(0, 500), ...where },
          key,
          fetch,
          AI_ANSWER_TIMEOUT_MS,
        )
        return parseLlmScraper(taskOf(body).result)
      }
      case 'perplexity': {
        const body = await post(
          '/ai_optimization/perplexity/llm_responses/live',
          {
            user_prompt: input.question.slice(0, 500),
            model_name: 'sonar',
            web_search_country_iso_code: input.country.toUpperCase(),
          },
          key,
          fetch,
          AI_ANSWER_TIMEOUT_MS,
        )
        return parseLlmResponses(taskOf(body).result)
      }
      case 'google_ai_overview': {
        const body = await post(
          '/serp/google/organic/live/advanced',
          serpTask({
            query: input.question,
            engine: 'google',
            country: input.country,
            language: input.language,
          }),
          key,
          fetch,
          AI_ANSWER_TIMEOUT_MS,
        )
        return parseDataForSeoSerp(taskOf(body).result).ai_overview ?? { text: '', cited_urls: [] }
      }
      default:
        throw new SearchDataError('unsupported', `${LABEL}探测不了这个平台。`)
    }
  },
  async test(key, fetch) {
    // 账户信息口：不花钱（出处未核实，见 docs/81 §3）
    const body = await callProvider(
      fetch,
      `${DATAFORSEO_BASE}/appendix/user_data`,
      { method: 'GET', headers: { authorization: basic(key) } },
      {
        key,
        timeoutMs: SERP_TIMEOUT_MS,
        label: LABEL,
        errorText: (b) => str(obj(b).status_message),
      },
    )
    taskOf(body)
  },
  costKey: (kind) => `dataforseo:${kind}`,
}
