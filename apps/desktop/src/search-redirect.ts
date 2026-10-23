/**
 * WP484（WP464 §8 第 1 条）：Google 结果链接的**跳转地址**换成目标网址。
 *
 * 10-23 真机：内置浏览器（没 cookie、没登录）拿到的 Google 结果页里，每条结果的链接只剩
 * `/goto?url=<不透明的一串>`，目标网址不在页面里（WP464 那 9 次「页面上有 9–10 个结果标题，一条都没读出来」）。
 * 这个跳转地址自己会 302 到目标网址——跟人点一下结果一样，只是**不跟过去**：读到 `Location` 就停。
 *
 * 这个文件**不 import electron**：真正发请求的那一下（`hop`）由 Electron 那一半给（`net.request`、同一个品牌的
 * partition、`redirect: 'manual'`），这里只管并发、校验、去重，好在 vitest 里钉住。
 */
import type { SerpItem } from '@agentsws/browser-action/serp'

/** 一次最多同时换几条（一页 10 条，约四轮换完；别一下子对 Google 发一串请求）。 */
export const REDIRECT_CONCURRENCY = 3

/** 换出来的地址能不能用：只认 http / https，不认 Google 自己的地址（还在 Google 里转圈的不要）。 */
export function usableTarget(location: string | undefined, from: string): string | undefined {
  if (location === undefined || location === '') return undefined
  let u: URL
  try {
    u = new URL(location, from)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  const host = u.hostname.replace(/^www\./, '')
  if (/^google\./.test(host) || host.endsWith('.google.com')) return undefined
  return u.href
}

/**
 * 把带 `redirect` 的那几条换成目标网址（`hop(url)` 回跳转的 `Location`；拿不到回 `undefined`）；
 * 换不出来的那条不要。顺序不变，换出来重复的只留第一条。
 */
export async function resolveSerpRedirects(
  items: readonly SerpItem[],
  hop: (url: string) => Promise<string | undefined>,
  concurrency = REDIRECT_CONCURRENCY,
): Promise<{ items: SerpItem[]; resolved: number; dropped: number }> {
  const targets: (string | undefined)[] = items.map((i) =>
    i.redirect === true ? undefined : i.url,
  )
  const todo = items.flatMap((item, at) => (item.redirect === true ? [at] : []))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = todo[next]
      next += 1
      if (at === undefined) return
      const from = (items[at] as SerpItem).url
      targets[at] = usableTarget(await hop(from).catch(() => undefined), from)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  const seen = new Set<string>()
  const out: SerpItem[] = []
  let resolved = 0
  let dropped = 0
  items.forEach((item, at) => {
    const url = targets[at]
    if (url === undefined || seen.has(url)) {
      dropped += 1
      return
    }
    seen.add(url)
    if (item.redirect === true) resolved += 1
    const { redirect: _drop, ...rest } = item
    out.push({ ...rest, url })
  })
  return { items: out, resolved, dropped }
}
