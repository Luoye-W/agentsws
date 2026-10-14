/**
 * WP310（docs/99 §7 O1）：GEO 契约只加不删——Claude、全文与引用、关注设置、回答历史的形状。
 * 每个形状都拿一个「照 docs/99 §5.5 抄的对象」去满足类型，再过一遍 JSON（存进 SQLite /
 * 走 HTTP 都是 JSON），回来必须一模一样。
 */
import { describe, expect, it } from 'vitest'
import type {
  AiAnswerDataItem,
  AiAnswerResult,
  BrandWatch,
  GeoAnswerRecord,
  GeoCitationRecord,
  GeoHistoryExport,
  GeoMentionRecord,
  GeoQuestion,
  SeoBrandGscWeek,
  SeoRankCheckItem,
  SeoRankSnapshot,
  WatchRun,
} from '../src/index.js'
import {
  AI_CITATION_WHERE,
  AI_PLATFORMS,
  AI_PLATFORMS_PRICED_SEPARATELY,
  BRAND_WATCH_DEFAULT_PLATFORMS,
  CLAUDE_GEO_MAX_OUTPUT_TOKENS,
  CLAUDE_GEO_MODEL,
  dataCapabilitySpec,
  GEO_DEFAULT_PLATFORMS,
  GEO_PROMPT_DEFAULT_SELECTED,
  GEO_PROMPT_TIERS,
  GEO_PROMPT_TOPICS,
  normalizeDataInput,
  RANK_CHECK_DEFAULT_DEVICE,
  RANK_CHECK_DEPTH,
} from '../src/index.js'

const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const AT = '2026-10-12T08:30:00.000Z'

describe('WP310 契约：Claude 与全文 / 引用', () => {
  it('claude 只加在末尾；关注设置默认四个 AI，现有每周探测默认不变', () => {
    expect(AI_PLATFORMS.at(-1)).toBe('claude')
    expect(BRAND_WATCH_DEFAULT_PLATFORMS).toEqual([
      'chatgpt',
      'gemini',
      'claude',
      'google_ai_overview',
    ])
    expect(GEO_DEFAULT_PLATFORMS).not.toContain('claude')
    expect(AI_PLATFORMS_PRICED_SEPARATELY).toEqual(['claude'])
    expect(CLAUDE_GEO_MODEL).toBe('claude-sonnet-5')
    expect(CLAUDE_GEO_MAX_OUTPUT_TOKENS).toBe(1024)
    expect(AI_CITATION_WHERE).toEqual(['inline', 'listed', 'searched'])
  })

  it('AiAnswerResult 老字段不动，新字段全是可选；JSON 来回不丢', () => {
    const old: AiAnswerResult = {
      platform: 'chatgpt',
      answer_excerpt: 'x',
      brand_mentioned: false,
      our_domain_cited: false,
      cited_urls: [],
      competitors_mentioned: [],
      fetched_at: AT,
      source: 'official',
    }
    const full: AiAnswerResult = {
      ...old,
      platform: 'claude',
      answer_markdown: '## Best\n\n1. **Voltbrick** …',
      citations: [
        {
          position: 1,
          url: 'https://www.reddit.com/r/x/1?utm_source=a',
          domain: 'reddit.com',
          title: 'Thread',
          where: 'inline',
        },
      ],
      model: 'claude-sonnet-5',
      via: 'model_api',
    }
    expect(roundtrip(old)).toEqual(old)
    expect(roundtrip(full)).toEqual(full)
  })

  it('能力目录：ai_answer.claude（同步按次）与 seo.rank_check（异步按词，≤ 100）', () => {
    const claude = dataCapabilitySpec('ai_answer.claude')
    expect(claude?.mode).toBe('sync')
    expect(claude?.unit).toBe('call')
    expect(claude?.input.map((f) => f.name)).toEqual(['question', 'country', 'language'])
    const rank = dataCapabilitySpec('seo.rank_check')
    if (rank === undefined) throw new Error('缺 seo.rank_check')
    expect(rank.mode).toBe('async')
    expect(rank.unit).toBe('item')
    expect(rank.max_items).toBe(100)
    const n = normalizeDataInput(rank, {
      keywords: ['voltbrick power bank', 'best power bank'],
      country: 'us',
      language: 'en',
      device: 'mobile',
      evil: 1,
    })
    expect(n.ok).toBe(true)
    if (n.ok)
      expect(Object.keys(n.input).sort()).toEqual(['country', 'device', 'keywords', 'language'])
    expect(RANK_CHECK_DEPTH).toBe(20)
    expect(RANK_CHECK_DEFAULT_DEVICE).toBe('mobile')
  })

  it('云端结果形状（给 WP309 对齐）：AiAnswerDataItem / SeoRankCheckItem', () => {
    const item: AiAnswerDataItem = {
      platform: 'claude',
      text: 'Voltbrick is …',
      cited_urls: ['https://voltbrick.com/'],
      answer_markdown: 'Voltbrick is …',
      citations: [
        { position: 1, url: 'https://voltbrick.com/', domain: 'voltbrick.com', where: 'inline' },
      ],
      model: 'claude-sonnet-5',
      via: 'model_api',
      no_citations: false,
    }
    const rank: SeoRankCheckItem = {
      keyword: 'best power bank',
      country: 'us',
      language: 'en',
      device: 'mobile',
      organic: [{ rank: 1, url: 'https://a.com/', domain: 'a.com', title: 'A' }],
      features: { ai_overview: true, people_also_ask: false, shopping: true, video: false },
      ai_overview: { text: 'Top picks …', citations: [] },
      fetched_at: AT,
    }
    expect(roundtrip(item)).toEqual(item)
    expect(roundtrip(rank)).toEqual(rank)
  })
})

