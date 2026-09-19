/**
 * 解析器共用的那几个小工具。
 *
 * 一条贯穿全部解析器的纪律：**选择器是会变的，所以每一格都给一串候选，
 * 而且一个都没命中时回 `undefined` 而不是空字符串**。
 * 平台每隔几个月就会换一次 DOM；那时候正确的行为是"这一格我读不到"，
 * 不是"这个人没有名字"。
 */

/** 按顺序试一串选择器，返回第一个命中的元素。 */
export function pick(root: ParentNode, selectors: readonly string[]): Element | undefined {
  for (const selector of selectors) {
    const hit = root.querySelector(selector)
    if (hit !== null) return hit
  }
  return undefined
}

/** 同上，但取文本（`textContent` 去空白）。读不到回 `undefined`。 */
export function text(root: ParentNode, selectors: readonly string[]): string | undefined {
  const hit = pick(root, selectors)
  const value = hit?.textContent?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** `<meta property="og:title">` 一类。 */
export function meta(doc: Document, names: readonly string[]): string | undefined {
  for (const name of names) {
    const hit =
      doc.querySelector(`meta[property="${name}"]`) ?? doc.querySelector(`meta[name="${name}"]`)
    const value = hit?.getAttribute('content')?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** `<link rel="canonical">`。 */
export function canonical(doc: Document): string | undefined {
  const value = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** 一段文本里第一个匹配组。 */
export function firstMatch(value: string | undefined, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined
  return pattern.exec(value)?.[1]
}

/** 把相对链接补成绝对的；补不出来就丢掉（半截 href 没有意义）。 */
export function absolute(href: string | null | undefined, base: string): string | undefined {
  if (href === null || href === undefined || href === '') return undefined
  try {
    return new URL(href, base).toString()
  } catch {
    return undefined
  }
}

/** ISO 8601 的时长（`PT17M31S`）→ 秒。认不出回 `undefined`。 */
export function isoDurationSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim())
  if (m === null) return undefined
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return seconds > 0 ? seconds : undefined
}
