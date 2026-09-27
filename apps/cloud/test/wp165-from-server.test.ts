/**
 * WP165（docs/83 §2 第 5 条）：从 `apps/server/test/cloud-account.test.ts` 挪过来的「真云那一半」。
 *
 * 本机那边现在打云端账号面的契约替身（`@agentsws/stand-ins` 的 `CloudAccountsStandIn`），
 * 以前顺带验过的云上行为搬到这里、打真路由，覆盖不减：
 *
 * 1. **补签**（WP66：每个品牌各一把）：同一组织、同一套动作集，组织从调用者那条关联上取、
 *    请求体说了不算；给自己补签回 409；补签出来的与原来那把各是各的；
 * 2. 关联之后按工作区能查到**活着的那一条**；自撤之后查不到，但行还在（撤销是一列）；
 * 3. 一次性登录链接用第二次不认。
 *
 * 「库里只存哈希」「跨组织验不过」在 `links.test.ts`，一次性 token 过期在 `auth.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { harness, login } from './helpers.js'

interface Issued {
  link: { id: string; workspace_id: string; cloud_org_id: string; scopes: string[] }
  token: string
}

describe('WP165 从 apps/server 挪来的云上行为', () => {
  it('补签：同组织、同动作集、各是各的；给自己补签 409；自撤之后那一条查不到、行还在', async () => {
    const h = harness()
    try {
      const { session, org } = await login(h, 'luoye@example.com')
      const first = await h.call('/v1/cloud/links', {
        method: 'POST',
        token: session,
        body: { workspace_id: 'ws_a', label: 'ws_a' },
      })
      expect(first.status).toBe(201)
      const a = first.body.data as Issued
      const sibling = await h.call('/v1/cloud/links/sibling', {
        method: 'POST',
        token: a.token,
        // 请求体里塞一个别的组织也没用：组织从调用者那条关联上取
        body: { workspace_id: 'ws_b', label: 'ws_b', cloud_org_id: 'org_somebody_else' },
      })
      expect(sibling.status).toBe(201)
      const b = sibling.body.data as Issued
      expect(b.link.cloud_org_id).toBe(org)
      expect(b.link.scopes).toEqual(a.link.scopes)
      expect(b.token).not.toBe(a.token)
      expect(h.server.store.activeLinkOfWorkspace('ws_a')?.id).toBe(a.link.id)
      expect(h.server.store.activeLinkOfWorkspace('ws_b')?.id).toBe(b.link.id)

      const self = await h.call('/v1/cloud/links/sibling', {
        method: 'POST',
        token: a.token,
        body: { workspace_id: 'ws_a' },
      })
      expect(self.status).toBe(409)

      const revoked = await h.call('/v1/cloud/links/current/revoke', {
        method: 'POST',
        token: b.token,
      })
      expect(revoked.status).toBe(200)
      expect(h.server.store.activeLinkOfWorkspace('ws_b')).toBeUndefined()
      expect(h.server.store.link(b.link.id)?.revoked_at).toBeDefined()
      // 撤的是它自己那一把，品牌甲那一把照样活着
      expect(h.server.store.activeLinkOfWorkspace('ws_a')?.id).toBe(a.link.id)
    } finally {
      await h.close()
    }
  })

  it('一次性登录链接只认一次（本机「同一条链接只能用一次」靠这条）', async () => {
    const h = harness()
    try {
      await h.call('/v1/cloud/auth/magic-link', {
        method: 'POST',
        body: {
          email: 'luoye@example.com',
          callback_url: 'http://127.0.0.1:4399/v1/cloud/account/callback',
          state: 's1',
        },
      })
      const token = new URL(h.lastLink()).searchParams.get('token') ?? ''
      const once = await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
      expect(once.status).toBe(200)
      const twice = await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
      expect(twice.status).toBe(401)
    } finally {
      await h.close()
    }
  })
})
