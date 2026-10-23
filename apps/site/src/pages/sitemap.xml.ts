import { siteCatalog } from '../lib/catalog.js'
import { hubIds } from '../lib/hubs.js'
import { type SitemapPage, sitemapXml } from '../lib/seo.js'

/** 站点地图：每页中英各一条，互标 hreflang；教程与笔记带最后修改日。 */
export function GET(): Response {
  const c = siteCatalog()
  const guides: SitemapPage[] = c.guides.zh.map((d) => ({
    path: `/docs/${d.slug}/`,
    lastmod: {
      zh: d.updated,
      en: c.guides.en.find((e) => e.slug === d.slug)?.updated ?? d.updated,
    },
  }))
  const notes: SitemapPage[] = c.notes.zh.map((p) => ({
    path: `/blog/${p.slug}/`,
    lastmod: { zh: p.updated, en: c.notes.en.find((e) => e.slug === p.slug)?.updated ?? p.updated },
  }))
  const pages: SitemapPage[] = [
    { path: '/' },
    { path: '/roles/' },
    { path: '/pricing/' },
    { path: '/download/' },
    { path: '/docs/' },
    ...hubIds().map((id) => ({ path: `/docs/roles/${id}/` })),
    ...guides,
    ...(notes.length === 0 ? [] : [{ path: '/blog/' }, ...notes]),
    { path: '/changelog/', lastmod: { zh: c.changelog.zh.updated, en: c.changelog.en.updated } },
    { path: '/terms/' },
    { path: '/privacy/' },
    { path: '/refund/' },
  ]
  return new Response(sitemapXml(pages), { headers: { 'content-type': 'application/xml' } })
}
