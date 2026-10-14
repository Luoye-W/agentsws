/** WP310（docs/99 §5.3 / §5.5）：别名、首次出现位置与名次、竞品、网址归一、引用归类（纯函数）。 */
import { describe, expect, it } from 'vitest'
import {
  analyzeAnswer,
  builtinSiteKind,
  citationsOf,
  firstDomainMention,
  firstMention,
  GEO_RULES_VERSION,
  judgeAnswer,
  matchEntities,
  normalizeProbe,
  normalizeUrl,
  prepareAnswerText,
  siteKindOf,
} from '../src/index.js'

const WATCH = {
  brand: { name: 'Voltbrick', aliases: ['VB 20K', 'Volt Brick'], domains: ['voltbrick.com'] },
  competitors: [
    { id: 'c_anker', name: 'Anker', aliases: ['MagGo'], domains: ['anker.com'] },
    { id: 'c_mophie', name: 'Mophie', domains: ['mophie.com'] },
    { id: 'c_belkin', name: 'Belkin', domains: ['belkin.com'] },
  ],
}

describe('网址归一 url_norm', () => {
  it('去跟踪参数、www、尾斜杠、#；协议统一 https；剩下的参数排序', () => {
    expect(
      normalizeUrl(
        'http://WWW.Reddit.com/r/x/comments/1/?utm_source=chatgpt.com&b=2&gclid=z&a=1#top',
      ),
    ).toBe('https://reddit.com/r/x/comments/1?a=1&b=2')
    expect(normalizeUrl('https://www.anker.com/products/nano?utm_source=chatgpt.com')).toBe(
      'https://anker.com/products/nano',
    )
    expect(normalizeUrl('https://youtu.be/abc?si=xyz')).toBe('https://youtu.be/abc')
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com')
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(normalizeUrl('ftp://a.com/x')).toBe('ftp://a.com/x')
  })
})

describe('引用编号与去重', () => {
  it('同一页只记第一次；在正文里引用过就算 inline；补上缺的标题；非 http 丢掉', () => {
    const c = citationsOf({
      citations: [
        { url: 'https://www.belkin.com/boost?utm_source=chatgpt.com', where: 'listed' },
        { url: 'https://reddit.com/r/x', title: 'Thread', where: 'searched' },
        { url: 'https://belkin.com/boost', title: 'Belkin', where: 'inline' },
        { url: 'ftp://bad', where: 'inline' },
      ],
      cited_urls: [],
    })
    expect(c).toEqual([
      {
        position: 1,
        url: 'https://www.belkin.com/boost?utm_source=chatgpt.com',
        domain: 'belkin.com',
        title: 'Belkin',
        where: 'inline',
      },
      {
        position: 2,
        url: 'https://reddit.com/r/x',
        domain: 'reddit.com',
        title: 'Thread',
        where: 'searched',
      },
    ])
    expect(citationsOf({ cited_urls: ['https://a.com/'] })).toEqual([
      { position: 1, url: 'https://a.com/', domain: 'a.com', where: 'listed' },
    ])
  })
})

