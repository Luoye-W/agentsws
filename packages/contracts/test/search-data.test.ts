/**
 * WP155：搜索数据契约里**在类型这一层就钉死**的几条。
 *
 * 最要紧的是第一条：WP154 在并行按派工单原样的字段名消费这份契约——
 * 这里拿一个「照派工单抄的对象」去满足类型，字段名一动 tsc 就红。
 */
import { describe, expect, it } from 'vitest'
import type {
  AiAnswerProbe,
  AiAnswerResult,
  SearchDataPort,
  SearchDataStatus,
  SerpItem,
  SerpQuery,
  SerpResult,
} from '../src/index.js'
import {
  AI_ANSWER_MAX_PLATFORMS,
  AI_PLATFORMS,
  SEARCH_AI_ANSWER_CAPABILITY,
  SEARCH_DATA_CLOUD_PATHS,
  SEARCH_DATA_CLOUD_PREFIX,
  SEARCH_DATA_PROVIDERS,
  SEARCH_ENGINES,
  SEARCH_SERP_CAPABILITY,
  SEARCH_SOURCE_OFFICIAL,
  searchSourceByo,
} from '../src/index.js'

describe('WP155 搜索数据契约', () => {
  it('派工单原样的字段名（WP154 按它消费）', () => {
    const q: SerpQuery = { query: 'x', engine: 'google', country: 'us', language: 'en' }
    const item: SerpItem = {
      position: 1,
      url: 'https://a.com/',
      domain: 'a.com',
      title: 't',
      type: 'organic',
    }
    const serp: SerpResult = {
      query: q,
      items: [item],
      ai_overview: { text: 't', cited_urls: [] },
      people_also_ask: ['q?'],
      fetched_at: '2026-09-26T00:00:00.000Z',
      source: SEARCH_SOURCE_OFFICIAL,
    }
    const probe: AiAnswerProbe = {
      question: 'q',
      platforms: ['chatgpt'],
      country: 'us',
      language: 'en',
      brand: { name: 'B', domains: ['b.com'] },
    }
    const answer: AiAnswerResult = {
      platform: 'chatgpt',
      answer_excerpt: '',
      brand_mentioned: false,
      our_domain_cited: false,
      cited_urls: [],
      competitors_mentioned: [],
      fetched_at: serp.fetched_at,
      source: 'official',
    }
    const status: SearchDataStatus = { configured: false, route: 'none', reason: '没接' }
    const port: SearchDataPort = {
      status: async () => status,
      serp: async () => serp,
      aiAnswers: async () => [answer],
    }
    expect(probe.platforms).toHaveLength(1)
    expect(typeof port.serp).toBe('function')
  })

  it('两个引擎、五个平台、三家可自带的服务商', () => {
    expect(SEARCH_ENGINES).toEqual(['google', 'bing'])
    expect(AI_PLATFORMS).toEqual([
      'chatgpt',
      'perplexity',
      'gemini',
      'google_ai_overview',
      'copilot',
    ])
    expect(AI_ANSWER_MAX_PLATFORMS).toBe(5)
    expect(SEARCH_DATA_PROVIDERS).toEqual(['dataforseo', 'serpapi', 'serper'])
  })

  it('计费能力与云端路径', () => {
    expect(SEARCH_SERP_CAPABILITY).toBe('data.search.serp')
    expect(SEARCH_AI_ANSWER_CAPABILITY).toBe('data.search.ai_answer')
    for (const p of Object.values(SEARCH_DATA_CLOUD_PATHS))
      expect(p.startsWith(SEARCH_DATA_CLOUD_PREFIX)).toBe(true)
  })

  it('官方那一侧的 source 不带服务商名；自带 key 的如实写', () => {
    expect(SEARCH_SOURCE_OFFICIAL).toBe('official')
    expect(searchSourceByo('serper')).toBe('byo:serper')
  })
})
