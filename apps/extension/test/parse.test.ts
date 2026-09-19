/**
 * 页面解析器，用**自己造的最小夹具**（WP119 定论 5）。
 *
 * 夹具是手写的几十行 HTML，不是从平台上拷下来的页面全文：拷全文既有版权问题，
 * 也会让测试在平台改一次版式之后整批红掉——而那时候真正该看的是
 * 「读不到的格子有没有老老实实留空」，不是「那一坨 HTML 还在不在」。
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { computeCreatorHealth } from '../src/lib/health.js'
import { routeOf } from '../src/lib/parse/route.js'
import { parseInstagramProfile, parseTikTokProfile } from '../src/lib/parse/social.js'
import {
  parseYouTubeChannel,
  parseYouTubeSearch,
  parseYouTubeWatch,
} from '../src/lib/parse/youtube.js'
import { candidateObservation, creatorObservation } from '../src/lib/to-observation.js'

const NOW = '2026-09-19T10:00:00.000Z'

const docOf = (html: string, url: string): Document =>
  new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url }).window
    .document

/** 带 head 的那一种（meta / canonical 要在 head 里）。 */
const pageOf = (head: string, body: string, url: string): Document =>
  new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { url }).window
    .document

describe('routeOf：内容页必须先问', () => {
  it('YouTube', () => {
    expect(routeOf('https://www.youtube.com/watch?v=abc123')).toEqual({
      platform: 'youtube',
      kind: 'content',
      subject: 'abc123',
    })
    expect(routeOf('https://www.youtube.com/@someone/videos')).toEqual({
      platform: 'youtube',
      kind: 'creator',
      subject: '@someone',
    })
    expect(routeOf('https://www.youtube.com/results?search_query=mini+projector')).toEqual({
      platform: 'youtube',
      kind: 'search',
      subject: 'mini projector',
    })
  })

  it('TikTok 的视频页不能被当成主页（前缀一样）', () => {
    expect(routeOf('https://www.tiktok.com/@someone/video/12345')).toEqual({
      platform: 'tiktok',
      kind: 'content',
      subject: '12345',
    })
    expect(routeOf('https://www.tiktok.com/@someone')).toEqual({
      platform: 'tiktok',
      kind: 'creator',
      subject: '@someone',
    })
  })

  it('Instagram 的 /p/ 与 /explore/ 不是主页', () => {
    expect(routeOf('https://www.instagram.com/p/XyZ/')?.kind).toBe('content')
    expect(routeOf('https://www.instagram.com/explore/')).toBe(undefined)
    expect(routeOf('https://www.instagram.com/someone/')).toEqual({
      platform: 'instagram',
      kind: 'creator',
      subject: '@someone',
    })
  })

  it('认不出来的页回 undefined（面板会老实说看不懂）', () => {
    expect(routeOf('https://example.com/whatever')).toBe(undefined)
    expect(routeOf('not a url')).toBe(undefined)
  })
})

