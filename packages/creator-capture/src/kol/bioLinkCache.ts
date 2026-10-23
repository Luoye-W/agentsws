/** 移植自 agentsws-extension `src/lib/kol/bioLinkCache.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/bioLinkCache.ts` @ d25b877。 */
/**
 * Link-in-bio pages the user has already opened, kept locally so the capture
 * pays off on the creator card rather than only on the server.
 *
 * A creator's profile shows ONE outbound link — their linktr.ee — and that is
 * what lands in the 外链 / 其他平台 export columns: a redirector, which tells a
 * brand nothing about where the creator actually sells. Having stood on that
 * Linktree once, we know its real destinations; keyed by the redirector's own
 * URL, they can be folded back in the next time that creator is captured.
 *
 * Purely extension-local, like creatorCache. The server does its own
 * attaching (see `attachedCreators`); this is about the row the user copies
 * out of the panel today.
 *
 * 移植自 KOLAgents 浏览器插件 `src/lib/bioLinkCache.ts` @ 25bbeae。
 * **改了什么**：旧插件框架自带的存储包 换成 `src/lib/storage.ts` 的
 * {@link KeyValueStore}（注入，可测）；旧仓是"一条缓存一个 key"，这里改成
 * **一个 key 装一张表**（`agentsws.biolinks`）并带上限——WP119 的纪律是
 * `chrome.storage.local` 里的东西要能在设置页一眼看完、一键清掉，几百个散 key
 * 做不到这件事。`bioLinkCacheKey` / `expandBioLinks` / `mergeProfileLinks`
 * 三个纯函数逐字未动。
 */
import type { KeyValueStore } from "../storage.js"

import type { BioLinkSnapshot } from "./utils/bioLink.js"
import type { ProfileLink } from "./utils/creatorSnapshot.js"

/** 这张表在 `chrome.storage.local` 里占的那一个 key。 */
export const BIO_LINK_CACHE_KEY = "agentsws.biolinks"

/**
 * 最多记多少个 redirector。满了丢**最旧**的（按 `cachedAt`）。
 * 一个 key 里塞几千条快照，设置页读一次就卡——上限是为此存在的，不是为了省空间。
 */
export const BIO_LINK_CACHE_LIMIT = 200

export type CachedBioLink = {
  snapshot: BioLinkSnapshot
  cachedAt: string
}

type BioLinkTable = Record<string, CachedBioLink>

function asTable(raw: unknown): BioLinkTable {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  return raw as BioLinkTable
}

/**
 * Trailing slashes, query strings and www differ between how a creator writes
 * their link and how the page's own URL reads; the key must not.
 */
export function bioLinkCacheKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
    if (host !== "linktr.ee" && host !== "beacons.ai") return null
    const slug = parsed.pathname.split("/").filter(Boolean)[0]
    if (!slug) return null
    return `bio-link-cache:${host}:${decodeURIComponent(slug).toLowerCase()}`
  } catch {
    return null
  }
}

export async function saveBioLinkCache(
  store: KeyValueStore,
  snapshot: BioLinkSnapshot
) {
  const key = bioLinkCacheKey(snapshot.sourceUrl)
  if (!key) return
  const table = asTable((await store.get([BIO_LINK_CACHE_KEY]))[BIO_LINK_CACHE_KEY])
  table[key] = { snapshot, cachedAt: new Date().toISOString() }
  await store.set({ [BIO_LINK_CACHE_KEY]: trimBioLinkTable(table) })
}

export async function getBioLinkCache(
  store: KeyValueStore,
  url: string
): Promise<CachedBioLink | undefined> {
  const key = bioLinkCacheKey(url)
  if (!key) return undefined
  const table = asTable((await store.get([BIO_LINK_CACHE_KEY]))[BIO_LINK_CACHE_KEY])
  return table[key]
}

/** 一次读回面板要用的一整批（`expandBioLinks` 的第二个参数就是它）。 */
export async function getBioLinkCaches(
  store: KeyValueStore,
  urls: readonly string[]
): Promise<(CachedBioLink | undefined)[]> {
  const table = asTable((await store.get([BIO_LINK_CACHE_KEY]))[BIO_LINK_CACHE_KEY])
  return urls.map((url) => {
    const key = bioLinkCacheKey(url)
    return key ? table[key] : undefined
  })
}

/** 超上限就按 `cachedAt` 从旧到新丢，直到装得下。 */
export function trimBioLinkTable(table: BioLinkTable): BioLinkTable {
  const entries = Object.entries(table)
  if (entries.length <= BIO_LINK_CACHE_LIMIT) return table
  const sorted = entries.sort((a, b) =>
    Date.parse(a[1].cachedAt) - Date.parse(b[1].cachedAt)
  )
  return Object.fromEntries(sorted.slice(sorted.length - BIO_LINK_CACHE_LIMIT))
}

/** 清掉整张表（设置页那个「清除本机数据」按钮要用）。 */
export async function clearBioLinkCache(store: KeyValueStore) {
  await store.remove([BIO_LINK_CACHE_KEY])
}

/**
 * Expand any link-in-bio redirector among `links` into what it points at.
 *
 * The redirector itself is KEPT: it is the link the creator publishes, it is
 * what the user sees on the profile, and dropping it would make the panel
 * disagree with the page. The destinations are appended after it, deduped
 * against everything already present, so the existing 外链 count and the
 * 其他平台 export column simply get richer without changing shape.
 */
export function expandBioLinks(
  links: ProfileLink[],
  cached: (CachedBioLink | undefined)[]
): ProfileLink[] {
  const extra: ProfileLink[] = []
  for (const entry of cached) {
    if (!entry) continue
    for (const link of entry.snapshot.links) {
      extra.push({ title: link.title, url: link.url })
    }
    for (const social of entry.snapshot.socialLinks) {
      extra.push({ title: social.type, url: social.url })
    }
  }
  return mergeProfileLinks(links, extra)
}

/**
 * Append `extra` to `base`, deduped by URL, order preserved.
 *
 * Separate from expandBioLinks because the expansion has to be re-applied:
 * the YouTube card re-reads the page every few seconds as the About block and
 * the video grid fill in, and each of those re-reads returns a snapshot that
 * knows nothing about a Linktree the user visited. Without a way to put the
 * destinations back, the panel would show them for a moment and then quietly
 * drop them.
 */
export function mergeProfileLinks(
  base: ProfileLink[],
  extra: ProfileLink[]
): ProfileLink[] {
  if (extra.length === 0) return base
  const out = [...base]
  const seen = new Set(out.map((link) => link.url))
  for (const link of extra) {
    if (seen.has(link.url)) continue
    seen.add(link.url)
    out.push(link)
  }
  return out
}
