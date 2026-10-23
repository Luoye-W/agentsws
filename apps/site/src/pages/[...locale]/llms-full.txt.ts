import type { APIContext } from 'astro'
import { siteCatalog } from '../../lib/catalog.js'
import { localeStaticPaths } from '../../lib/locales.js'
import { llmsFullTxt } from '../../lib/machine.js'

/** `/llms-full.txt`（中文）与 `/en/llms-full.txt`：全部教程与笔记的全文。 */
export const getStaticPaths = localeStaticPaths

export function GET({ props }: APIContext): Response {
  const { lang } = props as { lang: 'zh' | 'en' }
  const c = siteCatalog()
  const docs = [...c.guides[lang], ...c.notes[lang]].map((d) => {
    const item = c.index.items.find(
      (i) => i.lang === lang && i.slug === d.slug && i.kind !== 'changelog',
    )
    return { title: d.title, url: item?.url ?? '', markdown: d.markdown, updated: d.updated }
  })
  return new Response(llmsFullTxt(lang, docs), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
