/**
 * 排队与补传（WP119 定论 2：「桌面应用没开时插件本地排队，应用起来后补传」）。
 *
 * 这一组测试真正在守的是**如实告知**：
 * - 没写进去就不能说写进去了；
 * - 排着就要说排着，而且要说清排了几条；
 * - 配对失效不能当成"应用没开"，因为用户要做的事完全不同。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerDeps } from '../src/lib/broker.js'
import { flush, observe, pair, status, unpair } from '../src/lib/broker.js'
import type { KeyValueStore } from '../src/lib/storage.js'
import { memoryStore, QUEUE_LIMIT, readQueue, readSettings } from '../src/lib/storage.js'
import type { ExtensionObservationInput } from '../src/lib/wire.js'

const NOW = '2026-09-19T10:00:00.000Z'

const obs = (handle: string): ExtensionObservationInput => ({
  channel: 'youtube',
  handle,
  observed_at: NOW,
  source: 'channel_page',
})

/** 一个假的本机服务。`up: false` = 应用没开（fetch 直接抛）。 */
function fakeServer(options: {
  up?: boolean
  unauthorized?: boolean
  hello?: Record<string, unknown>
  forwarded?: number
}) {
  const calls: { path: string; body: unknown }[] = []
  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (options.up === false) throw new Error('ECONNREFUSED')
    const path = new URL(url).pathname
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ path, body })
    if (options.unauthorized === true) {
      return new Response(JSON.stringify({ ok: false, error: { message: 'nope' } }), {
        status: 401,
      })
    }
    if (path === '/v1/extension/hello') {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            workspace_id: 'ws_1',
            workspace_name: '我的品牌',
            cloud_linked: false,
            shares_to_public_library: false,
            scopes: ['kol.observe'],
            server_version: '0.1.0',
            ...options.hello,
          },
        }),
        { status: 200 },
      )
    }
    if (path === '/v1/extension/pair') {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            token: 'ext_secret',
            token_id: 'ext_0001',
            workspace_id: 'ws_1',
            scopes: ['kol.observe'],
            expires_at: NOW,
          },
        }),
        { status: 200 },
      )
    }
    // observations
    const rows = (body as { observations: ExtensionObservationInput[] }).observations
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          rows: rows.map((r) => ({ handle: r.handle, status: 'ok' })),
          forwarded_to_public_library: options.forwarded ?? 0,
        },
      }),
      { status: 200 },
    )
  }) as unknown as typeof globalThis.fetch
  return { fetchLike, calls }
}

function depsOf(store: KeyValueStore, fetchLike?: typeof globalThis.fetch): BrokerDeps {
  return { store, now: () => NOW, ...(fetchLike === undefined ? {} : { fetch: fetchLike }) }
}

describe('还没配对', () => {
  it('status 说「没配对」，而且**不去打本机服务**', async () => {
    const server = fakeServer({})
    const s = await status(depsOf(memoryStore(), server.fetchLike))
    expect(s.paired).toBe(false)
    expect(s.online).toBe(false)
    expect(server.calls).toHaveLength(0)
  })

  it('这时候采集也不丢——收在插件里排着，并说清楚', async () => {
    const store = memoryStore()
    const out = await observe(depsOf(store, fakeServer({}).fetchLike), [obs('@a')])
    expect(out.kind).toBe('queued')
    if (out.kind === 'queued') expect(out.queued).toBe(1)
    expect(await readQueue(store)).toHaveLength(1)
  })
})

describe('配对', () => {
  it('配上之后把令牌存下来，并把排着的一起补上去', async () => {
    const store = memoryStore()
    // 先在没配对时排两条
    await observe(depsOf(store), [obs('@a')])
    await observe(depsOf(store), [obs('@b')])
    expect(await readQueue(store)).toHaveLength(2)

    const server = fakeServer({})
    const out = await pair(depsOf(store, server.fetchLike), '123456')
    expect(out.ok).toBe(true)
    expect(out.message).toContain('2 条')
    expect((await readSettings(store)).token).toBe('ext_secret')
    expect(await readQueue(store)).toHaveLength(0)
  })

  it('应用没开时说的是「先把应用打开」，不是「码不对」', async () => {
    const out = await pair(depsOf(memoryStore(), fakeServer({ up: false }).fetchLike), '123456')
    expect(out.ok).toBe(false)
    expect(out.message).toContain('连不上')
  })

  it('码不对时说的是「回工作台再生成一个」', async () => {
    const out = await pair(
      depsOf(memoryStore(), fakeServer({ unauthorized: true }).fetchLike),
      '000000',
    )
    expect(out.ok).toBe(false)
    expect(out.message).toContain('5 分钟')
  })
})

