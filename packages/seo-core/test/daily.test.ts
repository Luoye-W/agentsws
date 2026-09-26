/**
 * WP154 §2 / §3：六个信号 → 今天值得动的 5 件事（先修再写、不倾倒数据、没接搜索数据照跑）。
 */
import type { SerpItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildDaily,
  DEMO_BRAND_TERMS,
  DEMO_GSC_ROWS,
  DEMO_OUR_DOMAINS,
  DEMO_PAGES,
  detectSignals,
  isBrandQuery,
  LANE_ORDER,
  NOTE_GSC_MISSING,
  NOTE_SEARCH_DATA_MISSING,
  queryIntent,
  standInSearchData,
  unconfiguredSearchData,
  wordCount,
} from '../src/index.js'

const base = {
  pages: DEMO_PAGES,
  signals: { brand_terms: DEMO_BRAND_TERMS },
  country: 'de',
  language: 'en',
  our_domains: DEMO_OUR_DOMAINS,
  date: '2026-09-26',
}

describe('六个信号（文章第 1 步，只算这六个）', () => {
  it('每一行按阈值判；噪声行一个都不响', () => {
    const hits = detectSignals(DEMO_GSC_ROWS, DEMO_PAGES, { brand_terms: DEMO_BRAND_TERMS })
    const of = (q: string) =>
      hits
        .filter((h) => h.row.query === q)
        .map((h) => h.signal)
        .sort()
    expect(of('usb c laptop charger')).toEqual(['almost_there', 'no_clicks', 'untargeted'])
    expect(of('braided cable care')).toEqual(['decaying'])
    expect(of('gan vs silicon charger')).toContain('wrong_intent')
    expect(of('what charger do i need for a macbook pro 16 inch')).toEqual(['ai_mode'])
    // 品牌词、排在第 35 位的短词、稳居第 1.8 的强页：什么都不响
    expect(of('nordvolt charger')).toEqual([])
    expect(of('usb c cable')).toEqual([])
    expect(of('best magsafe car mount')).toEqual([])
  })

  it('词数：英文按空格，中文按分词', () => {
    expect(wordCount('what charger do i need for a macbook pro 16 inch')).toBe(11)
    expect(wordCount('充电宝推荐')).toBeLessThan(5)
  })

  it('意图与品牌词', () => {
    expect(queryIntent('gan vs silicon charger')).toBe('comparison')
    expect(queryIntent('usb c charger wattage calculator')).toBe('pricing')
    expect(queryIntent('充电头多少钱')).toBe('pricing')
    expect(isBrandQuery('NordVolt charger', ['nordvolt'])).toBe(true)
  })
})

describe('每日 5 件事', () => {
  it('恰好 5 件，先修再写：改页 → 交建站 → 新页面', async () => {
    const out = await buildDaily({ ...base, rows: DEMO_GSC_ROWS, search: unconfiguredSearchData() })
    expect(out.gsc).toBe('connected')
    expect(out.picks).toHaveLength(5)
    expect(out.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5])
    const lanes = out.picks.map((p) => LANE_ORDER[p.lane])
    expect([...lanes].sort((a, b) => a - b)).toEqual(lanes)
    expect(out.picks.map((p) => [p.query, p.lane, p.fix ?? null])).toEqual([
      ['usb c laptop charger', 'fix_page', 'page_seo_edit'],
      ['braided cable care', 'fix_page', 'page_section_add'],
      ['how to choose a usb c charger', 'fix_page', 'internal_link_edit'],
      ['travel adapter guide europe', 'site_handoff', null],
      ['gan vs silicon charger', 'new_page', null],
    ])
    // 内链从点击最多的那页链出去
    expect(out.picks[2]?.link_from).toBe('https://shop.example/blogs/guide/best-magsafe-car-mount')
  })

  it('每件都带证据数字与建议；只报信号命中数，不列行', async () => {
    const out = await buildDaily({ ...base, rows: DEMO_GSC_ROWS, search: unconfiguredSearchData() })
    for (const p of out.picks) {
      expect(p.evidence.impressions).toBeGreaterThan(0)
      expect(p.suggestion).toContain(p.query)
    }
    expect(Object.keys(out.signal_counts).sort()).toEqual(
      ['ai_mode', 'almost_there', 'decaying', 'no_clicks', 'untargeted', 'wrong_intent'].sort(),
    )
    expect(JSON.stringify(out)).not.toContain('nordvolt charger')
  })

  it('没接搜索数据接口：新页面那件留在卡上、写明跳过，一次都不查', async () => {
    const out = await buildDaily({ ...base, rows: DEMO_GSC_ROWS, search: unconfiguredSearchData() })
    expect(out.search_data).toBe('not_configured')
    expect(out.picks[4]?.serp_skipped).toBe('搜索数据接口还没接')
    expect(out.notes).toContain(NOTE_SEARCH_DATA_MISSING)
  })

  it('接了搜索数据：人群不对的词划掉，下一件补上', async () => {
    const wrong: SerpItem[] = [
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
    const right: SerpItem[] = [
      {
        position: 1,
        url: 'https://r.example/best',
        domain: 'r.example',
        title: 'Best USB-C charger wattage calculator',
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
    const search = standInSearchData({
      serp: {
        'gan vs silicon charger': {
          items: wrong,
          fetched_at: '2026-09-26T00:00:00Z',
          source: 'stand-in',
        },
        'usb c charger wattage calculator': {
          items: right,
          fetched_at: '2026-09-26T00:00:00Z',
          source: 'stand-in',
        },
      },
    })
    const out = await buildDaily({ ...base, rows: DEMO_GSC_ROWS, search })
    expect(out.picks).toHaveLength(5)
    expect(out.picks[4]?.query).toBe('usb c charger wattage calculator')
    expect(out.picks[4]?.serp_check?.right_crowd).toBe(true)
    expect(out.notes.some((n) => n.includes('gan vs silicon charger') && n.includes('不写'))).toBe(
      true,
    )
    expect(search.calls.map((c) => c.key)).toEqual([
      'gan vs silicon charger',
      'usb c charger wattage calculator',
    ])
  })

  it('没连 Search Console：一件都不出，明说「接上才看得到」', async () => {
    const out = await buildDaily({ ...base, rows: undefined, search: unconfiguredSearchData() })
    expect(out.gsc).toBe('not_connected')
    expect(out.picks).toEqual([])
    expect(out.notes).toEqual([NOTE_GSC_MISSING])
  })

  it('一个信号都不响：不硬凑', async () => {
    const out = await buildDaily({
      ...base,
      rows: DEMO_GSC_ROWS.filter((r) => r.query === 'nordvolt charger'),
      search: unconfiguredSearchData(),
    })
    expect(out.picks).toEqual([])
    expect(out.notes[0]).toContain('不硬凑')
  })
})
