/**
 * 这一页是什么页（WP119 定论 2）。
 *
 * **内容页要先问**：TikTok 的 `/@someone/video/123` 如果先问"是不是主页"，
 * 前缀一匹配就答成主页了。同一个坑 Instagram 的 `/p/xxx` 也有。
 *
 * 认不出来就回 `undefined`——面板上老老实实说「这一页我看不懂」，
 * 而不是硬解析出一份半对半错的资料。
 */

import type { Platform } from '../snapshot.js'

export type PageKind = 'creator' | 'content' | 'search'

export interface PageRoute {
  platform: Platform
  kind: PageKind
  /** 频道 handle / 内容 id / 搜索词——面板用它当 React key。 */
  subject: string
}

/** YouTube 的 `/@handle`、`/channel/UC…`、`/c/name`。 */
const YT_CHANNEL = /^\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+)/
const IG_RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'stories',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
])

export function routeOf(href: string): PageRoute | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^www\./, '')
  const path = url.pathname

  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    // 内容页先问
    const watch = url.searchParams.get('v')
    if (path === '/watch' && watch !== null) {
      return { platform: 'youtube', kind: 'content', subject: watch }
    }
    const shorts = /^\/shorts\/([\w-]{5,})/.exec(path)
    if (shorts?.[1] !== undefined) {
      return { platform: 'youtube', kind: 'content', subject: shorts[1] }
    }
    if (path === '/results') {
      return {
        platform: 'youtube',
        kind: 'search',
        subject: url.searchParams.get('search_query') ?? '',
      }
    }
    const channel = YT_CHANNEL.exec(path)
    if (channel?.[1] !== undefined) {
      return { platform: 'youtube', kind: 'creator', subject: channel[1] }
    }
    return undefined
  }

  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    const post = /^\/(?:p|reel|tv)\/([^/?#]+)/.exec(path)
    if (post?.[1] !== undefined) {
      return { platform: 'instagram', kind: 'content', subject: post[1] }
    }
    const profile = /^\/([^/?#]+)/.exec(path)
    const name = profile?.[1]
    if (name !== undefined && !IG_RESERVED.has(name)) {
      return { platform: 'instagram', kind: 'creator', subject: `@${name}` }
    }
    return undefined
  }

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const video = /^\/@[^/?#]+\/(?:video|photo)\/(\d+)/.exec(path)
    if (video?.[1] !== undefined) {
      return { platform: 'tiktok', kind: 'content', subject: video[1] }
    }
    if (path === '/search') {
      return { platform: 'tiktok', kind: 'search', subject: url.searchParams.get('q') ?? '' }
    }
    const profile = /^\/(@[^/?#]+)/.exec(path)
    if (profile?.[1] !== undefined) {
      return { platform: 'tiktok', kind: 'creator', subject: profile[1] }
    }
    return undefined
  }

  return undefined
}
