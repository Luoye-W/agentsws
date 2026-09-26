/**
 * WP155 测试共用：录好的替身响应 + 一个记账的假 fetch（**不联网**）。
 * 替身响应的出处见 `fixtures/search/README.md`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SearchFetch } from '../src/search/provider.js'

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/search', `${name}.json`), 'utf8'))

export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** 按网址里的片段挑响应；没挑到就 500（测试里等于"不该打这一下"）。 */
export function fakeFetch(
  routes: [match: string, reply: { status?: number; body: unknown } | (() => never)][],
): { fetch: SearchFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: SearchFetch = async (url, init) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const hit = routes.find(([m]) => url.includes(m))
    if (hit === undefined) return new Response('{"message":"no route"}', { status: 500 })
    const reply = hit[1]
    if (typeof reply === 'function') return reply()
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  return { fetch, calls }
}

/** 一个像 fetch 被掐断（超时）那样抛的错。 */
export function abortError(): never {
  const err = new Error('aborted')
  err.name = 'AbortError'
  throw err
}
