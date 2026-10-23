import type { APIContext } from 'astro'
import { siteCatalog } from '../../../lib/catalog.js'
import { localeStaticPaths } from '../../../lib/locales.js'

/** 每篇工坊笔记的纯文本。 */
export function getStaticPaths() {
  const { notes } = siteCatalog()
  return localeStaticPaths().flatMap((l) =>
    notes[l.props.lang].map((p) => ({
      params: { ...l.params, slug: p.slug },
      props: { ...l.props, slug: p.slug },
    })),
  )
}

export function GET({ props }: APIContext): Response {
  const { lang, slug } = props as { lang: 'zh' | 'en'; slug: string }
  const post = siteCatalog().notes[lang].find((p) => p.slug === slug)
  if (post === undefined) throw new Error(`没有这一篇：${slug}`)
  return new Response(post.markdown, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  })
}
