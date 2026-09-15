/**
 * 49 M1 工作区关联 + 18 §1 的令牌纪律，五条硬断言：
 *
 * 1. 签发时明文**只回一次**，库里只有哈希；
 * 2. 撤销之后 verifier 回 `undefined`；
 * 3. 过期之后 verifier 回 `undefined`；
 * 4. **跨组织的令牌验不过**（A 的令牌不会被当成 B 的）；
 * 5. 最小动作集：没给的 scope 一律 403。
 */

import { cloudOk, cloudRoute } from '@agentsws/api'
import { CLOUD_SCOPES, DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createCloudServer, ScopeSchema, sqliteTokenVerifier } from '../src/index.js'
import { type Harness, harness, login, testClock } from './helpers.js'

interface IssuedBody {
  link: {
    id: string
    workspace_id: string
    cloud_org_id: string
    scopes: string[]
    active: boolean
  }
  token: string
}

async function issue(
  h: Harness,
  session: string,
  workspace_id: string,
  body: Record<string, unknown> = {},
): Promise<IssuedBody> {
  const res = await h.call('/v1/cloud/links', {
    method: 'POST',
    token: session,
    body: { workspace_id, ...body },
  })
  expect(res.status).toBe(201)
  return res.body.data as IssuedBody
}

describe('49 M1 工作区服务令牌', () => {
  it('zod 的动作集与契约逐字相同（不许出现第二份真源）', () => {
    expect([...ScopeSchema.options]).toEqual([...CLOUD_SCOPES])
  })

  it('签发时明文只回一次；库里只有哈希，列表与详情都查不到它', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1', { label: '女装品牌' })
      expect(issued.token.startsWith('wst_')).toBe(true)
      expect(issued.link.scopes).toEqual([...DEFAULT_CLOUD_SCOPES])

      // 库里：一行，只有哈希，没有明文
      const rows = h.server.store.db.prepare('SELECT * FROM workspace_links').all() as Record<
        string,
        unknown
      >[]
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(issued.token)
      expect(String(rows[0]?.token_sha256)).toMatch(/^[0-9a-f]{64}$/)

      // 列表：既没有明文，也没有哈希
      const list = await h.call('/v1/cloud/links', { token: session })
      const text = JSON.stringify(list.body)
      expect(text).not.toContain(issued.token)
      expect(text).not.toContain('token_sha256')
      expect(text).toContain('女装品牌')
    } finally {
      await h.close()
    }
  })

  it('撤销之后 verifier 回 undefined，但行还在（revoked_at 是一列不是删行）', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1')
      expect(await h.server.verifyToken(issued.token)).toBeDefined()

      const revoked = await h.call(`/v1/cloud/links/${issued.link.id}/revoke`, {
        method: 'POST',
        token: session,
      })
      expect(revoked.status).toBe(200)
      expect((revoked.body.data as { active: boolean }).active).toBe(false)
      expect(await h.server.verifyToken(issued.token)).toBeUndefined()

      const rows = h.server.store.db.prepare('SELECT * FROM workspace_links').all()
      expect(rows).toHaveLength(1)
      expect(h.server.store.link(issued.link.id)?.revoked_at).toBeDefined()
    } finally {
      await h.close()
    }
  })

  it('过期之后 verifier 回 undefined', async () => {
    const clock = testClock()
    const h = harness({ clock })
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1', { ttl_days: 1 })
      expect(await h.server.verifyToken(issued.token)).toBeDefined()
      clock.advance(25 * 60 * 60 * 1000)
      expect(await h.server.verifyToken(issued.token)).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('跨组织的令牌验不过：A 的令牌带回来的永远是 A，B 也查不到、撤不动 A 的关联', async () => {
    const h = harness()
    try {
      const a = await login(h, 'a@example.com')
      const b = await login(h, 'b@example.com')
      expect(a.org).not.toBe(b.org)
      const linkA = await issue(h, a.session, 'ws_a')
      const linkB = await issue(h, b.session, 'ws_b')

      const verifiedA = await h.server.verifyToken(linkA.token)
      expect(verifiedA?.org_id).toBe(a.org)
      expect(verifiedA?.org_id).not.toBe(b.org)
      expect((await h.server.verifyToken(linkB.token))?.org_id).toBe(b.org)

      // B 的会话看不到 A 的关联，也撤不动它——一律 not_found，不是 forbidden
      const list = await h.call('/v1/cloud/links', { token: b.session })
      const ids = (list.body.data as { links: { id: string }[] }).links.map((l) => l.id)
      expect(ids).toEqual([linkB.link.id])
      const cross = await h.call(`/v1/cloud/links/${linkA.link.id}/revoke`, {
        method: 'POST',
        token: b.session,
      })
      expect(cross.status).toBe(404)
      expect(await h.server.verifyToken(linkA.token)).toBeDefined()

      // 同一个工作区不能同时挂在两个组织上（一份钱只能从一个地方出）
      const conflict = await h.call('/v1/cloud/links', {
        method: 'POST',
        token: b.session,
        body: { workspace_id: 'ws_a' },
      })
      expect(conflict.status).toBe(409)
    } finally {
      await h.close()
    }
  })

  it('续期换一把新的，旧明文当场作废', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1')
      const renewed = await h.call(`/v1/cloud/links/${issued.link.id}/renew`, {
        method: 'POST',
        token: session,
        body: {},
      })
      expect(renewed.status).toBe(200)
      const next = renewed.body.data as IssuedBody
      expect(next.token).not.toBe(issued.token)
      expect(next.link.id).toBe(issued.link.id)
      expect(await h.server.verifyToken(issued.token)).toBeUndefined()
      expect(await h.server.verifyToken(next.token)).toBeDefined()
    } finally {
      await h.close()
    }
  })

  it('令牌自己能认自己、能撤自己（本地"解除关联"走这条）', async () => {
    const h = harness()
    try {
      const { session, org } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1')
      const current = await h.call('/v1/cloud/links/current', { token: issued.token })
      expect(current.status).toBe(200)
      const data = current.body.data as { org: { id: string }; account: { email: string } }
      expect(data.org.id).toBe(org)
      expect(data.account.email).toBe('luoye@example.com')

      const revoked = await h.call('/v1/cloud/links/current/revoke', {
        method: 'POST',
        token: issued.token,
      })
      expect(revoked.status).toBe(200)
      expect(await h.server.verifyToken(issued.token)).toBeUndefined()
      // 撤过之后再用同一把就是 401（不区分"撤了"与"没这把"）
      expect((await h.call('/v1/cloud/links/current', { token: issued.token })).status).toBe(401)
    } finally {
      await h.close()
    }
  })

  it('会话 token 当不了工作区令牌，工作区令牌也当不了会话', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1')
      expect((await h.call('/v1/cloud/links/current', { token: session })).status).toBe(401)
      expect((await h.call('/v1/cloud/me', { token: issued.token })).status).toBe(401)
    } finally {
      await h.close()
    }
  })
})

