/**
 * 结构化数据（JSON-LD，私有 docs/113 §6.1）：教程 `TechArticle`、笔记 `BlogPosting`、
 * 两者都带面包屑 `BreadcrumbList`；首页 `Organization` + `SoftwareApplication`。
 * 只写页面上本来就有的事实（标题、摘要、日期、语言），不写评分、价格这类页面上没有的。
 */
import { GITHUB_URL, SITE_URL } from '../config.js'
import type { Lang } from './markdown.js'

export type JsonLd = Record<string, unknown>

const BRAND = { zh: 'Agents 工坊', en: 'Agents Workshop' } as const
const IN_LANG = { zh: 'zh-CN', en: 'en' } as const

const publisher = (lang: Lang): JsonLd => ({
  '@type': 'Organization',
  name: BRAND[lang],
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/apple-touch-icon.png`,
})

export function breadcrumbs(items: readonly { name: string; url: string }[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  }
}

export function articleLd(o: {
  type: 'TechArticle' | 'BlogPosting'
  lang: Lang
  url: string
  title: string
  description: string
  published?: string
  modified: string
  section?: string
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': o.type,
    headline: o.title,
    description: o.description,
    inLanguage: IN_LANG[o.lang],
    url: o.url,
    mainEntityOfPage: o.url,
    ...(o.published === undefined ? {} : { datePublished: o.published }),
    dateModified: o.modified,
    ...(o.section === undefined ? {} : { articleSection: o.section }),
    author: publisher(o.lang),
    publisher: publisher(o.lang),
    isPartOf: { '@type': 'WebSite', name: BRAND[o.lang], url: `${SITE_URL}/` },
  }
}

export function homeLd(lang: Lang, description: string): JsonLd[] {
  return [
    {
      '@context': 'https://schema.org',
      ...publisher(lang),
      sameAs: [GITHUB_URL],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: BRAND[lang],
      description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Windows, macOS',
      url: `${SITE_URL}${lang === 'en' ? '/en' : ''}/`,
      downloadUrl: `${SITE_URL}${lang === 'en' ? '/en' : ''}/download/`,
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ]
}

/** 放进 `<script type="application/ld+json">` 的字符串（`<` 转义，防提前闭合）。 */
export function ldScript(data: JsonLd): string {
  return JSON.stringify(data).replace(/</gu, '\\u003c')
}
