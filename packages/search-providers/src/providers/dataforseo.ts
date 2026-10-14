/**
 * WP155：DataForSEO 适配器（docs/81 §1 的首选；官方数据接口用它，用户也可以自带它的 key）。
 *
 * | 要什么 | 打哪个口（都是 Live，一次一个任务） |
 * |---|---|
 * | SERP（Google / Bing） | `/v3/serp/{google,bing}/organic/live/advanced`，Google 带 `load_async_ai_overview` |
 * | AI 概览 | 同 Google SERP，取 `ai_overview` 那一项 |
 * | ChatGPT / Gemini | `/v3/ai_optimization/{chat_gpt,gemini}/llm_scraper/live/advanced`（网页端真看到的回答） |
 * | Claude（WP310，决策 461） | `/v3/ai_optimization/claude/llm_responses/live`（模型接口 + **强制联网**，`claude-sonnet-5`，输出上限 1024）——claude.ai 网页端谁都抓不了 |
 * | Perplexity | `/v3/ai_optimization/perplexity/llm_responses/live`（sonar 模型 API + 联网搜索）。**WP159 起登记为不用**：代码留着，不进 `platforms` |
 * | Copilot | **没有**（docs/81 §1.1）；不列进 `platforms` |
 *
 * WP310：回答**全文**与**结构化引用**（网址 / 标题 / 摘要 / 在正文里还是只列在来源里）原样带回，
 * 不再只留节选与网址（docs/99 §5.5）；判断仍在 `judgeAnswer` / `analyzeAnswer`。
 *
 * 鉴权：HTTP Basic，key 就是 `login:password` 这一串。形状照官方文档示例（出处见 docs/81 §3），
 * 替身响应在 `test/fixtures/search/dataforseo-*.json`。
 */
import type { SerpItem, SerpQuery } from '@agentsws/contracts'
import {
  AI_ANSWER_MODEL_WEB,
  CLAUDE_GEO_MAX_OUTPUT_TOKENS,
  CLAUDE_GEO_MODEL,
} from '@agentsws/contracts'
import { domainOf, SearchDataError, uniqueUrls } from '../analyze.js'
import {
  AI_ANSWER_TIMEOUT_MS,
  type AiAnswerInput,
  arr,
  callProvider,
  obj,
  type ProviderAnswer,
  type ProviderCitation,
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

/**
 * key 两种写法都认：`login:password`（这里再 base64）或 DataForSEO 后台给的「Base64 format」那一串（原样用）。
 * 10-13 真机：后台填了 Base64 那串，这里又编一次，上游回「没权限」。
 */
function basic(key: string): string {
  const k = key.trim()
  return `Basic ${k.includes(':') ? btoa(k) : k}`
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

/** 一条来源 → 结构化引用（各家字段名：title / snippet / text / description）。 */
function citationOf(
  el: Record<string, unknown>,
  where: ProviderCitation['where'],
  url = str(el.url),
): ProviderCitation | undefined {
  if (url === undefined) return undefined
  const title = str(el.title) ?? str(el.source_name) ?? str(el.source)
  const snippet = str(el.snippet) ?? str(el.text) ?? str(el.description)
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined || /^[.\s…]*$/u.test(snippet) ? {} : { snippet }),
    where,
  }
}

const present = <T>(x: T | undefined): x is T => x !== undefined

/** 占位的 markdown（文档示例里是 "..."）不当全文。 */
const realMarkdown = (v: unknown): string | undefined => {
  const m = str(v)
  return m === undefined || /^[.\s…]*$/u.test(m) ? undefined : m
}

/**
 * `ai_overview` 那一项 → 文字 + 引用（元素级与整块顶层的 references 都收）。
 * WP310：元素里的链接与引用算「正文里引用的」，整块顶层的算「列在来源里」；带全文与结构化引用。
 */
