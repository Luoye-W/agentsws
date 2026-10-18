/**
 * WP328：插件的 Reddit 只读——替身本机服务 + 替身 Reddit（内存里的 JSON），不联网、不碰真站。
 */
import type { RedditFetched, RedditReadJob } from '@agentsws/browser-action'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionsLike } from '../src/lib/ads/permissions'
import { type RedditTabs, sessionFetch } from '../src/lib/reddit/fetcher'
import { pollRedditOnce, readRedditStatus } from '../src/lib/reddit/poller'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'

const json = (url: string, body: unknown, status = 200): RedditFetched => ({
  status,
  url,
  content_type: 'application/json',
  body: JSON.stringify(body),
})
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })

const perms = (granted: boolean): PermissionsLike => ({
  contains: async () => granted,
  request: async () => granted,
  remove: async () => true,
})

const JOB: RedditReadJob = {
  id: 'rj_1',
  workspace_id: 'ws_1',
  title: 'Reddit 每日巡查',
  created_at: '2026-10-14T01:00:00.000Z',
  reads: [{ key: 'inbox', kind: 'inbox', max_pages: 1 }],
}

/** 替身本机服务：记下插件问了什么、交回了什么。 */
function fakeLocal(job?: RedditReadJob) {
  const calls: string[] = []
  const results: unknown[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.hostname !== '127.0.0.1') throw new Error('插件只许打本机')
    if (url.pathname.endsWith('/next'))
      return new Response(
        JSON.stringify({
          ok: true,
          data:
            url.searchParams.get('connected') === '1' && job !== undefined
              ? { job, retry_after_ms: 0 }
              : { retry_after_ms: 60_000 },
        }),
      )
    results.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ ok: true, data: { accepted: true } }))
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, results }
}

const paired = () => memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' } })

describe('从哪取：后台取，没登录时借开着的 Reddit 标签页', () => {
  it('后台取到了就不碰标签页', async () => {
    const tabs: RedditTabs = { find: vi.fn(), fetchIn: vi.fn() }
    const f = sessionFetch(async (u) => json(u, { kind: 't2', data: { name: 'ivra' } }), tabs)
    await f('https://old.reddit.com/api/me.json?raw_json=1')
    expect(tabs.find).not.toHaveBeenCalled()
  })
  it('后台看着没登录 + 开着标签页 → 改在标签页里取（同一路径、换成标签页的站）', async () => {
    const fetchIn = vi.fn(async (_id: number, u: string) =>
      json(u, { kind: 't2', data: { name: 'ivra' } }),
    )
    const tabs: RedditTabs = {
      find: async () => ({ id: 7, origin: 'https://www.reddit.com' }),
      fetchIn,
    }
    const f = sessionFetch(async (u) => json(u, {}), tabs)
    await f('https://old.reddit.com/api/me.json?raw_json=1')
    await f('https://old.reddit.com/message/inbox/.json?mark=false')
    expect(fetchIn.mock.calls.map((c) => c[1])).toEqual([
      'https://www.reddit.com/api/me.json?raw_json=1',
      'https://www.reddit.com/message/inbox/.json?mark=false',
    ])
  })
})

describe('领活', () => {
  it('没配对：不问', async () => {
    const local = fakeLocal(JOB)
    const out = await pollRedditOnce({
      store: memoryStore(),
      perms: perms(true),
      fetch: local.fetch,
      readFetch: () => async (u) => json(u, {}),
      now: () => '2026-10-14T01:00:00.000Z',
      sleep: async () => {},
      control: { stop: false },
    })
    expect(out).toBe('unpaired')
    expect(local.calls).toEqual([])
  })
  it('没连 Reddit：告诉本机一次 connected=0，半小时内不再问', async () => {
    const local = fakeLocal(JOB)
    const store = paired()
    const base = {
      store,
      perms: perms(false),
      fetch: local.fetch,
      readFetch: () => async (u: string) => json(u, {}),
      now: () => '2026-10-14T01:00:00.000Z',
      sleep: async () => {},
      control: { stop: false },
    }
    expect(await pollRedditOnce(base)).toBe('not_connected')
    expect(await pollRedditOnce(base)).toBe('not_connected')
    expect(local.calls).toEqual(['GET /v1/extension/reddit/next?connected=0'])
  })
  it('领到 → 只读（mark=false）→ 交回；设置页看得见上次结局', async () => {
    const local = fakeLocal(JOB)
    const store = paired()
    const reddit: string[] = []
    const out = await pollRedditOnce({
      store,
      perms: perms(true),
      fetch: local.fetch,
      readFetch: () => async (u) => {
        reddit.push(u)
        return u.includes('/api/me.json')
          ? json(u, { kind: 't2', data: { name: 'ivra_official' } })
          : json(
              u,
              listing([
                {
                  kind: 't1',
                  data: {
                    id: 'c1',
                    name: 't1_c1',
                    body: 'hi',
                    type: 'comment_reply',
                    created_utc: 1,
                  },
                },
              ]),
            )
      },
      now: () => '2026-10-14T01:00:00.000Z',
      sleep: async () => {},
      control: { stop: false },
      gapMs: 0,
    })
    expect(out).toBe('ran')
    expect(
      reddit.filter((u) => u.includes('/message/')).every((u) => u.includes('mark=false')),
    ).toBe(true)
    expect(local.calls.at(-1)).toBe('POST /v1/extension/reddit/rj_1/result')
    expect(local.results[0]).toMatchObject({ outcome: 'done', user: 'ivra_official' })
    expect((await readRedditStatus(store)).last_result).toMatchObject({ outcome: 'done', items: 1 })
  })
})