describe('49 M3 挂载点与最小动作集', () => {
  /** 一个假装是 WP59 的路由包：要 `ai`，什么也不做。 */
  const fakeEntry = [
    cloudRoute(
      {
        method: 'post',
        path: '/v1/ai/chat/completions',
        operationId: 'fakeAiChat',
        summary: '假装是服务入口',
        tag: 'cloud-entry',
        auth: 'workspace_token',
        scopes: ['ai'],
        returns: '{ ok: true }',
      },
      async (c) => cloudOk(c, { ok: true }),
    ),
  ]

  it('modules 挂进来的路由与自己的路由一样能用；scope 差一个就 403', async () => {
    const clock = testClock()
    const server = createCloudServer({
      clock,
      quiet: true,
      modules: [fakeEntry],
      mail: async () => {},
    })
    try {
      expect(server.routes.some((r) => r.spec.path === '/v1/ai/chat/completions')).toBe(true)
      expect(Object.keys(server.openapi.paths)).toContain('/v1/ai/chat/completions')

      const { account, org } = server.store.ensureAccount('luoye@example.com')
      const withAi = server.store.createLink({
        workspace_id: 'ws_1',
        cloud_org_id: org.id,
        created_by: account.id,
        scopes: ['ai'],
      })
      const withoutAi = server.store.createLink({
        workspace_id: 'ws_2',
        cloud_org_id: org.id,
        created_by: account.id,
        scopes: ['wallet:read'],
      })

      const call = async (token: string) =>
        server.fetch(
          new Request('http://cloud.test/v1/ai/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      expect((await call(withAi.token)).status).toBe(200)
      const denied = await call(withoutAi.token)
      expect(denied.status).toBe(403)
      const body = (await denied.json()) as { details: { missing: string[] } }
      expect(body.details.missing).toEqual(['ai'])
    } finally {
      await server.close()
    }
  })
})

describe('sqliteTokenVerifier 直接用（WP59 的路由包只依赖它）', () => {
  it('前缀不对的一律 undefined，不查库', async () => {
    const h = harness()
    try {
      const verify = sqliteTokenVerifier(h.server.store.db, h.clock)
      expect(await verify('cs_something')).toBeUndefined()
      expect(await verify('')).toBeUndefined()
      expect(await verify('wst_nope')).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('验成功会把 last_used_at 往前推', async () => {
    const clock = testClock()
    const h = harness({ clock })
    try {
      const { session } = await login(h, 'luoye@example.com')
      const issued = await issue(h, session, 'ws_1')
      expect(h.server.store.link(issued.link.id)?.last_used_at).toBeUndefined()
      clock.advance(60_000)
      await h.server.verifyToken(issued.token)
      expect(h.server.store.link(issued.link.id)?.last_used_at).toBe(clock.now())
    } finally {
      await h.close()
    }
  })
})
