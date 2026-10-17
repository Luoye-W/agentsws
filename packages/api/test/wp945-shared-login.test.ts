/**
 * 决策 945：服务开给局域网（NAS）时的进门方式——网关这一层。
 *
 * - 一次性 token 不进响应（`exposeMagicLinkToken: false`，老测试 auth.test.ts 已钉）；
 * - 主人用日志里的设置码换一次性登录 token：`POST /v1/auth/setup-code`；
 * - 同事的邀请接受完直接带一张一次性登录 token（邀请链接本身就是凭据）；本机档不带。
 */
import { describe, expect, it } from 'vitest'
import type { AcceptedInvitationView, OrgPort, OwnerSetupCodePort } from '../src/index.js'
import { harness } from './helpers.js'

const ANON = { assignment: null } as const

/** 只认一个码、用一次就废的替身；真的那份（轮换、连错作废、印日志）在 apps/server。 */
function oneCode(code: string, email: string): OwnerSetupCodePort & { tried: string[] } {
  let live = true
  const tried: string[] = []
  return {
    tried,
    async redeem(input) {
      tried.push(input)
      if (!live || input !== code) return undefined
      live = false
      return email
    },
  }
}

/** 制度面替身：只实现 accept，其余不碰。 */
function orgAccepting(email: string): OrgPort {
  const view: AcceptedInvitationView = {
    workspace_id: 'ws_1',
    workspace_name: 'NordVolt Gear',
    email,
    person_id: 'per_x',
    assignments: [],
  }
  return { accept: async () => view } as unknown as OrgPort
}

describe('POST /v1/auth/setup-code', () => {
  it('本机档没装设置码 → 501（这条路只在局域网档开）', async () => {
    const h = await harness()
    const res = await h.post('/v1/auth/setup-code', { code: 'ABCD-EFGH' }, ANON)
    expect(res.status).toBe(501)
  })

  it('码对了换一次性登录 token，能换会话、是主人本人；同一个码第二次 401', async () => {
    const port = oneCode('ABCDEFGH', 'me@example.com')
    const h = await harness({ exposeMagicLinkToken: false, ownerSetupCode: port })
    const res = await h.post('/v1/auth/setup-code', { code: 'ABCDEFGH' }, ANON)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { token: string; expires_at: string } }
    expect(data.token).toBeTruthy()

    const verified = await h.post('/v1/auth/verify', { token: data.token }, ANON)
    expect(verified.status).toBe(200)
    const session = (await verified.json()) as {
      data: { person: { id: string }; session_token: string }
    }
    expect(session.data.person.id).toBe(h.person_id)

    const again = await h.post('/v1/auth/setup-code', { code: 'ABCDEFGH' }, ANON)
    expect(again.status).toBe(401)
  })

  it('码错 → 401，不发 token', async () => {
    const h = await harness({
      exposeMagicLinkToken: false,
      ownerSetupCode: oneCode('ABCDEFGH', 'me@example.com'),
    })
    const res = await h.post('/v1/auth/setup-code', { code: 'ZZZZZZZZ' }, ANON)
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).not.toMatch(/"token"/)
  })

  it('局域网档按邮箱要链接拿不到 token（谁都能填主人邮箱那条洞）', async () => {
    const h = await harness({
      exposeMagicLinkToken: false,
      ownerSetupCode: oneCode('ABCDEFGH', 'me@example.com'),
    })
    const res = await h.post('/v1/auth/magic-link', { email: 'me@example.com' }, ANON)
    const body = (await res.json()) as { data: { token?: string } }
    expect(body.data.token).toBeUndefined()
  })
})

describe('POST /v1/invitations/:token/accept', () => {
  it('局域网档：接受完直接带一次性登录 token，能换成被邀请人的会话', async () => {
    const h = await harness({ exposeMagicLinkToken: false, org: orgAccepting('other@example.com') })
    const res = await h.post('/v1/invitations/inv_x/accept', {}, ANON)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: AcceptedInvitationView }
    expect(data.login_token).toBeTruthy()
    expect(data.login_expires_at).toBeTruthy()

    const verified = await h.post('/v1/auth/verify', { token: data.login_token }, ANON)
    const session = (await verified.json()) as { data: { person: { id: string } } }
    expect(session.data.person.id).toBe(h.other_id)
  })

  it('本机档：照旧不带（那里用邮箱要链接，行为不变）', async () => {
    const h = await harness({ org: orgAccepting('other@example.com') })
    const res = await h.post('/v1/invitations/inv_x/accept', {}, ANON)
    const { data } = (await res.json()) as { data: AcceptedInvitationView }
    expect(data.login_token).toBeUndefined()
    expect(data.email).toBe('other@example.com')
  })
})
