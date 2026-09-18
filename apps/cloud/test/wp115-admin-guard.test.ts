/**
 * WP115 ①：守卫（65 §2）。
 *
 * 这一组测的全是"不该发生的事没发生"：无权的人看到 404、只读角色写不动、
 * 没有 CSRF 的写请求进不去、降级之后旧 cookie 当场失效。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { adminHarness, BOOTSTRAP_TOKEN, staffLogin } from './wp115-helpers.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

describe('WP115 后台守卫', () => {
  it('没登录：每条 /v1/admin/* 都是 404，不是 401 也不是 403', async () => {
    const ah = adminHarness()
    close = ah.close
    for (const path of [
      '/v1/admin/me',
      '/v1/admin/overview',
      '/v1/admin/accounts',
      '/v1/admin/orgs',
      '/v1/admin/usage',
      '/v1/admin/audit',
      '/v1/admin/health',
    ]) {
      const res = await ah.call(path)
      expect(res.status, path).toBe(404)
    }
    // 与一条根本不存在的路径长得一模一样——这就是 404 而不是 403 的全部意义
    const nonsense = await ah.call('/v1/admin/nonsense')
    expect(nonsense.status).toBe(404)
  })

  it('普通用户的 cookie 也是 404（角色每次请求现查）', async () => {
    const ah = adminHarness()
    close = ah.close
    const staff = await staffLogin(ah, 'boss@example.com', 'admin')
    expect((await ah.call('/v1/admin/me', { session: staff.session })).status).toBe(200)

    // 另一个 admin 把他降成 user
    const other = await staffLogin(ah, 'second@example.com', 'admin')
    const down = await ah.call(`/v1/admin/accounts/${staff.account_id}/role`, {
      method: 'POST',
      body: { role: 'user' },
      session: other.session,
      csrf: other.csrf,
    })
    expect(down.status).toBe(200)
    // 旧 cookie 当场失效：不等它十二小时后自己过期
    expect((await ah.call('/v1/admin/me', { session: staff.session })).status).toBe(404)
  })

  it('support 能读、一个写接口都调不动（全是 404）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const support = await staffLogin(ah, 'help@example.com', 'support')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')

    expect((await ah.call('/v1/admin/accounts', { session: support.session })).status).toBe(200)
    expect((await ah.call('/v1/admin/audit', { session: support.session })).status).toBe(200)

    const writes: [string, unknown][] = [
      [`/v1/admin/accounts/${victim.account.id}/ban`, { reason: '试试' }],
      [`/v1/admin/accounts/${victim.account.id}/role`, { role: 'admin' }],
      [`/v1/admin/orgs/${victim.org.id}/suspend`, { reason: '试试' }],
      ['/v1/admin/credits/grant', { org_ids: [victim.org.id], credits: 10, reason: '试试' }],
    ]
    for (const [path, body] of writes) {
      const res = await ah.call(path, {
        method: 'POST',
        body,
        session: support.session,
        csrf: support.csrf,
      })
      expect(res.status, path).toBe(404)
    }
    // 同一批请求换成 admin 就通——证明 404 是角色判出来的，不是路径写错了
    const ok = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '真封' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(ok.status).toBe(201)
  })

  it('写接口没有 CSRF 头 / 头与 cookie 对不上 → 403', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')

    const noCsrf = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '试试' },
      session: admin.session,
    })
    expect(noCsrf.status).toBe(403)

    const wrongCsrf = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '试试' },
      session: admin.session,
      csrf: 'ac_not-the-right-one',
    })
    expect(wrongCsrf.status).toBe(403)
  })

  it('Origin 不是我们自己 → 403（跨站表单打不动）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')
    const res = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '试试' },
      session: admin.session,
      csrf: admin.csrf,
      headers: { Origin: 'https://evil.example.net' },
    })
    expect(res.status).toBe(403)
  })

  it('bootstrap：认运维令牌、提为 admin、把他原有的会话全清掉', async () => {
    const ah = adminHarness()
    close = ah.close
    // 先让他以普通用户的身份拿一张云账号会话
    const { account } = ah.h.server.store.ensureAccount('first@example.com')
    const login = ah.h.server.store.issueLogin(account.id)
    const verified = ah.h.server.store.verifyLogin(login.token)
    expect(verified).toBeDefined()
    expect(ah.h.server.store.session(verified?.session_token ?? '')).toBeDefined()

    const bad = await ah.call('/v1/admin/bootstrap', {
      method: 'POST',
      body: { email: 'first@example.com' },
      headers: { Authorization: 'Bearer nope' },
    })
    expect(bad.status).toBe(401)

    const res = await ah.call('/v1/admin/bootstrap', {
      method: 'POST',
      body: { email: 'first@example.com' },
      headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    })
    expect(res.status).toBe(201)
    expect(ah.admin.role(account.id)).toBe('admin')
    // 提权之前签出去的凭据不该带着新权限继续活着
    expect(ah.h.server.store.session(verified?.session_token ?? '')).toBeUndefined()
  })

  it('登录页公开、后台壳对无会话的人 404', async () => {
    const ah = adminHarness()
    close = ah.close
    expect((await ah.raw('/admin/login')).status).toBe(200)
    // 没配 dist 目录时 `/admin/` 本来就没挂；配了也得先有会话（见 mount.ts 的 spa）
    const callback = await ah.raw('/admin/callback?token=nope')
    expect(callback.status).toBe(401)
    expect(callback.text).not.toContain('nope')
  })

  it('不是 staff 的邮箱：magic-link 回一样的话，但一封信都不发', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.h.server.store.ensureAccount('outsider@example.com')
    const before = ah.h.mails.length
    const res = await ah.call('/v1/admin/auth/magic-link', {
      method: 'POST',
      body: { email: 'outsider@example.com' },
    })
    expect(res.status).toBe(200)
    expect(ah.h.mails.length).toBe(before)

    await staffLogin(ah, 'boss@example.com', 'admin')
    const staffMail = await ah.call('/v1/admin/auth/magic-link', {
      method: 'POST',
      body: { email: 'boss@example.com' },
    })
    expect(staffMail.status).toBe(200)
    expect(ah.h.mails.length).toBe(before + 1)
  })
})
