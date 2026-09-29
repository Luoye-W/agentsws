/** 每页两份：中文在根下、英文在 `/en/` 下（`[...locale]` 那一段为空就是中文）。 */
import type { Lang } from '../i18n/common.js'

export function localeStaticPaths(): {
  params: { locale: string | undefined }
  props: { lang: Lang }
}[] {
  return [
    { params: { locale: undefined }, props: { lang: 'zh' } },
    { params: { locale: 'en' }, props: { lang: 'en' } },
  ]
}

/** 标题里 `*字*` → `<em>字</em>`（其余转义）。 */
export function emph(s: string): string {
  const esc = s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return esc.replace(/\*([^*]+)\*/g, '<em>$1</em>')
}
