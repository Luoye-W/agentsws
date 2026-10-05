/**
 * WP231：「用 Agents 工坊的接口」分清注册与登录（密码 + 邮箱验证码）。
 *
 * 真装配线（路由 → 端口 → 加密库）+ demo 的云替身：
 * - 注册：名字 + 邮箱 + 密码 + 勾条款 → 发码 → 验码 → 已关联、送 10 积分；没勾条款不许发；
 * - 已注册的邮箱点注册 → 409 + `already_registered`（界面据此一键切到登录）；
 * - 登录：验证码登录 / 密码登录；没注册的邮箱发码静默成功；验证码不对是 400 + `invalid_code`（不是 401）；
 * - 忘记密码：发码 → 验码 + 新密码 → 已关联；
 * - **密码与验证码不落盘**：跑完翻一遍数据目录里的每个文件，一个字节都找不到。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudAccountView } from '@agentsws/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { passThroughError } from '../src/cloud-account.js'
import {
  CLOUD_STAND_IN_PASSWORD,
  CLOUD_STAND_IN_REGISTERED_EMAIL,
  CLOUD_STAND_IN_WRONG_CODE,
} from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const PASSWORD = 'Sunflower-Ledger-77'

let dir: string
let server: Server
let url: string
let cloud: CloudStandIn
const sentBodies: string[] = []

const api = async (path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const json = async <T>(res: Response): Promise<{ status: number; body: T }> => ({
  status: res.status,
  body: (await res.json()) as T,
})

/** 数据目录里所有文件的字节拼一起（找密码 / 验证码有没有落盘）。 */
function everyByte(root: string): string {
  let out = ''
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) out += everyByte(p)
    else out += readFileSync(p).toString('latin1')
  }
  return out
}

