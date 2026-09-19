/**
 * Instagram / TikTok 的**最小版**频道页卡片（WP119 定论 2：
 * 「Instagram / TikTok 先做频道页卡片的最小版」）。
 *
 * 「最小版」是有意的：这两家的主页 DOM 变得比 YouTube 勤，而且关键数字
 * （IG 的粉丝数、TikTok 的播放量）经常只在 `og:description` 那一行里稳定出现。
 * 与其照着当下这一版 DOM 写三百行选择器、下个月全废，不如先把
 * **身份 + 粉丝数 + 主页链接**这三格做扎实——它们够用来体检、够用来
 * 收进红人库、够用来复制一行。
 *
 * 读不到的格子一律不填（不是填 0、不是填空串）。
 */

import { parseCompactCount } from '../counts.js'
import type { CreatorSnapshot, RecentItem } from '../snapshot.js'
import { absolute, canonical, firstMatch, meta, text } from './dom.js'

/** IG 的 `og:description` 长这样：`1.2M Followers, 300 Following, 900 Posts …`。 */
const IG_DESC = /([\d.,]+\s*[KMB万亿]?)\s*Followers?/i
const IG_POSTS = /([\d.,]+\s*[KMB万亿]?)\s*Posts?/i
/** TikTok 的 `og:description`：`… 1.2M Followers. 30M Likes. …`。 */
const TT_FOLLOWERS = /([\d.,]+\s*[KMB万亿]?)\s*Followers?/i

export function parseInstagramProfile(
  doc: Document,
  href: string,
  now: string,
): CreatorSnapshot | undefined {
  const handle = firstMatch(canonical(doc) ?? href, /instagram\.com\/([^/?#]+)/)
  if (handle === undefined) return undefined

  const description = meta(doc, ['og:description'])
  // 数字 id 在内联脚本里；读不到就用 handle 当身份（本机库按 handle 也能认人）
  const externalId =
    firstMatch(doc.documentElement.innerHTML, /"profilePage_(\d{3,})"/) ??
    firstMatch(doc.documentElement.innerHTML, /"profile_id"\s*:\s*"(\d{3,})"/) ??
    `@${handle}`

  const followersText =
    firstMatch(description, IG_DESC) ??
    text(doc, ['header a[href*="/followers"] span[title]', 'header li:nth-child(2) span'])
  const postsText = firstMatch(description, IG_POSTS)

  const name =
    firstMatch(meta(doc, ['og:title']), /^(.*?)\s*\(@[^)]+\)/) ??
    text(doc, ['header section h1', 'h1']) ??
    `@${handle}`

  const links: string[] = []
  for (const a of doc.querySelectorAll('header a[href^="http"]')) {
    const url = absolute(a.getAttribute('href'), href)
    if (url !== undefined && !url.includes('instagram.com')) links.push(url)
  }

  return {
    platform: 'instagram',
    external_id: externalId,
    handle: `@${handle}`,
    name,
    ...(meta(doc, ['og:image']) === undefined ? {} : { avatar_url: meta(doc, ['og:image']) }),
    page_url: canonical(doc) ?? href,
    followers: parseCompactCount(followersText),
    ...(followersText === undefined ? {} : { followers_text: followersText.trim() }),
    video_count: parseCompactCount(postsText),
    links: [...new Set(links)],
    recent_items: instagramTiles(doc, href),
    observed_at: now,
  }
}

/** 主页九宫格里那几块。只取 id 与链接——播放数 IG 只在部分卡片上印。 */
function instagramTiles(doc: Document, href: string): RecentItem[] {
  const out: RecentItem[] = []
  for (const a of doc.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const url = absolute(a.getAttribute('href'), href)
    const id = firstMatch(url, /\/(?:p|reel)\/([^/?#]+)/)
    if (id === undefined) continue
    const blob = a.textContent ?? ''
    const viewsText = /^[\d,.]+\s*[KMB万亿]?$/.test(blob.trim()) ? blob.trim() : undefined
    out.push({
      content_id: id,
      ...(url === undefined ? {} : { url }),
      views: parseCompactCount(viewsText),
    })
    if (out.length >= 120) break
  }
  return out
}

export function parseTikTokProfile(
  doc: Document,
  href: string,
  now: string,
): CreatorSnapshot | undefined {
  const handle = firstMatch(canonical(doc) ?? href, /tiktok\.com\/(@[^/?#]+)/)
  if (handle === undefined) return undefined

  const description = meta(doc, ['og:description'])
  const followersText =
    text(doc, ['[data-e2e="followers-count"]']) ?? firstMatch(description, TT_FOLLOWERS)

  const name =
    text(doc, ['[data-e2e="user-subtitle"]', '[data-e2e="user-title"]', 'h1']) ??
    firstMatch(meta(doc, ['og:title']), /^(.*?)\s*\(@/) ??
    handle

  const bio = text(doc, ['[data-e2e="user-bio"]']) ?? description

  const links: string[] = []
  for (const a of doc.querySelectorAll('[data-e2e="user-link"], a[href^="http"]')) {
    const url = absolute(a.getAttribute('href'), href)
    if (url !== undefined && !url.includes('tiktok.com')) links.push(url)
  }

  return {
    platform: 'tiktok',
    external_id: handle,
    handle,
    name,
    ...(meta(doc, ['og:image']) === undefined ? {} : { avatar_url: meta(doc, ['og:image']) }),
    page_url: canonical(doc) ?? href,
    followers: parseCompactCount(followersText),
    ...(followersText === undefined ? {} : { followers_text: followersText.trim() }),
    ...(bio === undefined ? {} : { bio }),
    links: [...new Set(links)],
    recent_items: tiktokTiles(doc, href),
    observed_at: now,
  }
}

/** TikTok 主页的作品格子。`video-views` 是这一家最稳的一格。 */
function tiktokTiles(doc: Document, href: string): RecentItem[] {
  const out: RecentItem[] = []
  for (const node of doc.querySelectorAll('[data-e2e="user-post-item"]')) {
    const url = absolute(node.querySelector('a[href]')?.getAttribute('href'), href)
    const id = firstMatch(url, /\/(?:video|photo)\/(\d+)/)
    if (id === undefined) continue
    out.push({
      content_id: id,
      ...(url === undefined ? {} : { url }),
      views: parseCompactCount(text(node, ['[data-e2e="video-views"]'])),
      ...(node.querySelector('img')?.getAttribute('alt') === undefined
        ? {}
        : { title: node.querySelector('img')?.getAttribute('alt') ?? undefined }),
    })
    if (out.length >= 120) break
  }
  return out
}
