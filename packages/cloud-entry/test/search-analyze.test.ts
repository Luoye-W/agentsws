/** WP155：服务商无关的判断与校验（纯函数）。 */
import { describe, expect, it } from 'vitest'
import {
  domainMatches,
  domainOf,
  excerptOf,
  judgeAnswer,
  mentions,
  normalizeProbe,
  normalizeSerpQuery,
  redact,
  SearchDataError,
} from '../src/search/analyze.js'
import { MemorySearchCache } from '../src/search/cache.js'

describe('判断「提没提到」', () => {
  it('拉丁名字按词找；中文按子串；大小写不敏感', () => {
    expect(mentions('Try the ANKER Nano.', 'Anker')).toBe(true)
    expect(mentions('Ankerite is a mineral', 'Anker')).toBe(false)
    expect(mentions('推荐沃特砖 20K 充电宝', '沃特砖')).toBe(true)
    expect(mentions('', 'Anker')).toBe(false)
  })

  it('域名：认子域名，不认后缀撞上的别家；网址里带 www / 路径也认', () => {
    expect(domainOf('https://www.Shop.Example.com/a')).toBe('shop.example.com')
    expect(domainMatches('shop.example.com', 'example.com')).toBe(true)
    expect(domainMatches('notexample.com', 'example.com')).toBe(false)
    expect(domainMatches('example.com', 'https://www.example.com/')).toBe(true)
  })

  it('judgeAnswer：品牌名或域名出现在正文算提到；引用里有我们的域名算被引用；竞品只认给了的名单', () => {
    const r = judgeAnswer(
      {
        brand: { name: 'Voltbrick', domains: ['voltbrick.com'] },
        competitors: [{ name: 'Anker', domains: ['anker.com'] }, { name: 'Mophie' }],
      },
      'chatgpt',
      {
        text: 'See voltbrick.com for details. Mophie is fine too.',
        cited_urls: ['https://www.anker.com/x', 'https://www.anker.com/x', 'ftp://bad'],
      },
      { fetched_at: 't', source: 'official' },
    )
    expect(r).toMatchObject({
      brand_mentioned: true,
      our_domain_cited: false,
      competitors_mentioned: ['Anker', 'Mophie'],
      cited_urls: ['https://www.anker.com/x'],
    })
    const none = judgeAnswer(
      { brand: { name: 'X', domains: [] } },
      'gemini',
      { text: 'y', cited_urls: [] },
      { fetched_at: 't', source: 's' },
    )
    expect(none.competitors_mentioned).toEqual([])
  })

  it('节选压空白、按字符截', () => {
    expect(excerptOf('a\n\n b', 10)).toBe('a b')
    expect(excerptOf('一二三四五六', 4)).toBe('一二三…')
  })
})

describe('输入校验', () => {
  it('SERP：小写、去空白；国家两位字母、引擎只认两个', () => {
    expect(
      normalizeSerpQuery({
        query: ' Hi ',
        engine: 'Google',
        country: 'US',
        language: 'EN',
        device: 'mobile',
      }),
    ).toEqual({
      query: 'Hi',
      engine: 'google',
      country: 'us',
      language: 'en',
      device: 'mobile',
    })
    for (const bad of [
      { query: '' },
      { query: 'x', engine: 'yahoo', country: 'us', language: 'en' },
      { query: 'x', engine: 'bing', country: 'usa', language: 'en' },
    ])
      expect(() => normalizeSerpQuery(bad)).toThrow(SearchDataError)
  })

  it('AI 探测：平台去重保序、丢认不出的；没有品牌名不行', () => {
    const p = normalizeProbe({
      question: 'q',
      platforms: ['gemini', 'nope', 'gemini', 'chatgpt'],
      country: 'de',
      language: 'de',
      brand: { name: 'B', domains: ['b.com', 3] },
    })
    expect(p.platforms).toEqual(['gemini', 'chatgpt'])
    expect(p.brand.domains).toEqual(['b.com'])
    expect(() =>
      normalizeProbe({
        question: 'q',
        platforms: ['gemini'],
        country: 'de',
        language: 'de',
        brand: {},
      }),
    ).toThrow(/品牌名/)
  })

  it('redact 抹掉 key', () => {
    expect(redact('bad key abcd1234 here', 'abcd1234')).toBe('bad key *** here')
  })
})

describe('缓存', () => {
  it('过期即失效；超出上限挤掉最久没用的', () => {
    const c = new MemorySearchCache(2)
    c.put('a', 1, 0, 100)
    c.put('b', 2, 0, 100)
    c.get('a', 10)
    c.put('c', 3, 10, 100)
    expect(c.get('b', 20)).toBeUndefined()
    expect(c.get('a', 20)).toBe(1)
    expect(c.get('a', 200)).toBeUndefined()
  })
})