describe('配对之后', () => {
  let store: KeyValueStore
  beforeEach(async () => {
    store = memoryStore()
    await pair(depsOf(store, fakeServer({}).fetchLike), '123456')
  })

  it('写进去了就说写进去了，并如实报共享了几条', async () => {
    const server = fakeServer({ forwarded: 2 })
    const out = await observe(depsOf(store, server.fetchLike), [obs('@a'), obs('@b')])
    expect(out).toEqual({ kind: 'saved', saved: 2, deduped: 0, forwarded_to_public_library: 2 })
  })

  it('应用关了就排队，并说「等你打开应用，它会自己补上去」', async () => {
    const out = await observe(depsOf(store, fakeServer({ up: false }).fetchLike), [obs('@a')])
    expect(out.kind).toBe('queued')
    if (out.kind === 'queued') expect(out.message).toContain('补上去')
    expect(await readQueue(store)).toHaveLength(1)
  })

  it('应用再打开时，补传先于这一批——不然用户会以为插件丢了数据', async () => {
    await observe(depsOf(store, fakeServer({ up: false }).fetchLike), [obs('@old')])
    const server = fakeServer({})
    await observe(depsOf(store, server.fetchLike), [obs('@new')])
    const ingests = server.calls.filter((c) => c.path === '/v1/extension/observations')
    const first = ingests[0]?.body as { observations: ExtensionObservationInput[] } | undefined
    expect(first?.observations[0]?.handle).toBe('@old')
    expect(await readQueue(store)).toHaveLength(0)
  })

  it('配对失效**不排队**——排一堆发不出去的只会越积越多', async () => {
    const out = await observe(depsOf(store, fakeServer({ unauthorized: true }).fetchLike), [
      obs('@a'),
    ])
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.message).toContain('重新配')
    expect(await readQueue(store)).toHaveLength(0)
  })

  it('status 会把本机服务答的「会不会上公共库」原样端出来', async () => {
    const server = fakeServer({
      hello: { cloud_linked: true, shares_to_public_library: true, workspace_name: '甲品牌' },
    })
    const s = await status(depsOf(store, server.fetchLike))
    expect(s.online).toBe(true)
    expect(s.shares_to_public_library).toBe(true)
    expect(s.workspace_name).toBe('甲品牌')
  })

  it('解除配对之后令牌没了，但排着的**留着**（用户可能只是想换个工作区）', async () => {
    await observe(depsOf(store, fakeServer({ up: false }).fetchLike), [obs('@a')])
    await unpair(depsOf(store))
    expect((await readSettings(store)).token).toBe(undefined)
    expect(await readQueue(store)).toHaveLength(1)
  })
})

describe('队列上限', () => {
  it('满了丢最旧的——新看到的人比上周那条值钱', async () => {
    const store = memoryStore()
    const rows = Array.from({ length: QUEUE_LIMIT + 5 }, (_, i) => obs(`@a${i}`))
    await observe(depsOf(store), rows)
    const queue = await readQueue(store)
    expect(queue).toHaveLength(QUEUE_LIMIT)
    expect(queue[0]?.observation.handle).toBe('@a5')
  })

  it('过期的补传时不再发（旧快照补上去也是错的数）', async () => {
    const store = memoryStore()
    await observe(depsOf(store), [obs('@stale')])
    // 八天之后再排一条：旧的那条应当在入队时就被清掉
    const later: BrokerDeps = { store, now: () => '2026-09-27T10:00:00.000Z' }
    await observe(later, [obs('@fresh')])
    const queue = await readQueue(store)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.observation.handle).toBe('@fresh')
  })
})

describe('flush', () => {
  it('没配对时什么都不发', async () => {
    const store = memoryStore()
    await observe(depsOf(store), [obs('@a')])
    const server = fakeServer({})
    const out = await flush(depsOf(store, server.fetchLike))
    expect(out).toEqual({ sent: 0, left: 1 })
    expect(server.calls).toHaveLength(0)
  })

  it('发不出去就原样留着，不会把队列清空', async () => {
    const store = memoryStore()
    await pair(depsOf(store, fakeServer({}).fetchLike), '123456')
    await observe(depsOf(store, fakeServer({ up: false }).fetchLike), [obs('@a')])
    const out = await flush(depsOf(store, fakeServer({ up: false }).fetchLike))
    expect(out).toEqual({ sent: 0, left: 1 })
    expect(await readQueue(store)).toHaveLength(1)
  })
})

describe('超时', () => {
  it('本机服务吊着不答时当「应用没开」，页面上那张卡不会一直转', async () => {
    const store = memoryStore()
    await pair(depsOf(store, fakeServer({}).fetchLike), '123456')
    const hang = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof globalThis.fetch
    // 超时调到 50ms：验的是「吊着 → abort → 走 offline 那一支」，不是真等 8 秒
    const deps: BrokerDeps = { store, now: () => NOW, fetch: hang, timeoutMs: 50 }
    const out = await observe(deps, [obs('@a')])
    expect(hang).toHaveBeenCalled()
    expect(out.kind).toBe('queued')
  })
})