export function aiOverviewOf(item: Record<string, unknown>): ProviderAnswer | undefined {
  const parts: string[] = []
  const urls: (string | undefined)[] = []
  const citations: (ProviderCitation | undefined)[] = []
  for (const el of arr(item.items).map(obj)) {
    const text = str(el.text) ?? str(el.markdown)
    if (text !== undefined) parts.push(text)
    for (const r of arr(el.references).map(obj)) {
      urls.push(str(r.url))
      citations.push(citationOf(r, 'inline'))
    }
    for (const l of arr(el.links).map(obj)) citations.push(citationOf(l, 'inline'))
  }
  for (const r of arr(item.references).map(obj)) {
    urls.push(str(r.url))
    citations.push(citationOf(r, 'listed'))
  }
  const text = parts.length > 0 ? parts.join('\n') : (str(item.markdown) ?? '')
  if (text.trim() === '') return undefined
  return {
    text,
    cited_urls: uniqueUrls(urls),
    markdown: realMarkdown(item.markdown) ?? text,
    citations: citations.filter(present),
    model: AI_ANSWER_MODEL_WEB,
    via: 'serp',
  }
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

/**
 * LLM Scraper（ChatGPT / Gemini，网页端真看到的回答）→ 回答 + 引用。
 * WP310：全文 markdown；正文段落里的来源 = `inline`，回答下面列的 `sources` = `listed`，
 * ChatGPT 搜到却没用上的 `search_results` = `searched`；模型名回包里有就带（没有写 `web`）。
 */
export function parseLlmScraper(result: Record<string, unknown> | undefined): ProviderAnswer {
  if (result === undefined) return { text: '', cited_urls: [] }
  const urls: (string | undefined)[] = []
  const inline: (ProviderCitation | undefined)[] = []
  const listed: (ProviderCitation | undefined)[] = []
  const searched: (ProviderCitation | undefined)[] = []
  for (const s of arr(result.sources).map(obj)) {
    urls.push(str(s.url))
    listed.push(citationOf(s, 'listed'))
  }
  for (const s of arr(result.search_results).map(obj)) {
    urls.push(str(s.url))
    searched.push(citationOf(s, 'searched'))
  }
  const fromItems: string[] = []
  for (const it of arr(result.items).map(obj)) {
    const t = str(it.markdown) ?? str(it.original_text) ?? str(it.text)
    if (t !== undefined) fromItems.push(t)
    for (const s of arr(it.sources).map(obj)) {
      urls.push(str(s.url))
      inline.push(citationOf(s, 'inline'))
    }
  }
  const text = str(result.markdown) ?? fromItems.join('\n')
  return {
    text,
    cited_urls: uniqueUrls(urls),
    ...(text === '' ? {} : { markdown: text }),
    citations: [...inline, ...listed, ...searched].filter(present),
    model: str(result.model) ?? AI_ANSWER_MODEL_WEB,
    via: 'web_ui',
  }
}

/**
 * LLM Responses（Claude / Perplexity，模型接口 + 联网）→ 回答 + 引用（Gemini 那一家的真网址在
 * `direct_url`，一起认）。WP310：标注都算 `inline`（模型接口只给正文里的标注），带标题与模型名。
 */
export function parseLlmResponses(result: Record<string, unknown> | undefined): ProviderAnswer {
  if (result === undefined) return { text: '', cited_urls: [] }
  const parts: string[] = []
  const urls: (string | undefined)[] = []
  const citations: (ProviderCitation | undefined)[] = []
  for (const it of arr(result.items).map(obj)) {
    if (it.type !== 'message') continue
    for (const sec of arr(it.sections).map(obj)) {
      const t = str(sec.text)
      if (t !== undefined) parts.push(t)
      for (const a of arr(sec.annotations).map(obj)) {
        const url = str(a.direct_url) ?? str(a.url)
        urls.push(url)
        citations.push(citationOf(a, 'inline', url))
      }
    }
  }
  const text = parts.join('\n')
  const model = str(result.model_name)
  return {
    text,
    cited_urls: uniqueUrls(urls),
    ...(text === '' ? {} : { markdown: text }),
    citations: citations.filter(present),
    ...(model === undefined ? {} : { model }),
    via: 'model_api',
  }
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
  // WP159（Luoye 09-27）：Perplexity 不再考虑——下面 `case 'perplexity'` 的代码留着，登记为不用
  // WP310（决策 460 / 461）：加 Claude（模型接口 + 强制联网；自带 key 那档也能用）
  platforms: ['chatgpt', 'gemini', 'google_ai_overview', 'claude'],
  unused_platforms: ['perplexity'],
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
      case 'claude': {
        // 决策 461：`web_search: true` 只是「允许」，模型常常不搜、于是没有引用——一定加 `force_web_search`
        // （借 open-seo）；输出上限 1024（省钱，回答够判提及与引用）
        const body = await post(
          '/ai_optimization/claude/llm_responses/live',
          {
            user_prompt: input.question.slice(0, 500),
            model_name: CLAUDE_GEO_MODEL,
            web_search: true,
            force_web_search: true,
            web_search_country_iso_code: input.country.toUpperCase(),
            max_output_tokens: CLAUDE_GEO_MAX_OUTPUT_TOKENS,
          },
          key,
          fetch,
          AI_ANSWER_TIMEOUT_MS,
        )
        return parseLlmResponses(taskOf(body).result)
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
