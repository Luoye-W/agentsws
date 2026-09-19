/**
 * YouTube 的三张页：频道 / 视频 / 搜索结果（WP119 定论 2）。
 *
 * 两条守在这里的纪律：
 *
 * 1. **邮箱只读用户已经点开的那一个**。YouTube 的「关于」里那个商务邮箱要
 *    过一次人机验证才显示；插件**不去点它、不去过验证**——只在用户自己点开
 *    之后，从已经渲染出来的 DOM 里读。不点就没有，这是产品行为不是技术限制。
 * 2. **搜索结果页只上报原文**。`subscriber_count_text` 是页面上那串字，
 *    解析成数字只用于本机的阈值筛选。解析错一条，错的数就进了公共库。
 */

import type { BulkCandidate, VideoEvidence } from '../bulk.js'
import { dedupeCandidates, MAX_VIDEOS_PER_CANDIDATE } from '../bulk.js'
import { parseCompactCount } from '../counts.js'
import type { ContentSnapshot, CreatorSnapshot, RecentItem } from '../snapshot.js'
import { absolute, canonical, firstMatch, isoDurationSeconds, meta, pick, text } from './dom.js'

/** 近期作品最多取这么多条（再多也算不出更准的平均）。 */
export const RECENT_LIMIT = 120

const SUBSCRIBER_PATTERNS = [
  /([\d.,  \s]+\s*[KMB万亿億千]?)\s*(?:subscribers?|位订阅者|订阅者|名订閱者)/i,
  /(?:subscribers?|订阅者)\s*[:：]?\s*([\d.,]+\s*[KMB万亿億千]?)/i,
]
const VIDEO_COUNT_PATTERNS = [/([\d.,]+\s*[KMB万亿億千]?)\s*(?:videos?|个视频|部影片)/i]
const TOTAL_VIEWS_PATTERNS = [/([\d,]{4,})\s*(?:views|次观看|观看)/i]
const JOINED_PATTERNS = [
  /Joined\s+(.+)/i,
  /(\d{4}年\d{1,2}月\d{1,2}日)\s*加入/,
  /加入日期[:：]?\s*(.+)/,
]

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

/**
 * 频道页。
 *
 * `doc` 与 `href` 都是传进来的——解析器一个全局变量都不读，于是测试里
 * 拿一份自造的最小 HTML 就能跑（不需要真的开一个 YouTube 页面）。
 */
