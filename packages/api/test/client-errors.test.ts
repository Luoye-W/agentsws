/** WP298：`POST /v1/client-errors`——不要求登录、自己一只限流桶、截长、去个人数据。 */
import { describe, expect, it } from 'vitest'
import { CLIENT_ERROR_MAX_BODY, sanitizeClientError } from '../src/routes/client-errors.js'
import type { ClientErrorEntry } from '../src/types.js'
import { harness } from './helpers.js'

const send = (h: Awaited<ReturnType<typeof harness>>, body: unknown, ua?: string) =>
  h.gateway.fetch(
    new Request('http://127.0.0.1/v1/client-errors', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ua === undefined ? {} : { 'user-agent': ua }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const sample = {
  kind: 'boundary',
  name: 'TypeError',
  message: "Cannot read properties of undefined (reading 'x')",
  route: '/im-channels',
  scope: 'page',
}

describe('POST /v1/client-errors', () => {
  it('不带凭据也收，交给宿主落日志', async () => {
    const h = await harness()
    const got: ClientErrorEntry[] = []
    h.deps.clientErrors = { record: (e) => got.push(e) }
    const res = await send(h, sample, 'Mozilla/5.0 Electron/44.3.0')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { logged: boolean } }).data.logged).toBe(true)
    expect(got).toEqual([{ ...sample, user_agent: 'Mozilla/5.0 Electron/44.3.0' }])
  })

  it('没装配日志口：照收照答，logged=false', async () => {
    const h = await harness()
    const res = await send(h, sample)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { logged: boolean } }).data.logged).toBe(false)
  })

  it('限流：突发 20 条之后 429，过 5 秒回一条', async () => {
    let wall = 1_000_000
    const h = await harness({ wallClockMs: () => wall })
    const got: ClientErrorEntry[] = []
    h.deps.clientErrors = { record: (e) => got.push(e) }
    for (let i = 0; i < 20; i += 1) expect((await send(h, sample)).status).toBe(200)
    const limited = await send(h, sample)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).not.toBeNull()
    expect(got.length).toBe(20)
    wall += 5_000
    expect((await send(h, sample)).status).toBe(200)
    expect(got.length).toBe(21)
    // 别人正常的接口不受影响（各走各的桶）
    expect((await h.get('/v1/me')).status).toBe(200)
  })

  it('请求体超过 16 KiB 拒；坏 JSON / 缺字段 400', async () => {
    const h = await harness()
    const huge = { ...sample, stack: 'x'.repeat(CLIENT_ERROR_MAX_BODY + 10) }
    expect((await send(h, huge)).status).toBe(400)
    expect((await send(h, '{not json')).status).toBe(400)
    expect((await send(h, { kind: 'error' })).status).toBe(400)
  })
})

describe('sanitizeClientError', () => {
  it('截长、一条一行、去查询串与个人数据、未知 kind 记成 other', () => {
    const out = sanitizeClientError({
      kind: 'whatever',
      name: `E${'n'.repeat(500)}`,
      message: `boom http://127.0.0.1:4317/v1/x?token=s3cr3t for a@b.com 13800138000\nsecond`,
      stack: `at f (http://127.0.0.1:4317/assets/index-abc.js?v=1:10:5)\n${'at g (x.js:1:1)\n'.repeat(30)}`,
      route: '/connections?service=shopify_admin',
      scope: 'page\nINJECTED 2026-01-01 ERROR fake line',
    })
    expect(out.kind).toBe('other')
    expect(out.name.length).toBeLessThanOrEqual(80)
    expect(out.message).toBe('boom http://127.0.0.1:4317/v1/x for <email> <num>')
    expect(out.stack).toContain('index-abc.js:10:5')
    expect(out.stack).not.toContain('?')
    expect(out.stack?.split(' | ').length).toBeLessThanOrEqual(8)
    expect(out.route).toBe('/connections')
    // 换行注入不了假日志行
    expect(out.scope).toBe('page')
  })
})
