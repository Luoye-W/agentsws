/**
 * WP386：feed 解析换成 feedsmith、任意 RSS 都能读；本地整词过滤；去重加 guid 与同站相近标题。
 * 全用录好的样本（`fixtures/`，地址都是假的），不联网。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EMAIL_DELIVERY_HINT,
  feedLabelOf,
  fetchFeed,
  keywordFilter,
  mentionKey,
  parseFeedDoc,
  probeFeedLink,
  similarTitles,
  termHit,
} from '../src/index.js'

const NOW = '2026-10-18T09:00:00.000Z'
const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const GA = 'https://www.google.com/alerts/feeds/00000000000000000000/0000000000000000000'

const serve =
  (routes: Record<string, { status: number; body: string }>) =>
  async (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
    const hit = routes[url] ?? { status: 404, body: '' }
    return { ok: hit.status < 400, status: hit.status, text: async () => hit.body }
  }
const transport = (routes: Record<string, { status: number; body: string }>) => ({
  fetch: serve(routes),
  now: () => NOW,
})

describe('feedsmith 解析', () => {
  it('Google Alerts Atom：标题拆出盯的词、跳转链接解开、带 guid', () => {
    const doc = parseFeedDoc(fx('google-alerts-3.atom.xml'), NOW)
    expect(doc?.format).toBe('atom')
    expect(doc?.label).toBe('Super73')
    expect(doc?.rows).toHaveLength(3)
    const first = doc?.rows[0]
    expect(first?.url).toBe('https://news1.example.com/2026/10/super73-1?utm_source=rss')
    expect(first?.title).toBe('Super73 news item 1 about the R model')
    expect(first?.text).toBe('The Super73 R item 1 & more')
    expect(first?.guid).toBe('tag:google.com,2013:googlealerts/feed:1001')
    // 去重键按归一后的 URL（追踪参数去掉）
    expect(first?.dedupe_key).toBe('url:https://news1.example.com/2026/10/super73-1')
  })

  it('普通 RSS 2.0：任意网站都能读（不再要求 Google Alerts 前缀）', () => {
    const doc = parseFeedDoc(fx('site-rss2.xml'), NOW)
    expect(doc?.format).toBe('rss')
    expect(doc?.label).toBe('E-Bike Review Example')
    expect(doc?.rows).toHaveLength(4)
    expect(doc?.rows[0]?.author).toBe('Jo Rider')
    expect(doc?.rows[0]?.text).toBe('We rode the Aventon for 3 months.')
    expect(doc?.rows[0]?.published_at).toBe('2026-10-17T08:00:00.000Z')
  })

  it('不是 feed（登录页 HTML、空串）→ undefined，调用方照实说', () => {
    expect(parseFeedDoc(fx('not-a-feed.html'), NOW)).toBeUndefined()
    expect(parseFeedDoc('', NOW)).toBeUndefined()
  })

  it('feed 标题 → 人话名', () => {
    expect(feedLabelOf('Google Alert - "Aventon" -job')).toBe('"Aventon" -job')
    expect(feedLabelOf('Google Alert - "Super73"')).toBe('Super73')
    expect(feedLabelOf('Google 快讯 - Super73')).toBe('Super73')
    expect(feedLabelOf('Some Blog')).toBe('Some Blog')
    expect(feedLabelOf(undefined)).toBeUndefined()
  })
})

describe('拉取与贴链接校验', () => {
  it('404 照实说；不是 feed 照实说（不当成 0 条）', async () => {
    const t = transport({ [GA]: { status: 404, body: '' } })
    const gone = await fetchFeed(t, { url: GA })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.message).toContain('404')
    const html = await fetchFeed(
      transport({ 'https://x.example/feed': { status: 200, body: fx('not-a-feed.html') } }),
      {
        url: 'https://x.example/feed',
      },
    )
    expect(html.ok).toBe(false)
    if (!html.ok) expect(html.message).toContain('不是 RSS')
  })

  it('贴 Google Alerts 的 RSS → 认成 google_alerts，并带回第一轮条目', async () => {
    const got = await probeFeedLink(
      transport({ [GA]: { status: 200, body: fx('google-alerts-3.atom.xml') } }),
      GA,
    )
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.data.kind).toBe('google_alerts')
    expect(got.data.label).toBe('Super73')
    expect(got.data.rows).toHaveLength(3)
  })

  it('贴网站自己的 RSS → 认成 rss', async () => {
    const url = 'https://ebr.example.com/feed'
    const got = await probeFeedLink(
      transport({ [url]: { status: 200, body: fx('site-rss2.xml') } }),
      url,
    )
    expect(got.ok && got.data.kind).toBe('rss')
  })

  it('贴错链接：Google Alerts 页面 / 不是 RSS 的网页 / 不是链接 → 当场说「还是邮箱投递」', async () => {
    const t = transport({
      'https://shop.example.com/': { status: 200, body: fx('not-a-feed.html') },
    })
    for (const raw of [
      'https://www.google.com/alerts?hl=en#1:0',
      'https://www.google.com/alerts/edit?params=abc',
      'https://shop.example.com/',
      'Super73 的提醒',
    ]) {
      const got = await probeFeedLink(t, raw)
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.message).toContain(EMAIL_DELIVERY_HINT)
    }
  })
})

describe('本地整词过滤', () => {
  it('整词：INMO 不命中 inmobiliaria；短语与大小写', () => {
    expect(termHit('Inmobiliaria market update', 'INMO')).toBe(false)
    expect(termHit('New INMO Air3 glasses', 'INMO')).toBe(true)
    expect(termHit('The E-Bike of the year', 'e-bike')).toBe(true)
    expect(termHit('aventon level 3', '"Aventon Level"')).toBe(true)
    expect(termHit('我买了九号电动车', '九号')).toBe(true)
  })

  it('至少命中一个关键词、排除词生效', () => {
    const rows = parseFeedDoc(fx('site-rss2.xml'), NOW)?.rows ?? []
    const kept = rows.filter(
      (r) => keywordFilter(r, { keywords: ['Aventon', 'INMO'], exclude: ['job', 'hiring'] }).keep,
    )
    expect(kept.map((r) => r.title)).toEqual([
      'Aventon Level 3 long-term review',
      'Lectric XP 4 vs Aventon Sinch',
    ])
    expect(keywordFilter({ text: 'anything' }, {}).keep).toBe(true)
    expect(
      keywordFilter({ text: 'Aventon jobs' }, { keywords: ['Aventon'], exclude: ['job'] }).keep,
    ).toBe(true)
  })
})

describe('去重加强', () => {
  it('没有 URL 时用 guid', () => {
    expect(mentionKey({ source: 'news', url: '', guid: 'abc-1', title: 'x' })).toBe('guid:abc-1')
    expect(mentionKey({ source: 'news', url: 'https://a.example/x?utm_source=1', guid: 'g' })).toBe(
      'url:https://a.example/x',
    )
  })

  it('同站相近标题算同一条；差得多的不算', () => {
    expect(
      similarTitles(
        'Aventon recalls 2,000 e-bikes',
        'Aventon recalls 2,000 e-bikes - Example News',
      ),
    ).toBe(true)
    expect(
      similarTitles(
        'Aventon recalls 2,000 e-bikes over brakes',
        'Aventon recalls 2000 e-bikes over brakes',
      ),
    ).toBe(true)
    expect(similarTitles('Aventon launches new Level 3', 'Lectric launches XP 4')).toBe(false)
    expect(similarTitles(undefined, 'x')).toBe(false)
  })
})