describe('WP310 契约：关注设置与回答历史', () => {
  it('方向八个、默认选 5、档位 5 / 10 / 20', () => {
    expect(GEO_PROMPT_TOPICS.map((t) => t.id)).toEqual([
      'category',
      'buying_guide',
      'comparison',
      'use_case',
      'price_value',
      'reviews',
      'branded',
      'other',
    ])
    expect(GEO_PROMPT_DEFAULT_SELECTED).toBe(5)
    expect(GEO_PROMPT_TIERS).toEqual([5, 10, 20])
  })

  it('老的 GeoQuestion 照样合法；新字段可选', () => {
    const old: GeoQuestion = { id: 'gq_1', text: 'Is X worth it?', origin: 'brand', enabled: true }
    const neu: GeoQuestion = {
      id: 'gp_2',
      text: 'What is the best power bank for travel?',
      origin: 'ai_suggest',
      enabled: true,
      topic: 'use_case',
      branded: false,
      selected: true,
      archived_at: AT,
    }
    expect(roundtrip(old)).toEqual(old)
    expect(roundtrip(neu)).toEqual(neu)
  })

  it('BrandWatch 与历史表的每一行、导出包：JSON 来回不丢', () => {
    const watch: BrandWatch = {
      brand: { name: 'Voltbrick', aliases: ['VB', 'Volt Brick'], domains: ['voltbrick.com'] },
      competitors: [{ id: 'c_anker', name: 'Anker', aliases: [], domains: ['anker.com'] }],
      prompt_candidates: [
        {
          id: 'gp_c',
          text: 'Which power bank brand is best?',
          origin: 'ai_suggest',
          enabled: true,
          topic: 'category',
          branded: false,
          selected: false,
        },
      ],
      prompts: [
        {
          id: 'gp_s',
          text: 'Is Voltbrick worth it?',
          origin: 'brand',
          enabled: true,
          topic: 'branded',
          branded: true,
          selected: true,
        },
      ],
      prompt_limit: 5,
      prompt_cap: 20,
      keywords: [{ keyword: 'voltbrick', branded: true, enabled: true }],
      markets: ['US'],
      platforms: ['chatgpt', 'gemini', 'claude', 'google_ai_overview'],
      frequency: 'weekly',
      rank_device: 'mobile',
      enabled: true,
      updated_at: AT,
    }
    const run: WatchRun = {
      id: 'wr_1',
      kind: 'geo',
      trigger: 'scheduled',
      period: '2026-10-12',
      status: 'done',
      planned: 4,
      answered: 3,
      credits: 4.2,
      started_at: AT,
      finished_at: AT,
    }
    const answer: GeoAnswerRecord = {
      id: 'ga_1',
      run_id: 'wr_1',
      prompt_id: 'gp_s',
      prompt_text: 'Is Voltbrick worth it?',
      asked_text: 'Is Voltbrick worth it?',
      platform: 'claude',
      model: 'claude-sonnet-5',
      via: 'model_api',
      market: 'US',
      language: 'en',
      status: 'ok',
      answer_md: 'Yes …',
      answer_hash: 'h',
      fetched_at: AT,
      credits: 3.6,
    }
    const cit: GeoCitationRecord = {
      answer_id: 'ga_1',
      position: 1,
      url: 'https://www.reddit.com/r/x/?utm_source=a',
      url_norm: 'https://reddit.com/r/x',
      domain: 'reddit.com',
      where: 'inline',
      site_kind: 'forum',
    }
    const men: GeoMentionRecord = {
      answer_id: 'ga_1',
      entity: 'ours',
      name_snapshot: 'Voltbrick',
      alias_hit: 'Voltbrick',
      mentioned: true,
      cited: false,
      first_offset: 0,
      rank: 1,
      rules_version: 1,
    }
    const rank: SeoRankSnapshot = {
      run_id: 'wr_2',
      keyword: 'voltbrick',
      market: 'US',
      device: 'mobile',
      rank: 1,
      url: 'https://voltbrick.com/',
      serp_features: { ai_overview: false, people_also_ask: true, shopping: false, video: false },
      aio_mentions_us: false,
      aio_cites_us: false,
      fetched_at: AT,
    }
    const gsc: SeoBrandGscWeek = {
      week: '2026-10-05',
      query: 'voltbrick',
      impressions: 120,
      clicks: 30,
      position: 1.4,
      fetched_at: AT,
    }
    const exp: GeoHistoryExport = {
      format: 'json',
      exported_at: AT,
      tables: {
        watch,
        runs: [run],
        answers: [answer],
        citations: [cit],
        mentions: [men],
        ranks: [rank],
        brand_gsc: [gsc],
      },
    }
    expect(roundtrip(exp)).toEqual(exp)
  })
})
