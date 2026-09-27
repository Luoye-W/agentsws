/**
 * WP155：SerpApi 适配器（只给「自带 key」那一档用——它的条款不许未经书面许可转售，
 * 做不了官方数据接口，docs/81 §1.5）。
 *
 * | 要什么 | 打哪个口（都是 `GET https://serpapi.com/search.json`） |
 * |---|---|
 * | SERP Google | `engine=google&q&gl&hl&device`；AI 概览只给了 `page_token` 时再打一次 `engine=google_ai_overview` |
 * | SERP Bing | `engine=bing&q&mkt=<语言>-<国家>&device` |
 * | AI 概览 | 同 Google SERP，取 `ai_overview` |
 * | Copilot | `engine=bing_copilot&q`（这个口没有地区参数） |
 * | ChatGPT / Perplexity / Gemini | **没有**（docs/81 §1.1） |
 *
 * 鉴权：`api_key` 查询参数（key 只在拼网址那一行出现；网址不进任何错误信息）。
 */
import type { SerpItem, SerpQuery } from '@agentsws/contracts'
import { domainOf, SearchDataError, uniqueUrls } from '../analyze.js'
import {
  AI_ANSWER_TIMEOUT_MS,
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

export const SERPAPI_BASE = 'https://serpapi.com'
const LABEL = 'SerpApi'

async function get(
  params: Record<string, string>,
  key: string,
  fetch: SearchFetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, api_key: key })
  const body = obj(
    await callProvider(
      fetch,
      `${SERPAPI_BASE}/search.json?${qs.toString()}`,
      { method: 'GET' },
      {
        key,
        timeoutMs,
        label: LABEL,
        errorText: (b) => str(obj(b).error),
      },
    ),
  )
  // 200 也可能是失败：`search_metadata.status === 'Error'`；而「没有结果」带着 error 却是正常回答
  const status = str(obj(body.search_metadata).status)
  if (status === 'Error')
    throw new SearchDataError('provider_error', `${LABEL}没答上来：${str(body.error) ?? ''}`)
  return body
}

/** `text_blocks`（段落 / 标题 / 列表，列表可以多层）→ 一段文字。 */
export function textOfBlocks(blocks: unknown): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    for (const b of arr(v).map(obj)) {
      const title = str(b.title)
      const snippet = str(b.snippet)
      if (title !== undefined && snippet !== undefined) out.push(`${title} ${snippet}`)
      else if (snippet !== undefined) out.push(snippet)
      else if (title !== undefined) out.push(title)
      walk(b.list)
      walk(b.text_blocks)
    }
  }
  walk(blocks)
  return out.join('\n')
}

/** `ai_overview` / Copilot 的回答 → 文字 + 引用。 */
export function answerOfBlocks(v: Record<string, unknown>, header?: string): ProviderAnswer {
  const text = [header, textOfBlocks(v.text_blocks)]
    .filter((x) => x !== undefined && x !== '')
    .join('\n')
  const urls = arr(v.references).map((r) => str(obj(r).link))
  return { text, cited_urls: uniqueUrls(urls) }
}

/** Google / Bing 一页结果 → 契约形状（AI 概览另外补）。 */
export function parseSerpApi(
  body: Record<string, unknown>,
): ProviderSerp & { ai_overview_token?: string } {
  const items: Omit<SerpItem, 'position'>[] = []
  const push = (type: SerpItem['type'], el: Record<string, unknown>, urlKey = 'link'): void => {
    const url = str(el[urlKey])
    if (url === undefined) return
    const snippet = str(el.snippet)
    items.push({
      url,
      domain: domainOf(url),
      title: str(el.title) ?? url,
      ...(snippet === undefined ? {} : { snippet }),
      type,
    })
  }
  for (const el of arr(body.organic_results).map(obj)) push('organic', el)
  for (const el of arr(body.inline_videos).map(obj)) push('video', el)
  for (const el of arr(body.shopping_results).map(obj)) push('shopping', el, 'product_link')
  for (const el of arr(body.discussions_and_forums).map(obj)) push('forum', el)
  const paa = arr(body.related_questions)
    .map((q) => str(obj(q).question))
    .filter((q): q is string => q !== undefined)
  const ao = obj(body.ai_overview)
  const token = str(ao.page_token)
  const overview = arr(ao.text_blocks).length > 0 ? answerOfBlocks(ao) : undefined
  return {
    items: renumber(items),
    ...(overview === undefined || overview.text === '' ? {} : { ai_overview: overview }),
    ...(paa.length === 0 ? {} : { people_also_ask: paa }),
    ...(token === undefined ? {} : { ai_overview_token: token }),
  }
}

function params(q: SerpQuery): Record<string, string> {
  const lang = q.language.split('-')[0] ?? q.language
  if (q.engine === 'bing')
    return {
      engine: 'bing',
      q: q.query,
      mkt: `${lang}-${q.country.toUpperCase()}`,
      device: q.device ?? 'desktop',
    }
  return {
    engine: 'google',
    q: q.query,
    gl: q.country,
    hl: q.language,
    device: q.device ?? 'desktop',
    num: '10',
  }
}

/** 查一页；AI 概览只给了 token 就马上再打一次（token 一分钟左右就过期）。 */
async function serpWithOverview(
  q: SerpQuery,
  key: string,
  fetch: SearchFetch,
  timeoutMs: number,
): Promise<ProviderSerp> {
  const { ai_overview_token, ...page } = parseSerpApi(await get(params(q), key, fetch, timeoutMs))
  if (ai_overview_token === undefined || page.ai_overview !== undefined) return page
  try {
    const more = await get(
      { engine: 'google_ai_overview', page_token: ai_overview_token },
      key,
      fetch,
      timeoutMs,
    )
    const overview = answerOfBlocks(obj(more.ai_overview))
    return overview.text === '' ? page : { ...page, ai_overview: overview }
  } catch {
    // AI 概览补不上不影响这一页结果
    return page
  }
}

export const serpapi: SearchProviderAdapter = {
  id: 'serpapi',
  engines: ['google', 'bing'],
  platforms: ['google_ai_overview', 'copilot'],
  serp: (q, key, fetch) => serpWithOverview(q, key, fetch, SERP_TIMEOUT_MS),
  async aiAnswer(input, key, fetch) {
    if (input.platform === 'copilot') {
      const body = await get(
        { engine: 'bing_copilot', q: input.question },
        key,
        fetch,
        AI_ANSWER_TIMEOUT_MS,
      )
      return answerOfBlocks(body, str(body.header))
    }
    if (input.platform === 'google_ai_overview') {
      const page = await serpWithOverview(
        {
          query: input.question,
          engine: 'google',
          country: input.country,
          language: input.language,
        },
        key,
        fetch,
        AI_ANSWER_TIMEOUT_MS,
      )
      return page.ai_overview ?? { text: '', cited_urls: [] }
    }
    throw new SearchDataError('unsupported', `${LABEL}探测不了这个平台。`)
  },
  async test(key, fetch) {
    // 账户口：不算搜索次数（出处未核实，见 docs/81 §3）
    await callProvider(
      fetch,
      `${SERPAPI_BASE}/account.json?${new URLSearchParams({ api_key: key }).toString()}`,
      { method: 'GET' },
      {
        key,
        timeoutMs: SERP_TIMEOUT_MS,
        label: LABEL,
        errorText: (b) => str(obj(b).error),
      },
    )
  },
  costKey: () => 'serpapi:search',
}