export function parseYouTubeChannel(
  doc: Document,
  href: string,
  now: string,
): CreatorSnapshot | undefined {
  const canonicalHref = canonical(doc) ?? meta(doc, ['og:url']) ?? href
  const externalId =
    firstMatch(canonicalHref, /\/channel\/(UC[\w-]{10,})/) ??
    firstMatch(href, /\/channel\/(UC[\w-]{10,})/) ??
    firstMatch(canonicalHref, /\/(@[^/?#]+)/) ??
    firstMatch(href, /\/(@[^/?#]+)/)
  if (externalId === undefined) return undefined

  const handle = firstMatch(canonicalHref, /\/(@[^/?#]+)/) ?? firstMatch(href, /\/(@[^/?#]+)/)

  const name =
    text(doc, ['#channel-name #text', 'yt-formatted-string#text', 'h1']) ??
    meta(doc, ['og:title']) ??
    externalId

  // 订阅数 / 视频数 / 总播放：header 与「关于」弹层的文本里找，一格一串正则。
  const header = pick(doc, ['#meta', 'ytd-c4-tabbed-header-renderer', 'header']) ?? doc.body
  const headerText = header.textContent ?? ''
  const aboutText = pick(doc, ['#additional-info-container', '#about-container'])?.textContent ?? ''
  const blob = `${headerText}\n${aboutText}`

  const followersText = SUBSCRIBER_PATTERNS.map((p) => firstMatch(blob, p)).find(
    (v) => v !== undefined,
  )
  const videoCountText = VIDEO_COUNT_PATTERNS.map((p) => firstMatch(blob, p)).find(
    (v) => v !== undefined,
  )
  const totalViewsText = TOTAL_VIEWS_PATTERNS.map((p) => firstMatch(aboutText, p)).find(
    (v) => v !== undefined,
  )
  const joined = JOINED_PATTERNS.map((p) => firstMatch(aboutText, p)).find((v) => v !== undefined)

  // **只读用户已经点开的那个邮箱**：没点开时 DOM 里根本没有它。
  const businessEmail = EMAIL.exec(aboutText)?.[0]

  const links: string[] = []
  const about = pick(doc, ['#additional-info-container', '#about-container'])
  if (about !== undefined) {
    for (const a of about.querySelectorAll('a[href]')) {
      const url = absolute(a.getAttribute('href'), href)
      if (url === undefined) continue
      if (url.includes('youtube.com/redirect?')) {
        // YouTube 把外链包了一层跳转，真地址在 `q` 参数里
        const real = new URL(url).searchParams.get('q')
        if (real !== null) links.push(real)
        continue
      }
      links.push(url)
    }
  }

  return {
    platform: 'youtube',
    external_id: externalId,
    ...(handle === undefined ? {} : { handle }),
    name,
    ...(meta(doc, ['og:image']) === undefined ? {} : { avatar_url: meta(doc, ['og:image']) }),
    page_url: canonicalHref,
    followers: parseCompactCount(followersText),
    ...(followersText === undefined ? {} : { followers_text: followersText.trim() }),
    video_count: parseCompactCount(videoCountText),
    total_views: parseCompactCount(totalViewsText),
    ...(joined === undefined ? {} : { joined_date: joined.trim() }),
    ...(businessEmail === undefined ? {} : { business_email: businessEmail }),
    ...(meta(doc, ['og:description']) === undefined ? {} : { bio: meta(doc, ['og:description']) }),
    links: [...new Set(links)],
    recent_items: parseChannelVideos(doc, href),
    observed_at: now,
  }
}

const VIDEO_ITEM_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-grid-video-renderer',
  '[data-agentsws-video]',
]

/** 频道页视频网格里的近期作品。 */
export function parseChannelVideos(doc: Document, href: string): RecentItem[] {
  const out: RecentItem[] = []
  for (const selector of VIDEO_ITEM_SELECTORS) {
    const nodes = doc.querySelectorAll(selector)
    if (nodes.length === 0) continue
    for (const node of nodes) {
      const link = node.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')
      const url = absolute(link?.getAttribute('href'), href)
      const id = firstMatch(url, /[?&]v=([\w-]{5,})/) ?? firstMatch(url, /\/shorts\/([\w-]{5,})/)
      if (id === undefined) continue
      const metaText = node.querySelector('#metadata-line, .inline-metadata-item')?.textContent
      const blob = node.textContent ?? ''
      const viewsText =
        firstMatch(metaText ?? blob, /([\d.,]+\s*[KMB万亿億千]?)\s*(?:views|次观看|次觀看)/i) ??
        undefined
      out.push({
        content_id: id,
        ...(url === undefined ? {} : { url }),
        ...(text(node, ['#video-title', 'a#video-title-link', 'h3']) === undefined
          ? {}
          : { title: text(node, ['#video-title', 'a#video-title-link', 'h3']) }),
        views: parseCompactCount(viewsText),
      })
      if (out.length >= RECENT_LIMIT) return out
    }
    if (out.length > 0) return out
  }
  return out
}

/** 视频页（watch / shorts）。 */
export function parseYouTubeWatch(
  doc: Document,
  href: string,
  now: string,
): ContentSnapshot | undefined {
  const contentId =
    firstMatch(href, /[?&]v=([\w-]{5,})/) ?? firstMatch(href, /\/shorts\/([\w-]{5,})/)
  if (contentId === undefined) return undefined

  const scope = pick(doc, ['ytd-watch-flexy', '#primary']) ?? doc.body
  const infoText = pick(scope, ['#info-container', 'ytd-watch-info-text'])?.textContent ?? ''
  const viewsText = firstMatch(infoText, /([\d.,]+\s*[KMB万亿億千]?)\s*(?:views?|次观看)/i)
  const published = firstMatch(infoText, /(\d+\s*(?:秒|分钟|小时|天|日|周|星期|个月|月|年)前)/)

  // 点赞优先取按钮 aria-label 里的精确数（可见文本是压缩过的）
  const likeLabel = pick(scope, [
    'button[aria-label*="like"]',
    'button[aria-label*="赞"]',
  ])?.getAttribute('aria-label')
  const likesText =
    firstMatch(likeLabel ?? '', /([\d,.]+)/) ??
    text(scope, ['#segmented-like-button button span', '.like-count'])

  const owner = pick(scope, ['ytd-video-owner-renderer', '#owner']) ?? undefined
  const followersText = owner === undefined ? undefined : text(owner, ['#owner-sub-count'])

  return {
    platform: 'youtube',
    content_id: contentId,
    ...(meta(doc, ['og:title']) === undefined ? {} : { title: meta(doc, ['og:title']) }),
    url: canonical(doc) ?? href,
    ...(meta(doc, ['og:image']) === undefined ? {} : { thumbnail_url: meta(doc, ['og:image']) }),
    ...(published === undefined ? {} : { published_text: published }),
    views: parseCompactCount(viewsText),
    likes: parseCompactCount(likesText),
    duration_seconds: isoDurationSeconds(meta(doc, ['og:video:duration', 'duration'])),
    author: {
      ...(owner === undefined
        ? {}
        : {
            name: text(owner, ['#channel-name a', 'yt-formatted-string']),
            url: absolute(owner.querySelector('a[href]')?.getAttribute('href'), href),
            handle: firstMatch(
              absolute(owner.querySelector('a[href]')?.getAttribute('href'), href),
              /\/(@[^/?#]+)/,
            ),
          }),
      followers: parseCompactCount(followersText),
    },
    observed_at: now,
  }
}

/** 搜索结果页上的候选（频道结果 + 视频署名两种来源）。 */
export function parseYouTubeSearch(doc: Document, href: string): BulkCandidate[] {
  const rows: BulkCandidate[] = []

  for (const node of doc.querySelectorAll('ytd-channel-renderer, [data-agentsws-channel]')) {
    const link = node.querySelector('a[href*="/channel/"], a[href*="/@"]')
    const url = absolute(link?.getAttribute('href'), href)
    const id = identityOf(url)
    if (id === undefined) continue
    const blob = node.textContent ?? ''
    rows.push({
      external_id: id,
      ...(firstMatch(url, /\/(@[^/?#]+)/) === undefined
        ? {}
        : { handle: firstMatch(url, /\/(@[^/?#]+)/) }),
      ...(text(node, ['#channel-title', 'yt-formatted-string#text', 'h3']) === undefined
        ? {}
        : { display_name: text(node, ['#channel-title', 'yt-formatted-string#text', 'h3']) }),
      ...(url === undefined ? {} : { url }),
      ...(SUBSCRIBER_PATTERNS.map((p) => firstMatch(blob, p)).find((v) => v !== undefined) ===
      undefined
        ? {}
        : {
            subscriber_count_text: SUBSCRIBER_PATTERNS.map((p) => firstMatch(blob, p))
              .find((v) => v !== undefined)
              ?.trim(),
          }),
      videos: [],
      source: 'channel_result',
    })
  }

  for (const node of doc.querySelectorAll('ytd-video-renderer, [data-agentsws-result]')) {
    const byline = node.querySelector(
      'ytd-channel-name a[href], #channel-name a[href], a[href*="/@"]',
    )
    const channelUrl = absolute(byline?.getAttribute('href'), href)
    const id = identityOf(channelUrl)
    if (id === undefined) continue
    const videoUrl = absolute(
      node.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')?.getAttribute('href'),
      href,
    )
    const videoId =
      firstMatch(videoUrl, /[?&]v=([\w-]{5,})/) ?? firstMatch(videoUrl, /\/shorts\/([\w-]{5,})/)
    const blob = node.textContent ?? ''
    const viewsText = firstMatch(blob, /([\d.,]+\s*[KMB万亿億千]?)\s*(?:views|次观看|次觀看)/i)
    const evidence: VideoEvidence[] =
      videoId === undefined
        ? []
        : [
            {
              content_id: videoId,
              ...(videoUrl === undefined ? {} : { url: videoUrl }),
              ...(text(node, ['#video-title', 'h3']) === undefined
                ? {}
                : { title: text(node, ['#video-title', 'h3']) }),
              ...(viewsText === undefined ? {} : { views_text: viewsText.trim() }),
            },
          ]
    rows.push({
      external_id: id,
      ...(firstMatch(channelUrl, /\/(@[^/?#]+)/) === undefined
        ? {}
        : { handle: firstMatch(channelUrl, /\/(@[^/?#]+)/) }),
      ...(byline?.textContent?.trim() === undefined || byline.textContent.trim() === ''
        ? {}
        : { display_name: byline.textContent.trim() }),
      ...(channelUrl === undefined ? {} : { url: channelUrl }),
      videos: evidence.slice(0, MAX_VIDEOS_PER_CANDIDATE),
      source: 'video_attribution',
    })
  }

  return dedupeCandidates(rows)
}

/** 去重键：优先 `UC…`，否则 `@handle`。 */
function identityOf(url: string | undefined): string | undefined {
  return firstMatch(url, /\/channel\/(UC[\w-]{10,})/) ?? firstMatch(url, /\/(@[^/?#]+)/)
}