describe('YouTube 频道页', () => {
  const head = `
    <link rel="canonical" href="https://www.youtube.com/@fixture">
    <meta property="og:title" content="夹具频道">
    <meta property="og:image" content="https://example.com/a.jpg">`
  const body = `
    <div id="meta"><h1 id="channel-name"><span id="text">夹具频道</span></h1>
      <span>12.3万位订阅者</span><span>240 个视频</span></div>
    <div id="additional-info-container">
      1,234,567 次观看
      2019年3月4日加入
      <a href="https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com">官网</a>
    </div>
    <ytd-rich-item-renderer>
      <a href="/watch?v=vid001"></a><h3 id="video-title">第一条</h3>
      <span id="metadata-line">5.2万次观看</span>
    </ytd-rich-item-renderer>
    <ytd-rich-item-renderer>
      <a href="/watch?v=vid002"></a><h3 id="video-title">第二条</h3>
      <span id="metadata-line">3万次观看</span>
    </ytd-rich-item-renderer>`

  const snapshot = parseYouTubeChannel(
    pageOf(head, body, 'https://www.youtube.com/@fixture'),
    'https://www.youtube.com/@fixture',
    NOW,
  )

  it('身份、订阅数、视频数、总播放、注册时间都读得到', () => {
    expect(snapshot?.external_id).toBe('@fixture')
    expect(snapshot?.handle).toBe('@fixture')
    expect(snapshot?.followers).toBe(123_000)
    expect(snapshot?.video_count).toBe(240)
    expect(snapshot?.total_views).toBe(1_234_567)
    expect(snapshot?.joined_date).toContain('2019')
  })

  it('页面原文留着——上报公共库带的是它，不是解析结果', () => {
    expect(snapshot?.followers_text).toContain('12.3万')
  })

  it('外链穿过 YouTube 的跳转包装，留真地址', () => {
    expect(snapshot?.links).toContain('https://example.com')
  })

  it('近期作品与平均播放', () => {
    expect(snapshot?.recent_items).toHaveLength(2)
    expect(computeCreatorHealth(snapshot ?? { followers: 0, recent_items: [] }).avg_views).toBe(
      41_000,
    )
  })

  it('用户没点开「关于」时**没有**邮箱这一格', () => {
    expect(snapshot?.business_email).toBe(undefined)
  })

  it('用户点开之后才读得到（DOM 里有了才读）', () => {
    const opened = parseYouTubeChannel(
      pageOf(
        head,
        body.replace('官网</a>', '官网</a> hi@example.com'),
        'https://www.youtube.com/@fixture',
      ),
      'https://www.youtube.com/@fixture',
      NOW,
    )
    expect(opened?.business_email).toBe('hi@example.com')
  })
})

describe('YouTube 视频页', () => {
  it('播放、点赞（取 aria-label 的精确数）、作者订阅数', () => {
    const doc = pageOf(
      `<meta property="og:title" content="一条视频">`,
      `<ytd-watch-flexy>
         <div id="info-container">12.3万次观看 3天前</div>
         <button aria-label="like this video along with 4,821 other people">赞</button>
         <ytd-video-owner-renderer>
           <a href="/@fixture"><yt-formatted-string>夹具频道</yt-formatted-string></a>
           <span id="owner-sub-count">12.3万位订阅者</span>
         </ytd-video-owner-renderer>
       </ytd-watch-flexy>`,
      'https://www.youtube.com/watch?v=abc123',
    )
    const snap = parseYouTubeWatch(doc, 'https://www.youtube.com/watch?v=abc123', NOW)
    expect(snap?.content_id).toBe('abc123')
    expect(snap?.views).toBe(123_000)
    expect(snap?.likes).toBe(4_821)
    expect(snap?.author.handle).toBe('@fixture')
    expect(snap?.author.followers).toBe(123_000)
  })
})

describe('YouTube 搜索结果页', () => {
  const doc = docOf(
    `<ytd-channel-renderer>
       <a href="/channel/UCabcdefghij12"></a>
       <yt-formatted-string id="text">频道甲</yt-formatted-string>
       <span>50万位订阅者</span>
     </ytd-channel-renderer>
     <ytd-video-renderer>
       <a href="/watch?v=vidAAAAAAA1"></a><h3 id="video-title">视频一</h3>
       <ytd-channel-name><a href="/channel/UCabcdefghij12">频道甲</a></ytd-channel-name>
       <span>8.1万次观看</span>
     </ytd-video-renderer>
     <ytd-video-renderer>
       <a href="/watch?v=vidBBBBBBB2"></a><h3 id="video-title">视频二</h3>
       <ytd-channel-name><a href="/@yizhi">乙</a></ytd-channel-name>
       <span>300次观看</span>
     </ytd-video-renderer>`,
    'https://www.youtube.com/results?search_query=x',
  )
  const rows = parseYouTubeSearch(doc, 'https://www.youtube.com/results?search_query=x')

  it('频道行与视频署名行合成一个人', () => {
    expect(rows).toHaveLength(2)
    const jia = rows.find((r) => r.external_id === 'UCabcdefghij12')
    expect(jia?.display_name).toBe('频道甲')
    expect(jia?.subscriber_count_text).toContain('50万')
    expect(jia?.videos).toHaveLength(1)
  })

  it('只有视频署名的那个人也在（他的订阅数页面上没印——这正是要留着的那种）', () => {
    const yi = rows.find((r) => r.external_id === '@yizhi')
    expect(yi).toBeDefined()
    expect(yi?.subscriber_count_text).toBe(undefined)
  })

  it('上报时带的是原文，解析出来的数一个都不带', () => {
    const jia = rows.find((r) => r.external_id === 'UCabcdefghij12')
    const obs = candidateObservation(
      jia ?? rows[0] ?? { external_id: 'x', videos: [], source: 'channel_result' },
      'https://www.youtube.com/results?search_query=x',
      NOW,
    )
    expect(obs.followers_text).toContain('50万')
    expect(obs.followers).toBe(undefined)
    expect(obs.source).toBe('search_results')
  })
})

