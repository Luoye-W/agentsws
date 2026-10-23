import type { APIContext } from 'astro'
import { siteCatalog } from '../../lib/catalog.js'
import { localeStaticPaths } from '../../lib/locales.js'

/** 更新日志整份的纯文本。 */
export const getStaticPaths = localeStaticPaths

export function GET({ props }: APIContext): Response {
  const { lang } = props as { lang: 'zh' | 'en' }
  return new Response(siteCatalog().changelog[lang].markdown, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  })
}
