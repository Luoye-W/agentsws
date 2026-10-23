/** 移植自 agentsws-extension `src/lib/kol/utils/bioLink.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/bioLink.ts` @ d25b877（原移植基准 25bbeae；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Link-in-bio pages (Linktree, Beacons) read from the user's own browser.
 *
 * This is the extension's founding argument in one file. A creator's Linktree
 * is where their shop, their press kit, their other platforms and — often —
 * their business email actually live, and it is exactly the page our
 * server-side actor cannot reach: datacenter IPs get an empty shell or a
 * block, reliably enough that the field came back blank for whole batches. A
 * real browser on a real connection is already looking at the rendered page,
 * so the capture costs nothing and cannot be fingerprinted apart from an
 * ordinary visit.
 *
 * Both sites are Next.js apps that serialize their page props into a
 * `__NEXT_DATA__` script tag. That blob is preferred over DOM selectors
 * everywhere it can be: class names on these pages are hashed and change
 * without notice, while the props carry titles, positions and link types the
 * DOM has already thrown away. The DOM is the fallback, not the plan.
 */

export type BioLinkPlatform = "linktree" | "beacons"

export type BioLinkItem = {
  title?: string
  url: string
}

export type BioLinkSocial = {
  /** Platform name as the page labels it ("INSTAGRAM"), when it labels one. */
  type?: string
  url: string
}

export type BioLinkSnapshot = {
  platform: BioLinkPlatform
  /** The page's own handle — "kenyadriveit" from linktr.ee/kenyadriveit. */
  slug: string
  sourceUrl: string
  links: BioLinkItem[]
  socialLinks: BioLinkSocial[]
  emails: string[]
  bio?: string
  displayName?: string
  avatarUrl?: string
}

const HOSTS: Record<string, BioLinkPlatform> = {
  "linktr.ee": "linktree",
  "www.linktr.ee": "linktree",
  "beacons.ai": "beacons",
  "www.beacons.ai": "beacons"
}

/**
 * Reserved first segments — the marketing site, not somebody's page. A
 * capture of /pricing attached to a creator would be worse than no capture.
 */
const RESERVED_SLUGS = new Set([
  "",
  "s",
  "admin",
  "login",
  "signup",
  "register",
  "pricing",
  "discover",
  "explore",
  "about",
  "blog",
  "help",
  "support",
  "terms",
  "privacy",
  "legal",
  "settings",
  "account",
  "dashboard",
  "onboarding",
  "marketplace",
  "templates",
  "features"
])

export function bioLinkPlatform(href: string): BioLinkPlatform | null {
  try {
    return HOSTS[new URL(href).hostname.toLowerCase()] ?? null
  } catch {
    return null
  }
}

/** The page's slug, or null when the URL is not one creator's page. */
export function bioLinkSlug(href: string): string | null {
  try {
    const url = new URL(href)
    if (!HOSTS[url.hostname.toLowerCase()]) return null
    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length !== 1) return null
    const slug = decodeURIComponent(segments[0])
    if (RESERVED_SLUGS.has(slug.toLowerCase())) return null
    return slug
  } catch {
    return null
  }
}

export function isBioLinkPage(href: string): boolean {
  return bioLinkSlug(href) !== null
}

/* ------------------------------------------------------------------ *
 * Embedded page props
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>

function readNextData(): Json | null {
  const script = document.getElementById("__NEXT_DATA__")
  if (!script?.textContent) return null
  try {
    const parsed = JSON.parse(script.textContent)
    return parsed && typeof parsed === "object" ? (parsed as Json) : null
  } catch {
    return null
  }
}

/**
 * Breadth-first search for a key anywhere under `root`.
 *
 * Deliberately not a hardcoded path. `props.pageProps.links` is where
 * Linktree keeps its links TODAY; it has also been `pageProps.account.links`,
 * and Beacons nests its blocks differently again. A path that is right until
 * the next deploy is a capture that silently returns nothing, on a page the
 * user can plainly see has links on it. Breadth-first so the shallowest —
 * i.e. the page-level — match wins over an incidental one deep in a config
 * object.
 */