beforeEach(async () => {
  sentBodies.length = 0
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp231-'))
  cloud = cloudStandIn({ autoLinkAfterMs: -1 })
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch: async (input, init) => {
      if (init?.body !== undefined) sentBodies.push(init.body)
      return cloud.fetch(input, init)
    },
  })
  url = (await server.listen(0)).url
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP231 注册与登录（本机这一跳）', () => {
  it('注册：没勾条款不许发；勾了 → 发码 → 验码 → 已关联、送 10 积分', async () => {
    const form = { name: '北风电器', email: 'new@example.com', password: PASSWORD, locale: 'zh' }
    expect((await api('/v1/cloud/account/signup', form)).status).toBe(400)
    expect((await api('/v1/cloud/account/signup', { ...form, accept_terms: false })).status).toBe(
      400,
    )
    const sent = await json<{ data: { delivered: string } }>(
      await api('/v1/cloud/account/signup', { ...form, accept_terms: true }),
    )
    expect(sent.status).toBe(200)
    expect(sent.body.data.delivered).toBe('email')
    // 转给云的那一跳带着同意记录与来源
    const forwarded = JSON.parse(sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    expect(forwarded.consent).toEqual({ accepted: true, terms_version: '2026-10-05' })
    expect(forwarded.source).toBe('workstation')

    const done = await json<{
      data: CloudAccountView & { registered?: boolean; bonus_credits?: number }
    }>(await api('/v1/cloud/account/signup/verify', { email: 'new@example.com', code: '135790' }))
    expect(done.status).toBe(200)
    expect(done.body.data.linked).toBe(true)
    expect(done.body.data.registered).toBe(true)
    expect(done.body.data.bonus_credits).toBe(10)

    // 密码与验证码一个字节都没落盘
    const bytes = everyByte(dir)
    expect(bytes).not.toContain(PASSWORD)
    expect(bytes).not.toContain('135790')
  })

  it('已注册的邮箱点注册 → 409 + already_registered（一键切到登录靠它）', async () => {
    const out = await json<{ code: string; details?: { reason?: string } }>(
      await api('/v1/cloud/account/signup', {
        name: '演示',
        email: CLOUD_STAND_IN_REGISTERED_EMAIL,
        password: PASSWORD,
        accept_terms: true,
      }),
    )
    expect(out.status).toBe(409)
    expect(out.body.details?.reason).toBe('already_registered')
  })

  it('验证码登录：没注册的邮箱发码静默成功；码不对是 400 + invalid_code（不是 401）', async () => {
    expect((await api('/v1/cloud/account/code', { email: 'nobody@example.com' })).status).toBe(200)
    expect(
      (await api('/v1/cloud/account/code', { email: CLOUD_STAND_IN_REGISTERED_EMAIL })).status,
    ).toBe(200)
    const wrong = await json<{ details?: { reason?: string } }>(
      await api('/v1/cloud/account/code/verify', {
        email: CLOUD_STAND_IN_REGISTERED_EMAIL,
        code: CLOUD_STAND_IN_WRONG_CODE,
      }),
    )
    expect(wrong.status).toBe(400)
    expect(wrong.body.details?.reason).toBe('invalid_code')
    const ok = await json<{ data: CloudAccountView }>(
      await api('/v1/cloud/account/code/verify', {
        email: CLOUD_STAND_IN_REGISTERED_EMAIL,
        code: '246810',
      }),
    )
    expect(ok.status).toBe(200)
    expect(ok.body.data.email).toBe(CLOUD_STAND_IN_REGISTERED_EMAIL)
  })

  it('密码登录：错了一句话不分是谁；对了已关联；关联过再登要先解除', async () => {
    const bad = await json<{ details?: { reason?: string } }>(
      await api('/v1/cloud/account/password-login', {
        email: CLOUD_STAND_IN_REGISTERED_EMAIL,
        password: 'not-the-password',
      }),
    )
    expect(bad.status).toBe(400)
    expect(bad.body.details?.reason).toBe('bad_credentials')
    const good = await api('/v1/cloud/account/password-login', {
      email: CLOUD_STAND_IN_REGISTERED_EMAIL,
      password: CLOUD_STAND_IN_PASSWORD,
    })
    expect(good.status).toBe(200)
    const again = await api('/v1/cloud/account/password-login', {
      email: CLOUD_STAND_IN_REGISTERED_EMAIL,
      password: CLOUD_STAND_IN_PASSWORD,
    })
    expect(again.status).toBe(409)
    expect(everyByte(dir)).not.toContain(CLOUD_STAND_IN_PASSWORD)
  })

  it('忘记密码：发码 → 验码 + 新密码 → 已关联；新密码太短本机先挡', async () => {
    expect(
      (await api('/v1/cloud/account/password/forgot', { email: CLOUD_STAND_IN_REGISTERED_EMAIL }))
        .status,
    ).toBe(200)
    const short = await api('/v1/cloud/account/password/reset', {
      email: CLOUD_STAND_IN_REGISTERED_EMAIL,
      code: '112233',
      new_password: 'short',
    })
    expect(short.status).toBe(400)
    const done = await api('/v1/cloud/account/password/reset', {
      email: CLOUD_STAND_IN_REGISTERED_EMAIL,
      code: '112233',
      new_password: PASSWORD,
    })
    expect(done.status).toBe(200)
    expect(everyByte(dir)).not.toContain(PASSWORD)
  })

  it('界面配置：取得到密码最短几位与条款版本', async () => {
    const cfg = await json<{ data: { password_min: number; terms_version: string } }>(
      await api('/v1/cloud/account/auth-config'),
    )
    expect(cfg.body.data.password_min).toBe(8)
    expect(cfg.body.data.terms_version).toBe('2026-10-05')
  })
})

describe('WP231 云的错误怎么翻', () => {
  it('云 401 → 本机 400（不让工作台以为本机登录过期），reason 照带', () => {
    const e = passThroughError(401, {
      code: 'unauthenticated',
      message: '验证码不对',
      details: { reason: 'invalid_code' },
    })
    expect(e.status).toBe(400)
    expect(e.details).toEqual({ reason: 'invalid_code' })
  })
  it('老版本的云没有这条路（404 没有 reason）→ 说云还没更新', () => {
    const e = passThroughError(404, { code: 'not_found', message: '没有这个入口' })
    expect(e.code).toBe('not_implemented')
  })
  it('429 带上等多久', () => {
    const e = passThroughError(429, {
      code: 'rate_limited',
      message: '发得太频繁了',
      details: { retry_after: 30, reason: 'locked' },
    })
    expect(e.status).toBe(429)
    expect(e.headers['Retry-After']).toBe('30')
  })
})
