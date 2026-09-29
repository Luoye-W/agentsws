/**
 * SEO：canonical、hreflang、sitemap、OG 图地址。中文在 `/`、英文在 `/en/`，同一套路径。
 */
import { SITE_URL } from '../config.js'
import { type Lang, localePath } from '../i18n/common.js'

export interface Alternate {
  hreflang: string
  href: string
}

/** 绝对地址（总带结尾斜杠，和 `trailingSlash: 'always'` 一致）。 */
export function absolute(path: string): string {
  const p = path.endsWith('/') || /\.[a-z0-9]+$/iu.test(path) ? path : `${path}/`
  return `${SITE_URL}${p}`
}

/** 一页的中英两个地址 + x-default（指中文）。 */
export function alternates(path: string): Alternate[] {
  const zh = absolute(localePath(path, 'zh'))
  const en = absolute(localePath(path, 'en'))
  return [
    { hreflang: 'zh-CN', href: zh },
    { hreflang: 'en', href: en },
    { hreflang: 'x-default', href: zh },
  ]
}

/** OG 图：`public/og/<key>-<lang>.png`（`scripts/og.mjs` 用品牌标记生成，签进仓库）。 */
export const OG_KEYS = [
  'home',
  'roles',
  'pricing',
  'download',
  'docs',
  'changelog',
  'legal',
] as const
export type OgKey = (typeof OG_KEYS)[number]

export function ogImage(key: OgKey, lang: Lang): string {
  return `${SITE_URL}/og/${key}-${lang}.png`
}

export interface SitemapPage {
  /** 不带语言前缀的路径（`/pricing/`）。 */
  path: string
}

/** sitemap.xml：每页一条中文、一条英文，互相用 xhtml:link 标 hreflang。 */
export function sitemapXml(pages: readonly SitemapPage[]): string {
  const urls = pages.flatMap((p) => {
    const alts = alternates(p.path)
      .map((a) => `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`)
      .join('')
    return (['zh', 'en'] as const).map(
      (lang) => `<url><loc>${absolute(localePath(p.path, lang))}</loc>${alts}</url>`,
    )
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
}
