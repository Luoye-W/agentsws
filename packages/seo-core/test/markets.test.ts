/**
 * WP166：每日判断里的搜索结果页人群核对按**每个目标市场分别看**。
 *
 * 钉住：有一个市场人群对就能写（选题卡带着每个市场的结论）；每个市场都不对才划掉（写明哪国为什么）；
 * 次数上限按市场乘；所有市场都在面板上关了就不看；只给一个市场时与原来一样。
 */
import type { SearchDataPort, SerpItem, SerpQuery } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildDaily,
  DEMO_BRAND_TERMS,
  DEMO_GSC_ROWS,
  DEMO_OUR_DOMAINS,
  DEMO_PAGES,
  MAX_SERP_CHECKS_PER_DAY,
  marketName,
  NOTE_MARKETS_OFF,
  probeRows,
} from '../src/index.js'

const base = {
  pages: DEMO_PAGES,
  signals: { brand_terms: DEMO_BRAND_TERMS },
  country: 'us',
  language: 'en',
  our_domains: DEMO_OUR_DOMAINS,
  date: '2026-09-27',
}

const WRONG: SerpItem[] = [
  {
    position: 1,
    url: 'https://en.wikipedia.org/wiki/GaN',
    domain: 'en.wikipedia.org',
    title: 'Gallium nitride - Wikipedia',
    type: 'organic',
  },
  {
    position: 2,
    url: 'https://jobs.example/gan',
    domain: 'jobs.example',
    title: 'GaN engineer jobs',
    type: 'organic',
  },
]
const RIGHT: SerpItem[] = [
  {
    position: 1,
    url: 'https://r.example/best',
    domain: 'r.example',
    title: 'Best USB-C charger',
    type: 'organic',
  },
  {
    position: 2,
    url: 'https://shopping.example/p',
    domain: 'shopping.example',
    title: '65W charger',
    type: 'shopping',
  },
  {
    position: 3,
    url: 'https://www.reddit.com/r/UsbCHardware/x',
    domain: 'reddit.com',
    title: 'Which charger for my laptop?',
    type: 'forum',
  },
]

/** 按国家回不同的搜索结果页（`right` 里列的国家人群对，其余不对）。 */
function byCountry(right: readonly string[]): SearchDataPort & { calls: SerpQuery[] } {
  const calls: SerpQuery[] = []
  return {
    calls,
    status: async () => ({ configured: true, route: 'official' }),
    serp: async (q) => {
      calls.push(q)
      return {
        query: q,
        items: right.includes(q.country) ? RIGHT : WRONG,
        fetched_at: '2026-09-27T00:00:00Z',
        source: 'stand-in',
      }
    },
    aiAnswers: async () => [],
  }
}

describe('WP166 · 搜索结果页人群核对按市场分别看', () => {
  it('英国人群对、美国不对：照样出选题，带着两个市场各自的结论', async () => {
    const search = byCountry(['gb'])
    const out = await buildDaily({
      ...base,
      rows: DEMO_GSC_ROWS,
      search,
      countries: ['us', 'gb'],
    })
    const checked = out.picks.find((p) => p.serp_check !== undefined)
    expect(checked?.serp_check?.market).toBe('GB')
    expect(checked?.serp_markets?.map((c) => [c.market, c.right_crowd])).toEqual([
      ['US', false],
      ['GB', true],
    ])
    // 每个词都按两个市场各查一次
    expect(new Set(search.calls.map((c) => c.country))).toEqual(new Set(['us', 'gb']))
  })

  it('每个市场都不对才划掉，写明哪国为什么', async () => {
    const out = await buildDaily({
      ...base,
      rows: DEMO_GSC_ROWS,
      search: byCountry([]),
      countries: ['us', 'gb'],
    })
    const killed = out.notes.find((n) => n.includes('美国：') && n.includes('英国：'))
    expect(killed).toBeDefined()
  })

  it('次数上限按市场乘；每个市场都在面板上关了就不看', async () => {
    expect(MAX_SERP_CHECKS_PER_DAY).toBe(5)
    const off = byCountry(['us'])
    const out = await buildDaily({ ...base, rows: DEMO_GSC_ROWS, search: off, countries: [] })
    expect(off.calls).toHaveLength(0)
    expect(out.picks.some((p) => p.serp_skipped === NOTE_MARKETS_OFF)).toBe(true)
  })

  it('只给一个市场：结论里也标上市场，但不写 serp_markets', async () => {
    const out = await buildDaily({
      ...base,
      rows: DEMO_GSC_ROWS,
      search: byCountry(['de']),
      countries: ['de'],
    })
    const checked = out.picks.find((p) => p.serp_check !== undefined)
    expect(checked?.serp_check?.market).toBe('DE')
    expect(checked?.serp_markets).toBeUndefined()
  })

  it('AI 探测的行标上市场；国名默认中文', () => {
    const rows = probeRows(
      'best charger?',
      [
        {
          platform: 'chatgpt',
          answer_excerpt: '',
          brand_mentioned: true,
          our_domain_cited: false,
          cited_urls: [],
          competitors_mentioned: [],
          fetched_at: '',
          source: 'stand-in',
        },
      ],
      'gb',
    )
    expect(rows[0]?.market).toBe('GB')
    expect(marketName('GB')).toBe('英国')
    expect(marketName('GB', 'en')).toBe('United Kingdom')
  })
})

describe('WP169 · SERP 的 language 按市场', () => {
  it('给了每个市场的语言就按它查；没给到的市场用品牌语言', async () => {
    const search = byCountry(['gb'])
    await buildDaily({
      ...base,
      rows: DEMO_GSC_ROWS,
      search,
      countries: ['us', 'de', 'jp'],
      languages: { de: 'de', jp: 'ja' },
    })
    expect(search.calls.length).toBeGreaterThan(0)
    for (const q of search.calls)
      expect(q.language).toBe({ us: 'en', de: 'de', jp: 'ja' }[q.country] ?? '?')
  })
})