describe('Instagram / TikTok 的最小版', () => {
  it('Instagram：身份 + 粉丝数 + 主页链接', () => {
    const doc = pageOf(
      `<link rel="canonical" href="https://www.instagram.com/fixture/">
       <meta property="og:title" content="夹具 (@fixture) • Instagram">
       <meta property="og:description" content="1.2M Followers, 300 Following, 900 Posts">`,
      `<header><section><h1>夹具</h1></section></header>`,
      'https://www.instagram.com/fixture/',
    )
    const snap = parseInstagramProfile(doc, 'https://www.instagram.com/fixture/', NOW)
    expect(snap?.handle).toBe('@fixture')
    expect(snap?.followers).toBe(1_200_000)
    expect(snap?.video_count).toBe(900)
    expect(snap?.name).toBe('夹具')
  })

  it('TikTok：data-e2e 那一格优先于 og:description', () => {
    const doc = pageOf(
      `<link rel="canonical" href="https://www.tiktok.com/@fixture">
       <meta property="og:description" content="99 Followers. 1M Likes.">`,
      `<h1 data-e2e="user-title">@fixture</h1>
       <strong data-e2e="followers-count">45.6万</strong>
       <div data-e2e="user-post-item"><a href="/@fixture/video/777"></a>
         <strong data-e2e="video-views">2.3万</strong></div>`,
      'https://www.tiktok.com/@fixture',
    )
    const snap = parseTikTokProfile(doc, 'https://www.tiktok.com/@fixture', NOW)
    expect(snap?.handle).toBe('@fixture')
    expect(snap?.followers).toBe(456_000)
    expect(snap?.recent_items[0]?.content_id).toBe('777')
    expect(snap?.recent_items[0]?.views).toBe(23_000)
  })

  it('读不到的格子留空，不填 0', () => {
    const doc = pageOf(
      `<link rel="canonical" href="https://www.tiktok.com/@empty">`,
      '',
      'https://www.tiktok.com/@empty',
    )
    const snap = parseTikTokProfile(doc, 'https://www.tiktok.com/@empty', NOW)
    expect(snap?.followers).toBe(undefined)
    expect(snap?.followers_text).toBe(undefined)
  })
})

describe('快照 → 观测：白名单', () => {
  it('links / recent_items / total_views 留在本机，不往上报', () => {
    const snapshot = {
      platform: 'youtube' as const,
      external_id: '@a',
      handle: '@a',
      name: '甲',
      page_url: 'https://www.youtube.com/@a',
      followers: 1000,
      total_views: 999_999,
      links: ['https://example.com'],
      recent_items: [{ content_id: 'v1', views: 100 }],
      observed_at: NOW,
    }
    const obs = creatorObservation(snapshot, computeCreatorHealth(snapshot))
    expect(Object.keys(obs).sort()).toEqual(
      [
        'avg_views',
        'channel',
        'display_name',
        'external_id',
        'followers',
        'handle',
        'observed_at',
        'page_url',
        'source',
        'url',
      ].sort(),
    )
  })

  it('联系方式只有调用方显式传了才会出现', () => {
    const snapshot = {
      platform: 'youtube' as const,
      external_id: '@a',
      name: '甲',
      page_url: 'https://www.youtube.com/@a',
      business_email: 'hi@example.com',
      links: [],
      recent_items: [],
      observed_at: NOW,
    }
    // 页面上读到了邮箱，但用户没点「收下」——观测里就没有这一格
    expect(creatorObservation(snapshot, computeCreatorHealth(snapshot)).contact).toBe(undefined)
    const withContact = creatorObservation(snapshot, computeCreatorHealth(snapshot), {
      contact: { kind: 'email', value: 'hi@example.com', source: snapshot.page_url },
    })
    expect(withContact.contact?.value).toBe('hi@example.com')
  })
})
