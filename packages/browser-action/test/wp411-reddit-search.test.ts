/**
 * WP411（#13）：插件只读多一种「全站搜帖子」（回补指定时间窗用）——地址白名单、请求校验、按时间停翻页。
 * 替身 Reddit，不打开真站。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  checkRedditReadRequest,
  checkRedditReadUrl,
  redditReadUrl,
  runRedditRead,
} from '../src/index.js'
import { fakeReddit, listing, t3 } from './reddit-fakes.js'

describe('全站搜帖子（只读）', () => {
  it('地址：/search.json、按最新、带时间档；白名单放行', () => {
    const url = redditReadUrl({
      key: 'bf:search:ivra',
      kind: 'search',
      query: '"AI glasses"',
      time: 'month',
      max_pages: 2,
    })
    const u = new URL(url)
    expect(u.pathname).toBe('/search.json')
    expect(u.searchParams.get('q')).toBe('"AI glasses"')
    expect(u.searchParams.get('sort')).toBe('new')
    expect(u.searchParams.get('t')).toBe('month')
    expect(checkRedditReadUrl(url)).toBeUndefined()
    // 别的搜索接口照旧拒
    expect(checkRedditReadUrl('https://old.reddit.com/api/search_reddit_names.json')).toBeDefined()
  })
  it('请求校验：没词、词太长、时间档不对都拒', () => {
    const base = { key: 'bf:search:x', kind: 'search' as const, max_pages: 1 }
    expect(checkRedditReadRequest({ ...base, query: '' })).toBeDefined()
    expect(checkRedditReadRequest({ ...base, query: 'x'.repeat(201) })).toBeDefined()
    expect(
      checkRedditReadRequest({ ...base, query: 'IVRA', time: 'decade' as never }),
    ).toBeDefined()
    expect(checkRedditReadRequest({ ...base, query: 'IVRA', time: 'week' })).toBeUndefined()
  })
  it('按最新翻页，翻到比回补起点早的就停（没漏）', async () => {
    const since = 1_760_000_000
    const reddit = fakeReddit(
      {
        '/search.json?q=IVRA&sort=new&t=week': listing(
          [t3('a1', { created_utc: since + 500 }), t3('a2', { created_utc: since + 100 })],
          't3_a2',
        ),
        '/search.json?after=t3_a2&q=IVRA&sort=new&t=week': listing([
          t3('a3', { created_utc: since + 10 }),
          t3('a4', { created_utc: since - 10 }),
        ]),
      },
      { user: 'ivra_official' },
    )
    const res = await runRedditRead(
      {
        id: 'rj_bf',
        workspace_id: 'ws_1',
        title: '回补',
        created_at: '2026-10-18T00:00:00.000Z',
        reads: [
          { key: 'bf:search:ivra', kind: 'search', query: 'IVRA', since_utc: since, max_pages: 3 },
        ],
      },
      { fetch: reddit.fetch, sleep: vi.fn(async () => {}), stopped: () => false, gapMs: 0 },
    )
    expect(res.outcome).toBe('done')
    expect(res.parts[0]?.items.map((i) => i.name)).toEqual(['t3_a1', 't3_a2', 't3_a3'])
    expect(res.parts[0]?.reached_stop).toBe(true)
    expect(res.parts[0]?.pages).toBe(2)
  })
})
