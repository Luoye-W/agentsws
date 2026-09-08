import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import {
  CassetteMissError,
  createRecordingFetch,
  createReplayFetch,
  requestKey,
  SecretRegistry,
} from '../src/index.js'
import { TestClock } from './helpers.js'

/** 录制 / 回放机制自身的测试——磁带是整个"真适配器那一遍"的地基。 */
describe('HTTP 录制与回放', () => {
  const identity = (s: string): string => s

  it('请求键：方法 + 路径 + 排序后的查询 + bearer + alias + 幂等键 + 请求体哈希', () => {
    const a = requestKey('http://h/v1/actions?b=2&a=1', { method: 'post' }, identity)
    const b = requestKey('http://h/v1/actions?a=1&b=2', { method: 'POST' }, identity)
    expect(a.key).toBe(b.key)
    expect(a.path).toBe('/v1/actions?a=1&b=2')
    expect(a.method).toBe('POST')

    const withBody = requestKey('http://h/x', { method: 'POST', body: '{"a":1}' }, identity)
    const otherBody = requestKey('http://h/x', { method: 'POST', body: '{"a":2}' }, identity)
    expect(withBody.key).not.toBe(otherBody.key)

    const alias = requestKey('http://h/x', { headers: { 'x-oo-connector-alias': 'eu' } }, identity)
    expect(alias.key).toContain('alias=eu')

    const idem = requestKey(
      'http://h/x',
      { headers: new Headers({ 'Idempotency-Key': 'k1' }) },
      identity,
    )
    expect(idem.key).toContain('idem=k1')

    const arrayHeaders = requestKey(
      'http://h/x',
      { headers: [['authorization', 'Bearer s3cret']] },
      (s) => (s === 's3cret' ? 'PLACEHOLDER' : s),
    )
    expect(arrayHeaders.key).toContain('auth=PLACEHOLDER')
    expect(arrayHeaders.key).not.toContain('s3cret')
  })

  it('录制期就把秘密换成占位串：磁带里既没有 admin token 也没有 oct_ token', async () => {
    const secrets = new SecretRegistry()
    const admin = 'super-secret-admin-token'
    const adminPlaceholder = secrets.register(admin, 'admin')
    const clock = new TestClock()
    const base: FetchLike = async (url, init) => {
      const auth = new Headers((init?.headers ?? {}) as HeadersInit).get('authorization')
      expect(auth).toBe(`Bearer ${admin}`) // 真请求发的是原文
      return new Response(JSON.stringify({ token: 'oct_AAAAAAAAAAAAAAAAAAAAAAAA', echo: url }), {
        status: 200,
      })
    }
    const recorder = createRecordingFetch({ base, secrets, now: () => clock.now() })
    await recorder.fetch('http://h/api/runtime-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
      body: '{}',
    })
    const cassette = recorder.cassette()
    const text = JSON.stringify(cassette)
    expect(text).not.toContain(admin)
    expect(text).not.toContain('oct_AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(text).toContain(adminPlaceholder)
    expect(cassette.placeholders.admin).toBe(adminPlaceholder)
    expect(cassette.placeholders.oct).toBe('oct_fixture_2')
    expect(secrets.size()).toBe(2)
    expect(cassette.recorded_at).toBe(clock.now())
  })

  it('回放：同一个键按录制顺序推进，用完重复最后一条', async () => {
    const play = createReplayFetch({
      version: 1,
      recorded_at: '2026-09-09T09:00:00.000Z',
      placeholders: {},
      exchanges: [
        {
          key: 'GET | /a | auth= | alias= | idem= | body=e3b0c44298fc1c14',
          method: 'GET',
          path: '/a',
          status: 200,
          body: '{"n":1}',
        },
        {
          key: 'GET | /a | auth= | alias= | idem= | body=e3b0c44298fc1c14',
          method: 'GET',
          path: '/a',
          status: 200,
          body: '{"n":2}',
        },
      ],
    })
    expect(await (await play('http://h/a')).json()).toEqual({ n: 1 })
    expect(await (await play('http://h/a')).json()).toEqual({ n: 2 })
    expect(await (await play('http://h/a')).json()).toEqual({ n: 2 })
  })

  it('回放：磁带里没有的请求直接报 CassetteMissError（不会静默变成网络调用）', async () => {
    const play = createReplayFetch({
      version: 1,
      recorded_at: '2026-09-09T09:00:00.000Z',
      placeholders: {},
      exchanges: [],
    })
    await expect(play('http://h/nope')).rejects.toBeInstanceOf(CassetteMissError)
  })

  it('录制的响应状态码原样回放（404 仍是 404）', async () => {
    const secrets = new SecretRegistry()
    const clock = new TestClock()
    const recorder = createRecordingFetch({
      base: async () => new Response('{"error":{"code":"not_found"}}', { status: 404 }),
      secrets,
      now: () => clock.now(),
    })
    await recorder.fetch('http://h/v1/actions/x.y')
    const play = createReplayFetch(recorder.cassette())
    const res = await play('http://h/v1/actions/x.y')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('SecretRegistry：同一个秘密只登记一次，autoRegister 认领所有 oct_ token', () => {
    const s = new SecretRegistry()
    expect(s.register('abc', 'admin')).toBe('admin_fixture_1')
    expect(s.register('abc', 'admin')).toBe('admin_fixture_1')
    s.autoRegister('token=oct_1111111111111111AAAA and oct_2222222222222222BBBB')
    expect(s.size()).toBe(3)
    expect(s.redact('oct_1111111111111111AAAA/abc')).toBe('oct_fixture_2/admin_fixture_1')
  })
})
