/**
 * WP71b（36 §10.1 那个洞的修法）：**你在哪一层干活，就看得见哪一层**。
 *
 * WP71 在真 demo 上打出来的洞：职责模板里根本没有 `skill` 与 `policy` 这两个域
 * （只有 `common.owner` 有），于是当前分配一切到某条职责，
 * `GET /v1/memory`、`GET /v1/skills`、`GET /v1/skills/:name/resolved`、
 * `GET /v1/roles/:id` 一起 403 —— 记忆 / 技能 / 额度三个面板与职责页概览
 * 对**每一个非 owner** 都打不开。
 *
 * 这一组用例用的是**真的普通成员**（邀请 → 接受 → 自己的会话 token，不是 owner 的），
 * 钉住四条：
 *
 * - 切到本人持有的 `dtc.store`：记忆 / 技能 / 额度 / 职责页概览四条读**全都开得了**；
 * - 切到本人**不持有**的那条职责：仍然 403（这道门收窄了，不是拆了）；
 * - 岗位层：在这个岗位里就读得到，不在就 403；
 * - 上面几层（内置包 / 公司 / 部门）任何成员读得到，但**写仍然只有 owner**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { canEditMemory, canReadMemory } from '../src/learning.js'

const T0 = '2026-09-16T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 71): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
/** 这位同事名下**只有**这条职责（外加加入工作区自带的 `common.member`）。 */
const HELD = 'dtc.store'
/** 他没有的那条——用来证这道门是收窄了，不是拆了。 */
const NOT_HELD = 'dtc.support'

interface Member {
  token: string
  person_id: string
  /** 他在 `dtc.store` 上的那条分配（请求要带的 `X-Assignment`）。 */
  assignment: string
}

const raw = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  if (options.assignment !== undefined) headers.set('X-Assignment', options.assignment)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

/** 邀请一位同事、接受、登录，再给他挂上 `dtc.store`。**他不是 owner。** */
async function inviteMember(email: string): Promise<Member> {
  const ws = server.bootstrap.workspace.id
  const invitation = await dataOf<{ url: string }>(
    await raw('POST', `/v1/workspaces/${ws}/invitations`, {
      body: { email, name: '李默' },
      assignment: server.bootstrap.ownerAssignment.id,
    }),
  )
  const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await dataOf<{ person_id: string }>(
    await raw('POST', `/v1/invitations/${encodeURIComponent(token)}/accept`, { body: {} }),
  )
  const link = await dataOf<{ token: string }>(
    await raw('POST', '/v1/auth/magic-link', { body: { email } }),
  )
  const session = await dataOf<{ session_token: string }>(
    await raw('POST', '/v1/auth/verify', { body: { token: link.token } }),
  )
  const assignment = server.roles.assignments.create({
    person_id: accepted.person_id,
    workspace_id: ws,
    role_id: HELD,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
  return { token: session.session_token, person_id: accepted.person_id, assignment: assignment.id }
}

let member: Member

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  member = await inviteMember('li@example.com')
})

afterEach(async () => {
  await server.close()
})

/** 这位同事以他自己的身份、用他 `dtc.store` 那条分配去请求。 */
const asMember = (path: string): Promise<Response> =>
  raw('GET', path, { token: member.token, assignment: member.assignment })

