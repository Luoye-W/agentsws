import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import { MemoryEventSink, RuntimeHttp } from '../src/index.js'

function http(
  respond: (url: string, init?: RequestInit) => Response,
  adminToken: () => string | undefined = () => 'admin-token',
): { client: RuntimeHttp; seen: { url: string; init?: RequestInit | undefined }[] } {
  const seen: { url: string; init?: RequestInit | undefined }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init })
    return respond(url, init)
  }
  return {
    seen,
    client: new RuntimeHttp({
      baseUrl: 'http://127.0.0.1:3000/',
      fetchImpl,
      adminToken,
      timeoutMs: 1000,
    }),
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('RuntimeHttp：两种信封 + 鉴权 + 查询串', () => {
  it('baseUrl 末尾的斜杠被normalize，数组查询变成重复参数', () => {
    const { client } = http(() => json({}))
    expect(client.baseUrl).toBe('http://127.0.0.1:3000')
    expect(client.url('/v1/providers', { service: ['a', 'b'], q: 'x', skip: undefined })).toBe(
      'http://127.0.0.1:3000/v1/providers?service=a&service=b&q=x',
    )
  })

  it('/v1 信封：data / meta / message 拆出来', async () => {
    const { client } = http(() =>
      json({ success: true, message: 'OK', data: { a: 1 }, meta: { executionId: 'e1' } }),
    )
    const res = await client.request<{ a: number }>('GET', '/v1/x', { auth: 'none' })
    expect(res).toMatchObject({
      data: { a: 1 },
      meta: { executionId: 'e1' },
      message: 'OK',
      status: 200,
    })
  })

  it('/api 裸 JSON 原样返回', async () => {
    const { client } = http(() => json([{ id: 'c1' }]))
    const res = await client.request<{ id: string }[]>('GET', '/api/connections', { auth: 'admin' })
    expect(res.data).toEqual([{ id: 'c1' }])
    expect(res.meta).toEqual({})
  })

  it('admin / runtime 两种 bearer；缺 admin token 或缺 runtime token 都是 unauthenticated', async () => {
    const { client, seen } = http(() => json({}))
    await client.request('GET', '/api/x', { auth: 'admin' })
    expect(new Headers(seen[0]?.init?.headers as HeadersInit).get('authorization')).toBe(
      'Bearer admin-token',
    )
    await client.request('GET', '/v1/x', { auth: 'runtime', runtimeToken: 'oct_1' })
    expect(new Headers(seen[1]?.init?.headers as HeadersInit).get('authorization')).toBe(
      'Bearer oct_1',
    )
    await client.request('GET', '/v1/x', { auth: 'none' })
    expect(new Headers(seen[2]?.init?.headers as HeadersInit).get('authorization')).toBeNull()

    await expect(client.request('GET', '/v1/x', { auth: 'runtime' })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    const { client: noAdmin } = http(
      () => json({}),
      () => undefined,
    )
    await expect(noAdmin.request('GET', '/api/x', { auth: 'admin' })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('有 body 时带 content-type，并且是序列化后的 JSON', async () => {
    const { client, seen } = http(() => json({}))
    await client.request('POST', '/api/runtime-tokens', { auth: 'admin', body: { name: 'x' } })
    expect(new Headers(seen[0]?.init?.headers as HeadersInit).get('content-type')).toBe(
      'application/json',
    )
    expect(seen[0]?.init?.body).toBe('{"name":"x"}')
  })

  it('`{error:{code}}` 与 `{success:false,errorCode}` 两种失败体都能认', async () => {
    const { client: a } = http(() =>
      json({ error: { code: 'unauthorized', message: '要 token' } }, 401),
    )
    await expect(a.request('GET', '/api/x', { auth: 'admin' })).rejects.toMatchObject({
      code: 'unauthenticated',
      message: '要 token',
    })

    const { client: b } = http(() =>
      json(
        { success: false, message: '不许', errorCode: 'connection_not_allowed', data: null },
        403,
      ),
    )
    await expect(b.request('POST', '/v1/actions/x.y', { auth: 'none' })).rejects.toMatchObject({
      code: 'connection_not_allowed',
    })
  })

  it('HTTP 200 但 success:false 也算失败', async () => {
    const { client } = http(() =>
      json({ success: false, errorCode: 'rate_limited', message: '慢' }),
    )
    await expect(client.request('GET', '/v1/x', { auth: 'none' })).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('响应不是 JSON（或空体）时按状态码判', async () => {
    const { client: bad } = http(() => new Response('<html>502</html>', { status: 502 }))
    await expect(bad.request('GET', '/v1/x', { auth: 'none' })).rejects.toMatchObject({
      code: 'provider_error',
    })
    const { client: empty } = http(() => new Response(null, { status: 204 }))
    const res = await empty.request('DELETE', '/api/runtime-tokens/x', { auth: 'admin' })
    expect(res.data).toBeUndefined()
    const { client: garbage } = http(() => new Response('not json', { status: 200 }))
    expect((await garbage.request('GET', '/api/x', { auth: 'admin' })).data).toBeUndefined()
  })

  it('每个请求的超时可以单独覆盖', async () => {
    const { client } = http(() => json({}))
    await expect(
      new RuntimeHttp({
        baseUrl: 'http://127.0.0.1:3000',
        fetchImpl: (_url, init) =>
          new Promise((_r, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          }),
        adminToken: () => 'a',
        timeoutMs: 10_000,
      }).request('GET', '/v1/x', { auth: 'none', timeoutMs: 15 }),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(client.baseUrl).toBe('http://127.0.0.1:3000')
  })
})

describe('MemoryEventSink', () => {
  it('攒事件、按类型取、清空', () => {
    const sink = new MemoryEventSink()
    sink.emit({ type: 'connect.executed', at: '2026-09-09T09:00:00.000Z', payload: {} })
    sink.emit({ type: 'connect.proxy_denied', at: '2026-09-09T09:00:01.000Z', payload: {} })
    expect(sink.events).toHaveLength(2)
    expect(sink.ofType('connect.executed')).toHaveLength(1)
    sink.clear()
    expect(sink.events).toHaveLength(0)
  })
})
