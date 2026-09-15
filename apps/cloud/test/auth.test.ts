/**
 * 49 M1 登录那一段：magic link 只进邮件、隐式建组织、会话。
 * 外加 `callback_url` 的白名单——这是本 WP 唯一一处"按调用方给的地址拼链接"。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { checkCallbackUrl, DEFAULT_CLOUD_BASE_URL } from '../src/index.js'
import { type Harness, harness, login } from './helpers.js'

let h: Harness

beforeEach(() => {
  h = harness()
  return () => h.close()
})

describe('49 M1 云账号登录', () => {
  it('一次性 token 只进邮件，不进 HTTP 响应', async () => {
    const res = await h.call('/v1/cloud/auth/magic-link', {
      method: 'POST',
      body: { email: 'luoye@example.com' },
    })
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    expect(body).toContain('delivered')
    expect(body).not.toContain('cml_')
    expect(h.mails).toHaveLength(1)
    expect(h.mails[0]?.text).toContain('cml_')
  })

  it('第一次登录隐式建一个以邮箱命名的组织（52 O3）', async () => {
    const { session } = await login(h, 'luoye@example.com')
    const me = await h.call('/v1/cloud/me', { token: session })
    expect(me.status).toBe(200)
    const data = me.body.data as { account: { email: string }; org: { name: string } }
    expect(data.account.email).toBe('luoye@example.com')
    expect(data.org.name).toBe('luoye@example.com')
  })

  it('同一个邮箱再登录一次还是同一个账号、同一个组织', async () => {
    const first = await login(h, 'luoye@example.com')
    const second = await login(h, 'LUOYE@Example.com')
    expect(second.org).toBe(first.org)
  })

  it('一次性 token 只能用一次；过期就不认', async () => {
    await h.call('/v1/cloud/auth/magic-link', {
      method: 'POST',
      body: { email: 'a@example.com' },
    })
    const token = new URL(h.lastLink()).searchParams.get('token') ?? ''
    expect(
      (await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })).status,
    ).toBe(200)
    const again = await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
    expect(again.status).toBe(401)

    await h.call('/v1/cloud/auth/magic-link', { method: 'POST', body: { email: 'b@example.com' } })
    const fresh = new URL(h.lastLink()).searchParams.get('token') ?? ''
    h.clock.advance(16 * 60 * 1000)
    expect(
      (await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token: fresh } })).status,
    ).toBe(401)
  })

  it('注销之后这张会话立刻不认', async () => {
    const { session } = await login(h, 'luoye@example.com')
    expect((await h.call('/v1/cloud/auth/logout', { method: 'POST', token: session })).status).toBe(
      200,
    )
    expect((await h.call('/v1/cloud/me', { token: session })).status).toBe(401)
  })

  it('没有凭据的会话路由一律 401', async () => {
    expect((await h.call('/v1/cloud/me')).status).toBe(401)
    expect((await h.call('/v1/cloud/links')).status).toBe(401)
  })
})

describe('callback_url 白名单（不给开放重定向留口）', () => {
  it('只认回环地址与云自己的地址', () => {
    expect(
      checkCallbackUrl('http://127.0.0.1:3000/v1/cloud/account/callback', DEFAULT_CLOUD_BASE_URL)
        .ok,
    ).toBe(true)
    expect(checkCallbackUrl('http://localhost:5173/cb', DEFAULT_CLOUD_BASE_URL).ok).toBe(true)
    expect(
      checkCallbackUrl(`${DEFAULT_CLOUD_BASE_URL}/cloud/auth/callback`, DEFAULT_CLOUD_BASE_URL).ok,
    ).toBe(true)
  })

  it('别人的站点、看起来像我们的域名、带口令的地址一律拒绝', () => {
    for (const bad of [
      'https://evil.example/steal',
      'https://cloud.agentsws.app.evil.example/steal',
      'http://user:pw@127.0.0.1:3000/cb',
      'http://10.0.0.5:3000/cb',
      'not-a-url',
    ])
      expect(checkCallbackUrl(bad, DEFAULT_CLOUD_BASE_URL).ok).toBe(false)
  })

  it('路由层也拒绝：拿别人的域名当回调会被 400 挡下，信也发不出去', async () => {
    const res = await h.call('/v1/cloud/auth/magic-link', {
      method: 'POST',
      body: { email: 'luoye@example.com', callback_url: 'https://evil.example/steal' },
    })
    expect(res.status).toBe(400)
    expect(h.mails).toHaveLength(0)
  })
})
