/**
 * WP328：插件怎么取 Reddit 的 `.json`——**借用户自己的登录会话**，不登录、不碰口令。
 *
 * 1. 先在后台（service worker）直接取，带上 Reddit 的 cookie（有站点权限的插件请求算同站）；
 * 2. 取到的是「没登录」（被跳到登录页 / 401 / 403 / `me.json` 是空的），而且用户开着一个 Reddit 标签页
 *    → 改在那个标签页里取（同一个页面的同源请求，和你自己刷新一下一样）。docs/102 §11 那条「要不要开着标签页」
 *    没在真站核过，两条路都留着。
 *
 * 地址在执行器那一层已经过了白名单（{@link checkRedditReadUrl}）；这里只换「从哪发」，路径不变。
 */
import type { RedditFetched } from '@agentsws/browser-action'

const MAX_BODY = 2_000_000

export type RedditFetch = (url: string) => Promise<RedditFetched>

export function backgroundFetch(doFetch: typeof globalThis.fetch = globalThis.fetch): RedditFetch {
  return async (url) => {
    const res = await doFetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    return {
      status: res.status,
      url: res.url === '' ? url : res.url,
      content_type: res.headers.get('content-type') ?? '',
      body: (await res.text()).slice(0, MAX_BODY),
    }
  }
}

/** 开着的 Reddit 标签页（测试塞假的）。 */
export interface RedditTabs {
  /** 找一个开着的 Reddit 标签页：回 id 与它的 origin。没有回 `undefined`。 */
  find(): Promise<{ id: number; origin: string } | undefined>
  /** 在那个标签页里同源取一次。 */
  fetchIn(tabId: number, url: string): Promise<RedditFetched>
}

const looksLoggedOut = (url: string, res: RedditFetched): boolean => {
  let path = ''
  try {
    path = new URL(res.url).pathname
  } catch {}
  if (/\/(login|register)\b/u.test(path) || res.status === 401 || res.status === 403) return true
  if (new URL(url).pathname === '/api/me.json') return !/"name"\s*:/u.test(res.body)
  return false
}

/** 后台取；看着像没登录且开着 Reddit 标签页 → 这一件活剩下的都改在标签页里取。 */
export function sessionFetch(background: RedditFetch, tabs: RedditTabs): RedditFetch {
  let tab: { id: number; origin: string } | undefined
  const viaTab = (url: string, t: { id: number; origin: string }) => {
    const u = new URL(url)
    return tabs.fetchIn(t.id, `${t.origin}${u.pathname}${u.search}`)
  }
  return async (url) => {
    if (tab !== undefined) return viaTab(url, tab)
    const first = await background(url)
    if (!looksLoggedOut(url, first)) return first
    const found = await tabs.find().catch(() => undefined)
    if (found === undefined) return first
    tab = found
    return viaTab(url, found)
  }
}

/** 真的那一个（`chrome.tabs.query` 按网址找——只认有站点权限的那两个站，不要 `tabs` 权限）。 */
export function chromeRedditTabs(): RedditTabs {
  return {
    async find() {
      const hits = await chrome.tabs.query({
        url: ['https://old.reddit.com/*', 'https://www.reddit.com/*'],
      })
      const t = hits.find((x) => x.id !== undefined && x.url !== undefined)
      if (t?.id === undefined || t.url === undefined) return undefined
      return { id: t.id, origin: new URL(t.url).origin }
    },
    async fetchIn(tabId, url) {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (u: string) => {
          const r = await fetch(u, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          })
          return {
            status: r.status,
            url: r.url,
            content_type: r.headers.get('content-type') ?? '',
            body: (await r.text()).slice(0, 2_000_000),
          }
        },
        args: [url],
      })
      const r = out?.result as RedditFetched | undefined
      if (r === undefined) throw new Error('在 Reddit 标签页里没取到。')
      return r
    },
  }
}