function findByKey(root: unknown, key: string, maxNodes = 4000): unknown {
  const queue: unknown[] = [root]
  let seen = 0

  while (queue.length > 0 && seen < maxNodes) {
    const node = queue.shift()
    seen += 1
    if (!node || typeof node !== "object") continue

    if (!Array.isArray(node)) {
      const record = node as Json
      if (key in record && record[key] != null) return record[key]
      for (const value of Object.values(record)) queue.push(value)
      continue
    }

    for (const value of node) queue.push(value)
  }

  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Absolute http(s) URL, or undefined — relative hrefs are page chrome. */
function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function emailFromMailto(value: unknown): string | undefined {
  const raw = asString(value)
  if (!raw?.toLowerCase().startsWith("mailto:")) return undefined
  const address = raw.slice(7).split("?")[0].trim().toLowerCase()
  return address.includes("@") ? address : undefined
}

/**
 * Turn whatever array the props handed us into links.
 *
 * Both products model a page as an ordered list of heterogeneous blocks:
 * classic links, headers, embeds, images. Only the ones carrying a URL are
 * links, and the mailto entries among them are contacts rather than links —
 * pulled out here so a business email never hides inside a link list.
 */
function readLinkArray(value: unknown): {
  links: BioLinkItem[]
  emails: string[]
} {
  if (!Array.isArray(value)) return { links: [], emails: [] }

  const links: BioLinkItem[] = []
  const emails: string[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Json
    const rawUrl =
      record.url ?? record.link ?? record.href ?? record.destination

    const email = emailFromMailto(rawUrl)
    if (email) {
      if (!emails.includes(email)) emails.push(email)
      continue
    }

    const url = asHttpUrl(rawUrl)
    if (!url || seen.has(url)) continue
    seen.add(url)

    links.push({
      title:
        asString(record.title) ??
        asString(record.label) ??
        asString(record.text) ??
        asString(record.name),
      url
    })
  }

  return { links, emails }
}

function readSocialArray(value: unknown): BioLinkSocial[] {
  if (!Array.isArray(value)) return []
  const socials: BioLinkSocial[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Json
    const url = asHttpUrl(record.url ?? record.link ?? record.href)
    if (!url || seen.has(url)) continue
    seen.add(url)
    socials.push({
      type: asString(record.type) ?? asString(record.platform),
      url
    })
  }

  return socials
}

/* ------------------------------------------------------------------ *
 * DOM fallback
 * ------------------------------------------------------------------ */

/**
 * Every outbound anchor on the page, for when the props are absent or shaped
 * in a way this build has never seen. Links back into the host site are
 * navigation ("report this page", "make your own"), never the creator's.
 */
function collectDomLinks(hostname: string): {
  links: BioLinkItem[]
  emails: string[]
} {
  const links: BioLinkItem[] = []
  const emails: string[] = []
  const seen = new Set<string>()

  for (const anchor of Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]")
  )) {
    const email = emailFromMailto(anchor.getAttribute("href"))
    if (email) {
      if (!emails.includes(email)) emails.push(email)
      continue
    }

    const url = asHttpUrl(anchor.href)
    if (!url || seen.has(url)) continue
    const host = new URL(url).hostname.toLowerCase()
    if (host === hostname || host === `www.${hostname}`) continue
    if (host.endsWith("linktr.ee") || host.endsWith("beacons.ai")) continue
    seen.add(url)
    links.push({ title: anchor.textContent?.trim() || undefined, url })
  }

  return { links, emails }
}

/** Addresses written as text ("business@…"), which many pages do instead. */
function collectTextEmails(): string[] {
  const text = document.body?.innerText?.slice(0, 20000) || ""
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  const emails: string[] = []
  for (const match of matches) {
    const address = match.trim().toLowerCase()
    // Sentry/analytics keys and image filenames pick up @ signs too.
    if (address.length > 96) continue
    if (!emails.includes(address)) emails.push(address)
    if (emails.length >= 5) break
  }
  return emails
}

function metaContent(selector: string) {
  return (
    document.querySelector<HTMLMetaElement>(selector)?.content?.trim() ||
    undefined
  )
}

