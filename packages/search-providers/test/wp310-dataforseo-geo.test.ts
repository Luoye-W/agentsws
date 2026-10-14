/**
 * WP310（docs/99 §7 O1 第 2 条）：DataForSEO 适配器加 Claude（模型接口 + 强制联网、上限 1024），
 * ChatGPT / Gemini / AI 概览带回**全文与结构化引用**。全用替身响应，不联网、不用真 key。
 */
import { describe, expect, it } from 'vitest'
import { analyzeAnswer, judgeAnswer } from '../src/analyze.js'
import { dataforseo } from '../src/providers/dataforseo.js'
import { fakeFetch, fixture } from './search-fakes.js'

const KEY = 'test-login:not-a-real-password'
const WATCH = {
  brand: { name: 'Voltbrick', aliases: ['Voltbrick 20K'], domains: ['voltbrick.com'] },
  competitors: [{ id: 'c_anker', name: 'Anker', aliases: ['MagGo'], domains: ['anker.com'] }],
}

describe('WP310 DataForSEO：三家 AI 都带回全文与引用', () => {
  it('Claude：LLM Responses、claude-sonnet-5、强制联网、上限 1024、按市场联网', async () => {
    expect(dataforseo.platforms).toContain('claude')
    expect(dataforseo.costKey('claude')).toBe('dataforseo:claude')
    const { fetch, calls } = fakeFetch([
      ['/ai_optimization/claude/llm_responses/live', { body: fixture('dataforseo-claude') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'best power bank for travel', country: 'gb', language: 'en', platform: 'claude' },
      KEY,
      fetch,
    )
    expect(calls[0]?.url).toBe(
      'https://api.dataforseo.com/v3/ai_optimization/claude/llm_responses/live',
    )
    expect(calls[0]?.body).toEqual([
      {
        user_prompt: 'best power bank for travel',
        model_name: 'claude-sonnet-5',
        web_search: true,
        force_web_search: true,
        web_search_country_iso_code: 'GB',
        max_output_tokens: 1024,
      },
    ])
    expect(out.model).toBe('claude-sonnet-5')
    expect(out.via).toBe('model_api')
    expect(out.markdown).toMatch(/Anker MagGo[\s\S]*airline limits/u)
    expect(out.citations?.map((c) => [c.where, c.title])).toEqual([
      ['inline', 'Best power banks 2026 - RTINGS'],
      ['inline', 'Voltbrick 20K review'],
      ['inline', 'r/onebag power bank thread'],
      ['inline', 'Best power banks 2026 - RTINGS'],
    ])

    // 判断那一层：全文 + 编号去重后的引用（RTINGS 带 utm 与不带的算同一页）、别名命中、名次
    const r = judgeAnswer(WATCH, 'claude', out, { fetched_at: 't', source: 'byo:dataforseo' })
    expect(r).toMatchObject({
      brand_mentioned: true,
      our_domain_cited: true,
      competitors_mentioned: ['Anker'],
      model: 'claude-sonnet-5',
      via: 'model_api',
    })
    expect(r.answer_markdown).toBe(out.markdown)
    expect(r.citations?.map((c) => c.domain)).toEqual(['rtings.com', 'voltbrick.com', 'reddit.com'])
    const a = analyzeAnswer(WATCH, { text: out.text, citations: out.citations })
    expect(a.citations.map((c) => c.site_kind)).toEqual(['media', 'ours', 'forum'])
    expect(a.mentions.map((m) => [m.entity, m.rank, m.alias_hit])).toEqual([
      ['ours', 2, 'Voltbrick 20K'],
      ['c_anker', 1, 'Anker'],
    ])
  })

  it('ChatGPT（网页端）：全文 markdown；正文来源 inline、下面列的 listed、搜到没用上的 searched', async () => {
    const { fetch } = fakeFetch([
      ['/chat_gpt/llm_scraper/live/advanced', { body: fixture('dataforseo-chatgpt-scraper') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'q', country: 'us', language: 'en', platform: 'chatgpt' },
      KEY,
      fetch,
    )
    expect(out.markdown).toMatch(/^Here are strong options:\n\n1\. \*\*Anker Nano\*\*/u)
    expect(out.markdown).toMatch(/Wirecutter also like these\.$/u)
    expect(out.via).toBe('web_ui')
    expect(out.model).toBe('gpt-4o')
    expect(out.citations?.map((c) => [c.where, c.url])).toEqual([
      ['inline', 'https://www.belkin.com/boostcharge/?utm_source=chatgpt.com'],
      ['listed', 'https://www.anker.com/products/nano?utm_source=chatgpt.com'],
      [
        'searched',
        'https://www.nytimes.com/wirecutter/reviews/best-portable-chargers/?utm_source=chatgpt.com',
      ],
    ])
    // 老字段照旧（兼容）
    expect(out.cited_urls).toHaveLength(3)
  })

  it('Gemini（网页端）：全文、来源带标题与摘要、模型名', async () => {
    const { fetch, calls } = fakeFetch([
      ['/gemini/llm_scraper/live/advanced', { body: fixture('dataforseo-gemini-scraper') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'best power bank for travel', country: 'us', language: 'en', platform: 'gemini' },
      KEY,
      fetch,
    )
    expect(calls[0]?.url).toContain('/v3/ai_optimization/gemini/llm_scraper/live/advanced')
    expect(out.markdown).toMatch(/^## Top travel power banks/u)
    expect(out.model).toBe('gemini-3-flash')
    expect(out.citations).toEqual([
      {
        url: 'https://www.youtube.com/watch?v=xyz&si=abc',
        title: 'YouTube review',
        where: 'inline',
      },
      {
        url: 'https://www.theverge.com/23300000/best-power-bank',
        title: 'The best power banks',
        snippet: 'We tested 40 power banks…',
        where: 'listed',
      },
      { url: 'https://voltbrick.com/products/20k/', title: 'Voltbrick 20K', where: 'listed' },
    ])
    const a = analyzeAnswer(WATCH, { text: out.text, citations: out.citations })
    expect(a.citations.map((c) => [c.url_norm, c.site_kind])).toEqual([
      ['https://youtube.com/watch?v=xyz', 'video'],
      ['https://theverge.com/23300000/best-power-bank', 'media'],
      ['https://voltbrick.com/products/20k', 'ours'],
    ])
  })

  it('Google AI 概览：元素里的引用 inline、整块顶层的 listed；占位 markdown 不当全文', async () => {
    const { fetch } = fakeFetch([
      ['/serp/google/organic/', { body: fixture('dataforseo-google-serp') }],
    ])
    const out = await dataforseo.aiAnswer(
      { question: 'q', country: 'us', language: 'en', platform: 'google_ai_overview' },
      KEY,
      fetch,
    )
    expect(out.via).toBe('serp')
    expect(out.model).toBe('web')
    expect(out.markdown).toBe(out.text)
    expect(out.citations?.map((c) => c.where)).toEqual(['inline', 'inline', 'listed'])
    expect(out.cited_urls).toHaveLength(2)
  })
})