describe('WP71b 普通成员切到自己持有的职责：四条读全都开得了', () => {
  it('他真的不是 owner（不然这一组用例什么都证不了）', () => {
    const held = server.roles.assignments
      .listByPerson(member.person_id, { workspace_id: server.bootstrap.workspace.id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => a.role_id)
    expect(held).toContain(HELD)
    expect(held).not.toContain('common.owner')
  })

  it('记忆：`GET /v1/memory?tier=role&scope_id=dtc.store` 开得了', async () => {
    const res = await asMember(`/v1/memory?tier=role&scope_id=${HELD}`)
    expect(res.status).toBe(200)
    const view = await dataOf<{ tier: string; can_edit?: boolean }>(res)
    expect(view.tier).toBe('role')
    // 看得见也改得动：这条职责就在他名下
    expect(view.can_edit).toBe(true)
  })

  it('技能：列表与 `:name/resolved` 都开得了', async () => {
    expect((await asMember('/v1/skills')).status).toBe(200)
    expect((await asMember('/v1/skills/customer-care/resolved')).status).toBe(200)
  })

  it('额度 / 职责页概览：`GET /v1/roles/dtc.store` 开得了', async () => {
    const res = await asMember(`/v1/roles/${HELD}`)
    expect(res.status).toBe(200)
    const view = await dataOf<{ id: string; actions: unknown[] }>(res)
    expect(view.id).toBe(HELD)
  })

  it('岗位层：他在网站运营这个岗位里，所以那一层也读得到', async () => {
    const res = await asMember('/v1/memory?tier=position&scope_id=web-ops')
    expect(res.status).toBe(200)
  })
})

describe('WP71b 这道门是收窄了，不是拆了', () => {
  it('不持有的那条职责：记忆 403', async () => {
    const res = await asMember(`/v1/memory?tier=role&scope_id=${NOT_HELD}`)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { message?: string }
    expect(body.message).toContain('不在你名下')
  })

  it('不持有的那条职责：它的定义也读不到（`GET /v1/roles/dtc.support`）', async () => {
    expect((await asMember(`/v1/roles/${NOT_HELD}`)).status).toBe(403)
  })

  it('不在他名下的那个岗位：那一层的记忆 403', async () => {
    const res = await asMember('/v1/memory?tier=position&scope_id=customer-care')
    expect(res.status).toBe(403)
  })

  it('改职责模板仍然要 `policy.stage`：`PUT /v1/roles/:id` 对普通成员是 403', async () => {
    const res = await raw('PUT', `/v1/roles/${HELD}`, {
      token: member.token,
      assignment: member.assignment,
      body: { actions: [{ id: 'price_change', caps: { max_pct: 5 } }] },
    })
    expect(res.status).toBe(403)
  })
})

describe('WP71b 上面几层：任何成员读得到，写仍然只有 owner', () => {
  it('公司层记忆读得到，但 can_edit 是假', async () => {
    const res = await asMember('/v1/memory?tier=company')
    expect(res.status).toBe(200)
    const view = await dataOf<{ can_edit?: boolean }>(res)
    expect(view.can_edit).toBe(false)
  })

  it('owner 自己两样都真', async () => {
    const res = await raw('GET', '/v1/memory?tier=company', {
      assignment: server.bootstrap.ownerAssignment.id,
    })
    expect(res.status).toBe(200)
    expect((await dataOf<{ can_edit?: boolean }>(res)).can_edit).toBe(true)
  })
})

/** 判据本身（纯函数）：上面那几条证的是"门装在路由上"，这几条证的是"门的规则对"。 */
describe('WP71b canReadMemory 判据', () => {
  const positions = [
    { id: 'web-ops', roles: [{ role: 'dtc.store' }, { role: 'dtc.content' }] },
    { id: 'customer-care', roles: [{ role: 'dtc.support' }] },
  ]
  const base = { held_roles: ['dtc.store'] as string[], positions, is_owner: false }

  it('内置包 / 公司 / 部门：任何成员读得到——但一个都改不动（owner 除外）', () => {
    for (const tier of ['package', 'company', 'department'] as const) {
      expect(canReadMemory({ ...base, tier, scope_id: 'x' }).ok).toBe(true)
    }
    expect(canEditMemory({ ...base, tier: 'company' }).ok).toBe(false)
    expect(canEditMemory({ ...base, tier: 'company', is_owner: true }).ok).toBe(true)
    // 内置包是上游的：owner 也改不动
    expect(canEditMemory({ ...base, tier: 'package', is_owner: true }).ok).toBe(false)
  })

  it('职责层 / 岗位层：读与写同一条线（在哪一层干活就看哪一层）', () => {
    expect(canReadMemory({ ...base, tier: 'role', scope_id: 'dtc.store' }).ok).toBe(true)
    expect(canReadMemory({ ...base, tier: 'role', scope_id: 'dtc.support' }).ok).toBe(false)
    expect(canReadMemory({ ...base, tier: 'position', scope_id: 'web-ops' }).ok).toBe(true)
    expect(canReadMemory({ ...base, tier: 'position', scope_id: 'customer-care' }).ok).toBe(false)
  })

  it('岗位 / 职责层没给 scope_id：不猜，直接拒', () => {
    expect(canReadMemory({ ...base, tier: 'role' }).ok).toBe(false)
    expect(canReadMemory({ ...base, tier: 'position' }).ok).toBe(false)
  })

  /**
   * WP71b 顺带修掉的一个真洞：`org.positions()` 会把全员自带的 `common.member`
   * 追加进**每一个**岗位模板。不摘掉它，"在不在这个岗位里"对每个成员都成立——
   * 刚进公司的人也能读写客服岗位那一层。
   */
  it('`common.member` 不算"在这个岗位里"（它是"你进了这家公司"，不属于任何岗位）', () => {
    const withMember = [
      { id: 'customer-care', roles: [{ role: 'dtc.support' }, { role: 'common.member' }] },
    ]
    const onlyMember = { held_roles: ['common.member'], positions: withMember, is_owner: false }
    expect(canReadMemory({ ...onlyMember, tier: 'position', scope_id: 'customer-care' }).ok).toBe(
      false,
    )
    expect(canEditMemory({ ...onlyMember, tier: 'position', scope_id: 'customer-care' }).ok).toBe(
      false,
    )
    // 真持有这个岗位下的一条职责才算数
    const real = { held_roles: ['dtc.support'], positions: withMember, is_owner: false }
    expect(canReadMemory({ ...real, tier: 'position', scope_id: 'customer-care' }).ok).toBe(true)
  })
})
