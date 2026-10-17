/**
 * WP371 本机登录后续（决策 942–944）——真服务（`createServer` + `listen`，真 HTTP）+ 云替身。
 *
 * - 942 托盘一次性链接：只在本机档发、用一次就废、过期拒；局域网档不发；
 * - 943 工坊账号进门：同事验码进门；不是成员被拒；验完云端会话当场注销、本机不存；
 *   主人在首次设置关联了工坊账号之后，用账号邮箱就能进门（WP233 把占位邮箱换掉）；
 * - 944 浏览器会话 30 天；被移出工作区当场失效。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const KEY = 's'.repeat(48)
const COLLEAGUE = CLOUD_STAND_IN_REGISTERED_EMAIL
const DAY_S = 24 * 60 * 60

let server: Server | undefined
let dir: string | undefined
let url = ''
let cloud: CloudStandIn

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function boot(env: Record<string, string> = {}): Promise<Server> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp371-'))
  cloud = cloudStandIn({ autoLinkAfterMs: -1 })
  server = await createServer({
    dbDir: dir,
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    env: {
      AGENTSWS_SESSION_KEY: KEY,
      [SECRETS_KEY_ENV]: 'c'.repeat(64),
      AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL,
      ...env,
    },
    cloudFetch: (input, init) => cloud.fetch(input, init),
    // 局域网档会印主人设置码：测试里收进黑洞，不往终端打
    setupCodeLog: () => undefined,
  })
  url = (await server.listen(0)).url
  return server
}

const call = (
  path: string,
  body?: unknown,
  opts: { bearer?: string; owner?: boolean; method?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (opts.owner === true && server !== undefined) {
    headers.set('authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('x-assignment', server.bootstrap.ownerAssignment.id)
  }
  if (opts.bearer !== undefined) headers.set('authorization', `Bearer ${opts.bearer}`)
  return fetch(`${url}${path}`, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

/** 一次性登录 token → 浏览器会话（`/v1/auth/verify`，工作台登录页的最后一步）。 */
const enter = async (token: string): Promise<{ person_id: string; session: string }> => {
  const out = await dataOf<{ person: { id: string }; session_token: string }>(
    await call('/v1/auth/verify', { token }),
  )
  return { person_id: out.person.id, session: out.session_token }
}

const inviteAndAccept = async (s: Server, email: string): Promise<string> => {
  const invited = await dataOf<{ url: string }>(
    await call(
      `/v1/workspaces/${s.bootstrap.workspace.id}/invitations`,
      { email },
      { owner: true },
    ),
  )
  const token = invited.url.slice(invited.url.lastIndexOf('/') + 1)
  return (await dataOf<{ person_id: string }>(await call(`/v1/invitations/${token}/accept`, {})))
    .person_id
}

const accountEnter = async (email: string, code = '135790'): Promise<Response> => {
  expect((await call('/v1/auth/account/code', { email })).status).toBe(200)
  return call('/v1/auth/account/verify', { email, code })
}

describe('决策 942：托盘「在浏览器打开」的一次性链接', () => {
  it('本机档：会话密钥换到主人的一次性 token → 进门是主人、会话 30 天；第二次用 401', async () => {
    const s = await boot()
    expect(s.loginMode).toBe('local')
    expect((await call('/v1/auth/browser-link', { key: 'x'.repeat(48) })).status).toBe(401)
    const link = await dataOf<{ token: string }>(await call('/v1/auth/browser-link', { key: KEY }))
    const entered = await enter(link.token)
    expect(entered.person_id).toBe(s.bootstrap.person.id)
    const info = await dataOf<{ expires_in_seconds: number }>(
      await call('/v1/auth/session', undefined, { bearer: entered.session }),
    )
    expect(info.expires_in_seconds).toBeGreaterThan(29 * DAY_S)
    expect(info.expires_in_seconds).toBeLessThanOrEqual(30 * DAY_S)
    expect((await call('/v1/auth/verify', { token: link.token })).status).toBe(401)
  })

  it('局域网档（AGENTSWS_LOGIN_MODE=shared）一律不发', async () => {
    const s = await boot({ AGENTSWS_LOGIN_MODE: 'shared' })
    expect(s.loginMode).toBe('shared')
    const res = await call('/v1/auth/browser-link', { key: KEY })
    expect(res.status).toBe(501)
    expect(JSON.stringify(await res.json())).not.toMatch(/"token"/)
  })
})

describe('决策 943：用工坊账号进工作区', () => {
  it('还不是成员：码对了也进不去（404 not_member）；码不对 400', async () => {
    await boot()
    const wrong = await accountEnter(COLLEAGUE, '000000')
    expect(wrong.status).toBe(400)
    const stranger = await accountEnter(COLLEAGUE)
    expect(stranger.status).toBe(404)
    expect(((await stranger.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      'not_member',
    )
  })

  it('同事（局域网档）：邀请接受之后用工坊账号验码进门；云端会话当场注销、本机不关联', async () => {
    const s = await boot({ AGENTSWS_LOGIN_MODE: 'shared' })
    const colleague = await inviteAndAccept(s, COLLEAGUE)
    const res = await accountEnter(COLLEAGUE)
    expect(res.status).toBe(200)
    const entered = await enter((await dataOf<{ token: string }>(res)).token)
    expect(entered.person_id).toBe(colleague)
    const paths = cloud.requests().map((r) => `${r.method} ${new URL(r.url).pathname}`)
    expect(paths).toContain('POST /v1/cloud/auth/otp/verify')
    expect(paths.at(-1)).toBe('POST /v1/cloud/auth/logout')
    expect(paths).not.toContain('POST /v1/cloud/links')
    const account = await dataOf<{ linked: boolean }>(
      await call('/v1/cloud/account', undefined, { owner: true }),
    )
    expect(account.linked).toBe(false)
  })

  it('主人：首次设置用工坊账号登录（关联）之后，用这个账号邮箱就能进门', async () => {
    const s = await boot()
    expect(
      (await call('/v1/cloud/account/code', { email: COLLEAGUE }, { owner: true })).status,
    ).toBe(200)
    expect(
      (
        await call(
          '/v1/cloud/account/code/verify',
          { email: COLLEAGUE, code: '135790' },
          { owner: true },
        )
      ).status,
    ).toBe(200)
    // WP233：占位 owner@localhost 换成账号邮箱是事件钩子里异步做的
    for (let i = 0; i < 50; i++) {
      const hint = (await (await call('/app/bootstrap.json')).json()) as { owner_email?: string }
      if (hint.owner_email === COLLEAGUE) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const res = await accountEnter(COLLEAGUE)
    expect(res.status).toBe(200)
    expect((await enter((await dataOf<{ token: string }>(res)).token)).person_id).toBe(
      s.bootstrap.person.id,
    )
  })
})

describe('决策 944：浏览器会话 30 天，改成员当场失效', () => {
  it('同事的 30 天会话：被请离工作区之后立刻 401', async () => {
    const s = await boot()
    const colleague = await inviteAndAccept(s, 'mate@nordvolt.example')
    const { token } = await dataOf<{ token: string }>(
      await call('/v1/auth/magic-link', { email: 'mate@nordvolt.example' }),
    )
    const entered = await enter(token)
    expect(entered.person_id).toBe(colleague)
    expect((await call('/v1/me', undefined, { bearer: entered.session })).status).toBe(200)
    const removed = await call(
      `/v1/workspaces/${s.bootstrap.workspace.id}/members/${colleague}`,
      undefined,
      { owner: true, method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    expect((await call('/v1/me', undefined, { bearer: entered.session })).status).toBe(401)
  })
})
