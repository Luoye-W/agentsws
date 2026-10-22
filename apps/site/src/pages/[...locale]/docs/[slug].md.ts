import type { APIContext } from 'astro'
import { siteCatalog } from '../../../lib/catalog.js'
import { localeStaticPaths } from '../../../lib/locales.js'

/** 每篇教程的纯文本（软件、各家 AI 读这一份）。 */
export function getStaticPaths() {
  const { slugs } = siteCatalog()
  return localeStaticPaths().flatMap((l) =>
    slugs.map((slug) => ({ params: { ...l.params, slug }, props: { ...l.props, slug } })),
  )
}

export function GET({ props }: APIContext): Response {
  const { lang, slug } = props as { lang: 'zh' | 'en'; slug: string }
  const doc = siteCatalog().guides[lang].find((d) => d.slug === slug)
  if (doc === undefined) throw new Error(`没有这一篇：${slug}`)
  return new Response(doc.markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
}
