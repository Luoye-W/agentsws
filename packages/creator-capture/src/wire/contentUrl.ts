/**
 * WP502（决策 1764 B）：近期作品的**原作品链接**——存入红人池时记下，红人详情里点一下在浏览器里打开。
 *
 * 新写的接线（不是移植的算法）：采集器（`collectors/`，插件同一套、本体不动）读近期作品时没留作品链接，
 * 只留了标题和封面。这里两件事：
 *
 * 1. {@link contentUrlOf}：一个链接是不是这个平台上的**一条作品**（YouTube 视频 / Shorts、TikTok 视频 / 图文、
 *    Instagram 帖子 / Reel），是就规整成一个干净的地址（去掉分享参数、跟踪参数），不是就不认。
 *    页面上读到的、插件送来的、AI 填的，都过这一道再存——存下的链接最后会被人点开。
 * 2. {@link derivedContentUrlOf}：页面上没读到链接时，从采集器已有的格子里**推**出来——
 *    YouTube 封面地址里就有视频 id（`i.ytimg.com/vi/<id>/…`）；Instagram 采集器把帖子短码记在标题那一格。
 *    TikTok 推不出来（封面是签名过的 CDN 地址，标题是配文），只能靠页面上读到的链接（`page/itemLinks.ts`）。
 */

import type { CapturePlatform } from '../kol/utils/creatorSnapshot.js'

const YT_ID = /^[\w-]{11}$/
const IG_CODE = /^[\w-]{5,40}$/

function parse(href: string): URL | undefined {
  try {
    const u = new URL(href)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : undefined
  } catch {
    return undefined
  }
}

const hostIs = (u: URL, domain: string): boolean =>
  u.hostname === domain || u.hostname.endsWith(`.${domain}`)

/**
 * 这个链接是不是 `platform` 上的一条作品；是就回规整过的 https 地址，不是回 `undefined`。
 * `platform` 不给就三家都试。
 */
export function contentUrlOf(
  href: string | undefined,
  platform?: CapturePlatform | string,
): string | undefined {
  if (href === undefined || href === '' || href.length > 600) return undefined
  const u = parse(href)
  if (u === undefined) return undefined
  const want = (p: CapturePlatform): boolean => platform === undefined || platform === p
  if (want('youtube') && (hostIs(u, 'youtube.com') || u.hostname === 'youtu.be')) {
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1)
      return YT_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined
    }
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v') ?? ''
      return YT_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined
    }
    const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)
    return shorts ? `https://www.youtube.com/shorts/${shorts[1]}` : undefined
  }
  if (want('tiktok') && hostIs(u, 'tiktok.com')) {
    const m = u.pathname.match(/^\/@([\w.-]{1,64})\/(video|photo)\/(\d{6,25})\/?$/)
    return m ? `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}` : undefined
  }
  if (want('instagram') && hostIs(u, 'instagram.com')) {
    const m = u.pathname.match(/^(?:\/[\w.]{1,40})?\/(p|reel|reels|tv)\/([\w-]{5,40})\/?$/)
    if (!m) return undefined
    const kind = m[1] === 'reels' ? 'reel' : m[1]
    return `https://www.instagram.com/${kind}/${m[2]}/`
  }
  return undefined
}

/**
 * 页面上没读到链接时，从采集器已有的格子里推一条作品链接（推不出来回 `undefined`）。
 * - YouTube：封面地址 `https://i.ytimg.com/vi/<id>/…`（`vi_webp` 也认）里的视频 id；
 * - Instagram：采集器把帖子短码记在标题那一格（`instagramProfile.ts` 的 `collectRecentItems`）；
 * - TikTok：推不出来。
 */
export function derivedContentUrlOf(
  platform: CapturePlatform | string,
  item: { title?: string | undefined; thumbnail_url?: string | undefined },
): string | undefined {
  if (platform === 'youtube' && item.thumbnail_url !== undefined) {
    const u = parse(item.thumbnail_url)
    if (u === undefined || !hostIs(u, 'ytimg.com')) return undefined
    const m = u.pathname.match(/^\/(?:vi|vi_webp)\/([\w-]{11})\//)
    return m ? `https://www.youtube.com/watch?v=${m[1]}` : undefined
  }
  if (platform === 'instagram' && item.title !== undefined) {
    const code = item.title.trim()
    return IG_CODE.test(code) ? `https://www.instagram.com/p/${code}/` : undefined
  }
  return undefined
}