describe('别名、首次出现位置、名次', () => {
  it('先删引用标记、屏蔽网址与邮箱（等长空格，位置不乱）', () => {
    const t = 'Voltbrick[1] see https://anker.com/x or mail hi@mophie.com'
    const p = prepareAnswerText(t)
    expect(p.startsWith('Voltbrick see ')).toBe(true)
    expect(p).not.toMatch(/anker|mophie/u)
    expect(p.length).toBe(t.length - 3)
  })

  it('firstMention 按词、大小写不敏感；中文按子串；域名认子域名不认后缀撞车', () => {
    expect(firstMention('Try the ANKER Nano.', 'Anker')).toBe(8)
    expect(firstMention('Ankerite', 'Anker')).toBe(-1)
    expect(firstMention('推荐沃特砖 20K', '沃特砖')).toBe(2)
    expect(firstDomainMention('buy at shop.voltbrick.com today', 'voltbrick.com')).toBe(12)
    expect(firstDomainMention('notvoltbrick.com', 'voltbrick.com')).toBe(-1)
  })

  it('我们 + 竞品按首次出现先后排名次；别名命中记下来；网址里的名字不算提到但引用算被引用', () => {
    const text =
      'Top picks: 1. **Anker MagGo** [1] 2. The VB 20K by Volt Brick is great. ' +
      'More at https://www.mophie.com/deals.'
    const rows = matchEntities(
      text,
      [
        { position: 1, url: 'https://www.mophie.com/deals', domain: 'mophie.com', where: 'inline' },
        { position: 2, url: 'https://voltbrick.com/', domain: 'voltbrick.com', where: 'searched' },
      ],
      [
        { entity: 'ours', ...WATCH.brand },
        ...WATCH.competitors.map((c) => ({ entity: c.id, ...c })),
      ],
    )
    const by = Object.fromEntries(rows.map((r) => [r.entity, r]))
    expect(by.c_anker).toMatchObject({ mentioned: true, rank: 1, alias_hit: 'Anker' })
    expect(by.ours).toMatchObject({ mentioned: true, rank: 2, alias_hit: 'VB 20K', cited: false })
    expect(by.c_mophie).toMatchObject({ mentioned: false, cited: true })
    expect(by.c_mophie?.rank).toBeUndefined()
    expect(by.c_belkin).toMatchObject({ mentioned: false, cited: false })
    expect(rows[0]?.entity).toBe('ours')
  })

  it('judgeAnswer 认别名；竞品出现按别名也认（修「竞品永远空」）', () => {
    const r = judgeAnswer(
      WATCH,
      'claude',
      { text: 'Volt Brick and MagGo are both fine.', cited_urls: [] },
      { fetched_at: 't', source: 'byo:dataforseo' },
    )
    expect(r.brand_mentioned).toBe(true)
    expect(r.competitors_mentioned).toEqual(['Anker'])
    // 老适配器（只给 text + cited_urls）出来的形状不多出新字段
    expect(r.answer_markdown).toBeUndefined()
    expect(r.citations).toBeUndefined()
  })

  it('judgeAnswer 带上全文、结构化引用、模型、取数方式', () => {
    const r = judgeAnswer(
      WATCH,
      'claude',
      {
        text: 'Voltbrick is solid.',
        markdown: '**Voltbrick** is solid.',
        cited_urls: ['https://voltbrick.com/'],
        citations: [{ url: 'https://voltbrick.com/', title: 'Voltbrick', where: 'inline' }],
        model: 'claude-sonnet-5',
        via: 'model_api',
      },
      { fetched_at: 't', source: 'byo:dataforseo' },
    )
    expect(r).toMatchObject({
      brand_mentioned: true,
      our_domain_cited: true,
      answer_markdown: '**Voltbrick** is solid.',
      model: 'claude-sonnet-5',
      via: 'model_api',
    })
    expect(r.citations).toEqual([
      {
        position: 1,
        url: 'https://voltbrick.com/',
        domain: 'voltbrick.com',
        title: 'Voltbrick',
        where: 'inline',
      },
    ])
  })

  it('normalizeProbe 只在给了时带别名', () => {
    const p = normalizeProbe({
      question: 'q',
      platforms: ['claude'],
      country: 'us',
      language: 'en',
      brand: { name: 'Voltbrick', domains: [], aliases: ['VB', 'VB', ' '] },
      competitors: [{ name: 'Anker' }],
    })
    expect(p.platforms).toEqual(['claude'])
    expect(p.brand).toEqual({ name: 'Voltbrick', domains: [], aliases: ['VB'] })
    expect(p.competitors).toEqual([{ name: 'Anker', domains: [] }])
  })
})

describe('引用归类（先内置表）', () => {
  it('我们 / 竞品优先；论坛、视频、电商（各国站点）、媒体；认不出是 other；缓存可盖内置表', () => {
    const ctx = { ours: ['voltbrick.com'], competitors: ['anker.com'] }
    expect(siteKindOf('shop.voltbrick.com', ctx)).toBe('ours')
    expect(siteKindOf('anker.com', ctx)).toBe('competitor')
    expect(siteKindOf('old.reddit.com', ctx)).toBe('forum')
    expect(siteKindOf('youtube.com', ctx)).toBe('video')
    expect(siteKindOf('amazon.co.uk', ctx)).toBe('marketplace')
    expect(siteKindOf('smile.amazon.de', ctx)).toBe('marketplace')
    expect(builtinSiteKind('amazonaws.com')).toBeUndefined()
    expect(siteKindOf('en.wikipedia.org', ctx)).toBe('media')
    expect(siteKindOf('someblog.net', ctx)).toBe('other')
    expect(siteKindOf('someblog.net', { ...ctx, known: () => 'media' })).toBe('media')
  })

  it('analyzeAnswer：引用带 url_norm 与类型，品牌判定带规则版本', () => {
    const a = analyzeAnswer(WATCH, {
      text: 'Voltbrick beats Anker. [1][2]',
      citations: [
        { url: 'https://www.reddit.com/r/x/?utm_source=chatgpt.com', where: 'inline' },
        { url: 'https://voltbrick.com/p', where: 'listed' },
      ],
    })
    expect(a.rules_version).toBe(GEO_RULES_VERSION)
    expect(a.citations.map((c) => [c.url_norm, c.site_kind])).toEqual([
      ['https://reddit.com/r/x', 'forum'],
      ['https://voltbrick.com/p', 'ours'],
    ])
    expect(a.mentions.map((m) => [m.entity, m.mentioned, m.cited, m.rank])).toEqual([
      ['ours', true, true, 1],
      ['c_anker', true, false, 2],
      ['c_mophie', false, false, undefined],
      ['c_belkin', false, false, undefined],
    ])
  })
})