/* ------------------------------------------------------------------ *
 * The capture
 * ------------------------------------------------------------------ */

/**
 * Read the current link-in-bio page. Returns null when the page is not one
 * creator's page, or when nothing has rendered yet — the strip's retry loop
 * waits on that null, the same as every other scraper here.
 */
export function readBioLinkSnapshot(): BioLinkSnapshot | null {
  const href = window.location.href
  const platform = bioLinkPlatform(href)
  const slug = bioLinkSlug(href)
  if (!platform || !slug) return null

  const nextData = readNextData()
  const pageProps = nextData
    ? ((findByKey(nextData, "pageProps") ?? nextData) as Json)
    : null

  const fromProps = pageProps
    ? readLinkArray(
        findByKey(pageProps, "links") ??
          findByKey(pageProps, "blocks") ??
          findByKey(pageProps, "modules")
      )
    : { links: [], emails: [] }

  const hostname = new URL(href).hostname.toLowerCase().replace(/^www\./, "")
  const fromDom = collectDomLinks(hostname)

  /*
    Props first, DOM second — and the DOM is a supplement, not a replacement.
    A page can serialize its classic links and render a footer contact that
    only exists in markup; taking the union of both, deduped by URL, is the
    only version that captures the whole page.
  */
  const links: BioLinkItem[] = [...fromProps.links]
  const known = new Set(links.map((link) => link.url))
  for (const link of fromDom.links) {
    if (known.has(link.url)) continue
    known.add(link.url)
    links.push(link)
  }

  const socialLinks = pageProps
    ? readSocialArray(findByKey(pageProps, "socialLinks"))
    : []

  const emails: string[] = []
  for (const email of [
    ...fromProps.emails,
    ...fromDom.emails,
    ...collectTextEmails()
  ]) {
    if (!emails.includes(email)) emails.push(email)
  }

  /*
    "The page really rendered" signal. A Linktree that is still a skeleton has
    a title and nothing else, and a snapshot with no links in it would be
    stored as a creator whose bio page is empty — worse than no snapshot,
    because it looks like an answer.
  */
  if (links.length === 0 && socialLinks.length === 0 && emails.length === 0) {
    return null
  }

  const bio =
    (pageProps
      ? asString(findByKey(pageProps, "description")) ??
        asString(findByKey(pageProps, "bio"))
      : undefined) ?? metaContent('meta[name="description"]')

  const displayName =
    (pageProps
      ? asString(findByKey(pageProps, "pageTitle")) ??
        asString(findByKey(pageProps, "displayName"))
      : undefined) ?? metaContent('meta[property="og:title"]')

  const avatarUrl =
    (pageProps
      ? asHttpUrl(findByKey(pageProps, "profilePictureUrl")) ??
        asHttpUrl(findByKey(pageProps, "avatarUrl"))
      : undefined) ?? metaContent('meta[property="og:image"]')

  return {
    platform,
    slug,
    sourceUrl: href,
    links,
    socialLinks,
    emails,
    bio,
    displayName,
    avatarUrl
  }
}

/** Body of POST /api/plugin/public/bio-link-observations (SaaS contract). */
export type BioLinkObservationPayload = {
  sourceUrl: string
  platform: BioLinkPlatform
  slug: string
  links: BioLinkItem[]
  socialLinks?: BioLinkSocial[]
  emails?: string[]
  bio?: string
  capturedAt: string
}

export function toBioLinkObservationPayload(
  snapshot: BioLinkSnapshot
): BioLinkObservationPayload {
  return {
    sourceUrl: snapshot.sourceUrl,
    platform: snapshot.platform,
    slug: snapshot.slug,
    links: snapshot.links,
    // Omitted rather than sent empty: "we found none" and "there were none"
    // are the same thing here, and an empty array is noise on the wire.
    ...(snapshot.socialLinks.length > 0
      ? { socialLinks: snapshot.socialLinks }
      : {}),
    ...(snapshot.emails.length > 0 ? { emails: snapshot.emails } : {}),
    ...(snapshot.bio ? { bio: snapshot.bio } : {}),
    capturedAt: new Date().toISOString()
  }
}
