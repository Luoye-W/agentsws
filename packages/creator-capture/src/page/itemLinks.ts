/**
 * WP502（决策 1764 B）：**在页面里**给采集器读到的近期作品配上原作品链接。
 *
 * 新写的接线：采集器（插件同一套，本体不动）只留了作品的标题和封面，没留链接。这里在采集器跑完之后
 * 再看一眼同一页，按采集器自己留下的两个格子把链接找回来，顺序与 `recentItems` 一一对应：
 *
 * 1. **封面**：页面上 `src` 与这条作品封面相同的那张图，它所在的链接；
 * 2. **标题**：链接的 `title` / 文字 / 里面图片的 `alt` 与这条作品标题相同（YouTube 标题链接、TikTok 配文）；
 *    Instagram 的「标题」就是帖子短码，链接里带这个短码的那一条。
 *
 * 找到的链接过 `contentUrlOf`（只认这个平台上的一条作品，规整掉分享参数）；找不到就是 `null`。
 * 同插件的自律：只读，不点、不滚、不发请求。
 */

import type { CapturePlatform, RecentItem } from '../kol/utils/creatorSnapshot.js'
import { contentUrlOf } from '../wire/contentUrl.js'

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** 近期作品各自的原作品链接（与 `items` 一一对应；找不到的那一格是 `null`）。 */
export function readRecentItemUrls(
  platform: CapturePlatform,
  items: readonly RecentItem[],
): (string | null)[] {
  if (items.length === 0) return []
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
  const byThumb = new Map<string, string>()
  const byTitle = new Map<string, string>()
  const all: string[] = []
  for (const a of anchors) {
    const url = contentUrlOf(a.href, platform)
    if (url === undefined) continue
    all.push(url)
    const img = a.querySelector('img')
    if (img?.src && !byThumb.has(img.src)) byThumb.set(img.src, url)
    for (const key of [
      a.getAttribute('title'),
      a.textContent,
      img?.alt,
      a.getAttribute('aria-label'),
    ]) {
      const k = norm(key)
      if (k !== '' && !byTitle.has(k)) byTitle.set(k, url)
    }
  }
  // 封面图不在链接里面（YouTube 的封面链接与标题链接是两个兄弟）：图往上找最近的作品链接
  const thumbOf = (src: string): string | undefined => {
    const hit = byThumb.get(src)
    if (hit !== undefined) return hit
    const img = Array.from(document.images).find((i) => i.src === src)
    const a = img?.closest<HTMLAnchorElement>('a[href]')
    return a ? contentUrlOf(a.href, platform) : undefined
  }
  return items.map((item) => {
    const viaThumb = item.thumbnailUrl ? thumbOf(item.thumbnailUrl) : undefined
    if (viaThumb !== undefined) return viaThumb
    const title = norm(item.title)
    if (title === '') return null
    const viaTitle = byTitle.get(title)
    if (viaTitle !== undefined) return viaTitle
    if (platform === 'instagram') {
      const code = all.find((u) => u.includes(`/${title}/`))
      if (code !== undefined) return code
    }
    return null
  })
}
