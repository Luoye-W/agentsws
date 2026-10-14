/**
 * WP328 测试用的**替身 Reddit**：只按白名单地址回 `.json`，一个请求都不出本机。
 * 字段照 Reddit 公开文档里 Listing / t1 / t3 / t4 的形状写（没对真站核：纪律是不打开真 Reddit）。
 */
import type { RedditFetched } from '../src/index.js'

export const t1 = (
  id: string,
  over: Record<string, unknown> = {},
): { kind: string; data: Record<string, unknown> } => ({
  kind: 't1',
  data: {
    id,
    name: `t1_${id}`,
    author: 'alice',
    body: `comment ${id}`,
    subreddit: 'inmoxr',
    parent_id: 't3_p1',
    link_id: 't3_p1',
    link_title: 'Air3 first look',
    permalink: `/r/inmoxr/comments/p1/air3/${id}/`,
    created_utc: 1_760_400_000,
    score: 3,
    ...over,
  },
})

export const t3 = (
  id: string,
  over: Record<string, unknown> = {},
): { kind: string; data: Record<string, unknown> } => ({
  kind: 't3',
  data: {
    id,
    name: `t3_${id}`,
    author: 'bob',
    title: `post ${id}`,
    selftext: `body ${id}`,
    subreddit: 'inmoxr',
    permalink: `/r/inmoxr/comments/${id}/post_${id}/`,
    created_utc: 1_760_400_000,
    num_comments: 2,
    score: 10,
    ...over,
  },
})

export const listing = (children: unknown[], after?: string): unknown => ({
  kind: 'Listing',
  data: { after: after ?? null, before: null, children },
})

export interface FakeReddit {
  fetch(url: string): Promise<RedditFetched>
  calls: string[]
}

/** 地址（去掉 origin 与 query 里的 limit/raw_json）→ 回什么。没登记的回 404。 */
export function fakeReddit(
  routes: Record<string, unknown | RedditFetched>,
  opts: { user?: string } = {},
): FakeReddit {
  const calls: string[] = []
  return {
    calls,
    async fetch(url) {
      calls.push(url)
      const u = new URL(url)
      u.searchParams.delete('limit')
      u.searchParams.delete('raw_json')
      u.searchParams.sort()
      const key = `${u.pathname}${u.search}`
      if (u.pathname === '/api/me.json' && !(key in routes))
        return json(url, opts.user === undefined ? {} : { kind: 't2', data: { name: opts.user } })
      const hit = routes[key]
      if (hit === undefined)
        return { status: 404, url, content_type: 'application/json', body: '{"error":404}' }
      if (typeof hit === 'object' && hit !== null && 'status' in hit && 'body' in hit)
        return hit as RedditFetched
      return json(url, hit)
    },
  }
}

const json = (url: string, body: unknown): RedditFetched => ({
  status: 200,
  url,
  content_type: 'application/json; charset=UTF-8',
  body: JSON.stringify(body),
})
