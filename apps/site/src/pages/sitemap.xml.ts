import { helpSlugs } from '../lib/help.js'
import { sitemapXml } from '../lib/seo.js'

/** 站点地图：每页中英各一条，互标 hreflang。 */
export function GET(): Response {
  const pages = [
    '/',
    '/roles/',
    '/pricing/',
    '/download/',
    '/docs/',
    ...helpSlugs().map((s) => `/docs/${s}/`),
    '/changelog/',
    '/terms/',
    '/privacy/',
    '/refund/',
  ].map((path) => ({ path }))
  return new Response(sitemapXml(pages), { headers: { 'content-type': 'application/xml' } })
}
