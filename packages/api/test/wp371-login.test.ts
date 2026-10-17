/**
 * WP371 本机登录后续（决策 942–944）——网关这一层。
 *
 * - 942 托盘一次性链接：只在给了 `browserLink` + 会话密钥时开；密钥不对 401；token 用一次就废、过期拒；
 * - 943 工坊账号认人：云端说码对 + 这个邮箱是成员 → 一次性登录 token；不是成员 404 `not_member`；
 *   码不对原样带回云的原因；发码那一步不看是不是成员；
 * - 944 浏览器会话 30 天：`/v1/auth/verify` 按 `browserSessionTtlMs` 签；退出 / 离开当场失效；
 * - 945 收尾：局域网档按邮箱要链接直接说该怎么进，什么都不签。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type AccountLoginPort,
  ApiError,
  BROWSER_SESSION_TTL_MS,
  createSqliteIdentity,
} from '../src/index.js'
import { harness } from './helpers.js'
import { seeded, testClock } from './identity-conformance.js'

const ANON = { assignment: null } as const
const KEY = 'k'.repeat(32)
const DAY = 24 * 60 * 60 * 1000

const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

/** 云端替身：只认 `135790`；记下发过码的邮箱。 */
function cloudCodes(): AccountLoginPort & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    async sendCode({ email }) {
      sent.push(email)
      return { expires_at: '2026-10-17T00:05:00.000Z' }
    },
    async verifyCode({ email, code }) {
      if (code !== '135790')
        throw new ApiError('invalid_input', '验证码不对，再看一眼邮件。', {
          details: { reason: 'invalid_code' },
        })
      return email
    },
  }
}

describe('决策 942：POST /v1/auth/browser-link', () => {
  it('没开（局域网档 / 托管档 / 没配会话密钥）→ 501', async () => {
    const off = await harness({ gateway: { sessionKey: KEY, sessionOwnerEmail: 'me@example.com' } })
    expect((await off.post('/v1/auth/browser-link', { key: KEY }, ANON)).status).toBe(501)
    const noKey = await harness({ gateway: { browserLink: true } })
    expect((await noKey.post('/v1/auth/browser-link', { key: KEY }, ANON)).status).toBe(501)
  })

  it('密钥不对 401；对了给主人一张一次性 token：用一次就废', async () => {
    const h = await harness({
      gateway: { browserLink: true, sessionKey: KEY, sessionOwnerEmail: 'me@example.com' },
    })
    expect((await h.post('/v1/auth/browser-link', { key: 'x'.repeat(32) }, ANON)).status).toBe(401)
    const res = await h.post('/v1/auth/browser-link', { key: KEY }, ANON)
    expect(res.status).toBe(200)
    const link = await dataOf<{ token: string; expires_at: string }>(res)
    expect(Date.parse(link.expires_at) - Date.parse(h.clock.now())).toBe(15 * 60 * 1000)
    const verified = await h.post('/v1/auth/verify', { token: link.token }, ANON)
    expect(verified.status).toBe(200)
    expect((await dataOf<{ person: { id: string } }>(verified)).person.id).toBe(h.person_id)
    expect((await h.post('/v1/auth/verify', { token: link.token }, ANON)).status).toBe(401)
  })

  it('过了 15 分钟没用 → 拒', async () => {
    const h = await harness({
      gateway: { browserLink: true, sessionKey: KEY, sessionOwnerEmail: 'me@example.com' },
    })
    const link = await dataOf<{ token: string }>(
      await h.post('/v1/auth/browser-link', { key: KEY }, ANON),
    )
    h.clock.advance(15 * 60 * 1000 + 1)
    expect((await h.post('/v1/auth/verify', { token: link.token }, ANON)).status).toBe(401)
  })
})

