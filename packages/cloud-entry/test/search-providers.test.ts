/**
 * WP155：三家适配器把**录好的替身响应**翻成契约形状（不联网、不用真 key）。
 *
 * 每家锁三件事：请求拼得对（地址 / 鉴权 / 地区语言）、响应翻得对、错误翻成契约码表
 * 且**错误信息里没有 key**。
 */
import { describe, expect, it } from 'vitest'
import { SearchDataError } from '../src/search/analyze.js'
import { dataforseo, languageCodeOf, locationNameOf } from '../src/search/providers/dataforseo.js'
import { searchProviderOf } from '../src/search/providers/index.js'
import { serpapi } from '../src/search/providers/serpapi.js'
import { serper } from '../src/search/providers/serper.js'
import { abortError, fakeFetch, fixture } from './search-fakes.js'

/** 一把假 key（不是任何真服务商的 key）。 */
const KEY = 'test-login:not-a-real-password'
const Q = {
  query: 'best portable charger',
  engine: 'google',
  country: 'us',
  language: 'en',
} as const

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(SearchDataError)
    return { code: (err as SearchDataError).code, message: (err as Error).message }
  }
  throw new Error('应该抛错')
}

describe('DataForSEO', () => {
  it('Google SERP：Basic 鉴权、国家名与语言、带异步 AI 概览；翻出结果 / AI 概览 / 大家还在问', async () => {
    const { fetch, calls } = fakeFetch([
      ['/serp/google/organic/live/advanced', { body: fixture('dataforseo-google-serp') }],
    ])
    const out = await dataforseo.serp(Q, KEY, fetch)
    expect(calls[0]?.url).toBe('https://api.dataforseo.com/v3/serp/google/organic/live/advanced')
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa(KEY)}`)
    expect(calls[0]?.body).toEqual([
      {
        keyword: 'best portable charger',
        location_name: 'United States',
        language_code: 'en',
        device: 'desktop',
        depth: 10,
        load_async_ai_overview: true,
      },
    ])
    expect(out.items.map((i) => [i.position, i.type, i.domain])).toEqual([
      [1, 'organic', 'nytimes.com'],
      [2, 'video', 'youtube.com'],
      [3, 'organic', 'voltbrick.com'],
      [4, 'shopping', 'amazon.com'],
      [5, 'forum', 'reddit.com'],
    ])
    expect(out.items[0]?.snippet).toMatch(/tested more than 100/)
    expect(out.ai_overview?.text).toMatch(/Voltbrick 20K/)
    expect(out.ai_overview?.cited_urls).toEqual([
      'https://www.voltbrick.com/blog/best-power-bank',
      'https://www.nytimes.com/wirecutter/reviews/best-portable-chargers/',
    ])
    expect(out.people_also_ask).toEqual([
      'Which power bank brand is best?',
      'Is 20000mAh too big for a flight?',
    ])
  })

  it('Bing SERP：不带 AI 概览那一格，照样认 ai_overview', async () => {
    const { fetch, calls } = fakeFetch([
      ['/serp/bing/organic/live/advanced', { body: fixture('dataforseo-bing-serp') }],
    ])
    const out = await dataforseo.serp({ ...Q, engine: 'bing', device: 'mobile' }, KEY, fetch)
    const body = (calls[0]?.body as Record<string, unknown>[] | undefined)?.[0]
    expect(body?.load_async_ai_overview).toBeUndefined()
    expect(body?.device).toBe('mobile')
    expect(out.items).toHaveLength(1)
    expect(out.ai_overview?.cited_urls).toEqual([
      'https://www.imdb.com/title/tt0076759/fullcredits',
    ])
  })

  it('ChatGPT（网页端抓取）：全文 markdown + 来源与搜索结果里的网址', async () => {
    const { fetch, calls } = fakeFetch([
      ['/chat_gpt/llm_scraper/live/advanced', { body: fixture('dataforseo-chatgpt-scraper') }],
    ])
    const out = await dataforseo.aiAnswer(
      {
        question: 'best portable charger for iphone',
        country: 'de',
        language: 'de',
        platform: 'chatgpt',
      },
      KEY,
      fetch,
    )
    expect(calls[0]?.body).toEqual([
      {
        keyword: 'best portable charger for iphone',
        location_name: 'Germany',
        language_code: 'de',
      },
    ])
    expect(out.text).toMatch(/Anker Nano/)
    expect(out.cited_urls).toContain('https://www.anker.com/products/nano?utm_source=chatgpt.com')
    expect(out.cited_urls).toContain('https://www.belkin.com/boostcharge/?utm_source=chatgpt.com')
  })

  it('Perplexity（sonar + 联网）：回答 + 标注里的网址；示例里 text 为 null 时是空回答', async () => {
    const { fetch, calls } = fakeFetch([
      ['/perplexity/llm_responses/live', { body: fixture('dataforseo-perplexity') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'q', country: 'us', language: 'en', platform: 'perplexity' },
      KEY,
      fetch,
    )
    expect(calls[0]?.body).toEqual([
      { user_prompt: 'q', model_name: 'sonar', web_search_country_iso_code: 'US' },
    ])
    expect(out.text).toMatch(/Voltbrick 20K/)
    expect(out.cited_urls).toEqual([
      'https://www.voltbrick.com/blog/20k-review',
      'https://www.anker.com/maggo',
    ])

    const empty = structuredClone(fixture('dataforseo-perplexity')) as {
      tasks: { result: { items: { sections: { text: unknown }[] }[] }[] }[]
    }
    const sec = empty.tasks[0]?.result[0]?.items[0]?.sections[0]
    if (sec !== undefined) sec.text = null
    const again = fakeFetch([['/perplexity/', { body: empty }]])
    expect(
      (
        await dataforseo.aiAnswer(
          { question: 'q', country: 'us', language: 'en', platform: 'perplexity' },
          KEY,
          again.fetch,
        )
      ).text,
    ).toBe('')
  })

  it('Google AI 概览这个「平台」= 一次 Google SERP 取概览那一块；Copilot 不认', async () => {
    const { fetch } = fakeFetch([
      ['/serp/google/organic/', { body: fixture('dataforseo-google-serp') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'q', country: 'us', language: 'en', platform: 'google_ai_overview' },
      KEY,
      fetch,
    )
    expect(out.cited_urls).toHaveLength(2)
    expect(dataforseo.platforms).not.toContain('copilot')
    expect(
      (
        await codeOf(
          dataforseo.aiAnswer(
            { question: 'q', country: 'us', language: 'en', platform: 'copilot' },
            KEY,
            fetch,
          ),
        )
      ).code,
    ).toBe('unsupported')
  })

  it('信封里的 40100 → unauthorized；HTTP 429 → rate_limited；超时 → timeout；信息里没有 key', async () => {
    const auth = fakeFetch([['/serp/', { body: fixture('dataforseo-auth-error') }]])
    const e1 = await codeOf(dataforseo.serp(Q, KEY, auth.fetch))
    expect(e1.code).toBe('unauthorized')
    const busy = fakeFetch([
      ['/serp/', { status: 429, body: { status_message: `slow down ${KEY}` } }],
    ])
    const e2 = await codeOf(dataforseo.serp(Q, KEY, busy.fetch))
    expect(e2.code).toBe('rate_limited')
    const slow = fakeFetch([['/serp/', abortError]])
    expect((await codeOf(dataforseo.serp(Q, KEY, slow.fetch))).code).toBe('timeout')
    for (const e of [e1, e2]) expect(e.message).not.toContain(KEY)
  })

  it('国家名与语言码', () => {
    expect(locationNameOf('gb')).toBe('United Kingdom')
    expect(locationNameOf('de')).toBe('Germany')
    expect(languageCodeOf('zh')).toBe('zh-CN')
    expect(languageCodeOf('zh-tw')).toBe('zh-TW')
    expect(languageCodeOf('en-gb')).toBe('en')
  })
})

describe('SerpApi', () => {
  it('Google：key 在查询串里；AI 概览只给了 token 就马上再打一次 google_ai_overview', async () => {
    const { fetch, calls } = fakeFetch([
      ['engine=google_ai_overview', { body: fixture('serpapi-ai-overview') }],
      ['engine=google', { body: fixture('serpapi-google') }],
    ])
    const out = await serpapi.serp({ ...Q, query: 'coffee' }, KEY, fetch)
    const first = new URL(calls[0]?.url ?? '')
    expect(first.pathname).toBe('/search.json')
    expect(Object.fromEntries(first.searchParams)).toEqual({
      engine: 'google',
      q: 'coffee',
      gl: 'us',
      hl: 'en',
      device: 'desktop',
      num: '10',
      api_key: KEY,
    })
    expect(new URL(calls[1]?.url ?? '').searchParams.get('page_token')).toBe(
      'rWmjgXictZPdkqI4FMcv90nWvWBUtO0e7',
    )
    expect(out.items.map((i) => i.type)).toEqual(['organic', 'organic', 'video', 'forum'])
    expect(out.people_also_ask).toEqual(['What coffee does to your body?'])
    expect(out.ai_overview?.text).toMatch(/Blue Bottle/)
    expect(out.ai_overview?.text).toMatch(/More caffeine/) // 列表里再嵌一层也收
    expect(out.ai_overview?.cited_urls).toEqual([
      'https://en.wikipedia.org/wiki/Coffee',
      'https://bluebottlecoffee.com/our-coffee',
    ])
  })

  it('AI 概览第二跳失败不影响这一页结果', async () => {
    const { fetch } = fakeFetch([
      ['engine=google_ai_overview', { status: 410, body: { error: 'expired' } }],
      ['engine=google', { body: fixture('serpapi-google') }],
    ])
    const out = await serpapi.serp(Q, KEY, fetch)
    expect(out.items).toHaveLength(4)
    expect(out.ai_overview).toBeUndefined()
  })

  it('Bing：语言 + 国家拼成 mkt', async () => {
    const { fetch, calls } = fakeFetch([['engine=bing', { body: fixture('serpapi-bing') }]])
    const out = await serpapi.serp({ ...Q, engine: 'bing', country: 'gb' }, KEY, fetch)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('mkt')).toBe('en-GB')
    expect(out.items[0]?.domain).toBe('zmenu.com')
  })

  it('Copilot：header + 段落 + 引用', async () => {
    const { fetch } = fakeFetch([['engine=bing_copilot', { body: fixture('serpapi-copilot') }]])
    const out = await serpapi.aiAnswer(
      {
        question: 'best power bank for iphone',
        country: 'us',
        language: 'en',
        platform: 'copilot',
      },
      KEY,
      fetch,
    )
    expect(out.text).toMatch(/^Popular picks/)
    expect(out.text).toMatch(/Wirecutter rates/)
    expect(out.cited_urls).toEqual([
      'https://www.nytimes.com/wirecutter/reviews/best-portable-chargers/',
      'https://www.anker.com/maggo',
    ])
    expect(
      (
        await codeOf(
          serpapi.aiAnswer(
            { question: 'q', country: 'us', language: 'en', platform: 'chatgpt' },
            KEY,
            fetch,
          ),
        )
      ).code,
    ).toBe('unsupported')
  })

  it('「没有结果」带着 error 但状态是 Success：是空结果不是失败；401 翻成 unauthorized、不带 key', async () => {
    const empty = fakeFetch([
      [
        'engine=google',
        {
          body: {
            search_metadata: { status: 'Success' },
            search_information: { organic_results_state: 'Fully empty' },
            error: "Google hasn't returned any results for this query.",
          },
        },
      ],
    ])
    expect((await serpapi.serp(Q, KEY, empty.fetch)).items).toEqual([])
    const bad = fakeFetch([
      ['engine=google', { status: 401, body: { error: `Invalid API key ${KEY}` } }],
    ])
    const e = await codeOf(serpapi.serp(Q, KEY, bad.fetch))
    expect(e.code).toBe('unauthorized')
    expect(e.message).not.toContain(KEY)
  })
})

describe('Serper', () => {
  it('只查 Google：X-API-KEY 头、gl / hl；翻出结果与大家还在问；没有 AI 平台', async () => {
    const { fetch, calls } = fakeFetch([
      ['google.serper.dev/search', { body: fixture('serper-search') }],
    ])
    const out = await serper.serp(Q, KEY, fetch)
    expect(calls[0]?.headers['x-api-key']).toBe(KEY)
    expect(calls[0]?.body).toEqual({ q: 'best portable charger', gl: 'us', hl: 'en', num: 10 })
    expect(out.items.map((i) => i.domain)).toEqual(['google.com', 'google.com'])
    expect(out.people_also_ask).toEqual(['How do I get Google to search?'])
    expect(serper.platforms).toEqual([])
    expect((await codeOf(serper.serp({ ...Q, engine: 'bing' }, KEY, fetch))).code).toBe(
      'unsupported',
    )
  })
})

describe('登记处', () => {
  it('三家都在；认不出的名字回 undefined（不猜）', () => {
    expect(searchProviderOf('dataforseo')?.id).toBe('dataforseo')
    expect(searchProviderOf('serpapi')?.id).toBe('serpapi')
    expect(searchProviderOf('serper')?.id).toBe('serper')
    expect(searchProviderOf('toString')).toBeUndefined()
    expect(searchProviderOf('nope')).toBeUndefined()
  })
})
