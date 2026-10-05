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

/**
 * 正文里点名的外站名字 → 链接（新窗口、`rel="noopener"`），其余转义。只认 http(s) 链接。
 * 例：`linkNames('Foo 很好', { Foo: 'https://foo.example' })`。
 */
export function linkNames(s: string, links: Readonly<Record<string, string>>): string {
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const names = Object.keys(links)
    .filter((n) => /^https?:\/\//u.test(links[n] ?? ''))
    .sort((a, b) => b.length - a.length)
  if (names.length === 0) return esc(s)
  const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  let out = ''
  let last = 0
  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index))
    out += `<a href="${esc(links[m[0]] ?? '')}" target="_blank" rel="noopener">${esc(m[0])}</a>`
    last = (m.index ?? 0) + m[0].length
  }
  return out + esc(s.slice(last))
}