describe('决策 943：用工坊账号进工作区', () => {
  it('没装配 → 501', async () => {
    const h = await harness()
    expect((await h.post('/v1/auth/account/code', { email: 'me@example.com' }, ANON)).status).toBe(
      501,
    )
  })

  it('发码不看是不是成员；码对 + 是成员 → 一次性登录 token → 会话是本人', async () => {
    const cloud = cloudCodes()
    const h = await harness({ gateway: { accountLogin: cloud } })
    expect(
      (await h.post('/v1/auth/account/code', { email: 'nobody@example.com' }, ANON)).status,
    ).toBe(200)
    const sent = await h.post('/v1/auth/account/code', { email: ' Other@Example.com ' }, ANON)
    expect(sent.status).toBe(200)
    expect(cloud.sent).toEqual(['nobody@example.com', 'other@example.com'])

    const res = await h.post(
      '/v1/auth/account/verify',
      { email: 'other@example.com', code: '135790' },
      ANON,
    )
    expect(res.status).toBe(200)
    const { token } = await dataOf<{ token: string }>(res)
    const session = await dataOf<{ person: { id: string } }>(
      await h.post('/v1/auth/verify', { token }, ANON),
    )
    expect(session.person.id).toBe(h.other_id)
  })

  it('码不对：原样带回云的原因；邮箱不是成员：404 not_member', async () => {
    const h = await harness({ gateway: { accountLogin: cloudCodes() } })
    const wrong = await h.post(
      '/v1/auth/account/verify',
      { email: 'other@example.com', code: '000000' },
      ANON,
    )
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      'invalid_code',
    )
    const stranger = await h.post(
      '/v1/auth/account/verify',
      { email: 'nobody@example.com', code: '135790' },
      ANON,
    )
    expect(stranger.status).toBe(404)
    const body = (await stranger.json()) as { message: string; details?: { reason?: string } }
    expect(body.details?.reason).toBe('not_member')
    expect(body.message).toContain('nobody@example.com')
  })
})

describe('决策 944：浏览器会话 30 天', () => {
  const login = async (h: Awaited<ReturnType<typeof harness>>): Promise<string> => {
    const { token } = await dataOf<{ token: string }>(
      await h.post('/v1/auth/magic-link', { email: 'other@example.com' }, ANON),
    )
    return (
      await dataOf<{ session_token: string }>(await h.post('/v1/auth/verify', { token }, ANON))
    ).session_token
  }
  const me = (h: Awaited<ReturnType<typeof harness>>, token: string) =>
    h.get('/v1/me', { headers: { Authorization: `Bearer ${token}` }, assignment: null })

  it('给了 30 天：过 29 天还在，过 30 天失效；没给就照旧 12 小时', async () => {
    const long = await harness({ gateway: { browserSessionTtlMs: BROWSER_SESSION_TTL_MS } })
    const t = await login(long)
    long.clock.advance(29 * DAY)
    expect((await me(long, t)).status).toBe(200)
    long.clock.advance(DAY + 1)
    expect((await me(long, t)).status).toBe(401)

    const short = await harness()
    const s = await login(short)
    short.clock.advance(12 * 60 * 60 * 1000 + 1)
    expect((await me(short, s)).status).toBe(401)
  })

  it('退出当场失效；被移出工作区当场失效', async () => {
    const h = await harness({ gateway: { browserSessionTtlMs: BROWSER_SESSION_TTL_MS } })
    const a = await login(h)
    const out = await h.post('/v1/auth/logout', undefined, {
      headers: { Authorization: `Bearer ${a}` },
      assignment: null,
    })
    expect(out.status).toBe(200)
    expect((await me(h, a)).status).toBe(401)

    const b = await login(h)
    expect((await me(h, b)).status).toBe(200)
    await h.identity.leaveWorkspace(h.workspace_id, h.other_id)
    expect((await me(h, b)).status).toBe(401)
  })
})

describe('决策 945 收尾：局域网档按邮箱要链接', () => {
  it('给了设置码（局域网档）→ 403 shared_login，成员 / 非成员一个样，不签 token', async () => {
    const h = await harness({
      exposeMagicLinkToken: false,
      ownerSetupCode: { redeem: async () => undefined },
    })
    for (const email of ['me@example.com', 'nobody@example.com']) {
      const res = await h.post('/v1/auth/magic-link', { email }, ANON)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
        'shared_login',
      )
    }
  })
})

describe('决策 944：SQLite 档也认会话寿命', () => {
  it('verifyLogin 带 sessionTtlMs → 那张会话按它到期；不带照旧 12 小时', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp371-'))
    const clock = testClock()
    const identity = createSqliteIdentity({
      dbPath: join(dir, 'identity.db'),
      clock,
      random: seeded(3),
    })
    try {
      const p = await identity.createPerson({ email: 'a@example.com', name: 'a' })
      await identity.createWorkspace({ name: 'w', owner_id: p.id, kind: 'personal' })
      const long = await identity.verifyLogin((await identity.issueLogin('a@example.com')).token, {
        sessionTtlMs: BROWSER_SESSION_TTL_MS,
      })
      const short = await identity.verifyLogin((await identity.issueLogin('a@example.com')).token)
      const at = Date.parse(clock.now())
      expect(Date.parse(identity.tokenInfo(long?.session_token ?? '')?.expires_at ?? '') - at).toBe(
        30 * DAY,
      )
      expect(
        Date.parse(identity.tokenInfo(short?.session_token ?? '')?.expires_at ?? '') - at,
      ).toBe(12 * 60 * 60 * 1000)
    } finally {
      identity.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
