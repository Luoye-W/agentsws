/**
 * WP278（docs/95 §4 / §7 C 收尾，决策 276 / 277 / 278 / 284）：② 同事互联收尾——真服务进程。
 *
 * 钉住的：
 * 1. 交出发起人：对方收「交给你」卡，接下才换（组织与品牌所有者、「负责人」那条），原发起人变普通同事、
 *    之后能自己退出；不接（带理由）/ 撤回 / 到点退回 / 等着的时候不能再交一次；③ 里不走这里；
 * 2. 请同事一起做：接下前分配不生效，接下那一刻才分（整个品牌）；不接什么都不分；
 * 3. 退出：先问（列出个人连接的名字），确认后只断他自己接的、标「个人」的，凭据从本机凭据库删，
 *    共用的留下；别人改不了这条的「个人 / 共用」；③ 开公司时选「我要退出」同样断；
 * 4. 只有一个岗位的人：岗位页的牌堆与「N 张等你定」收发给他、挂在底座职责上的卡；首页也收。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-09T02:00:00.000Z'
const DAY = 86_400_000

function seeded(seed = 17): () => number {
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
let now = Date.parse(T0)

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  const assignment = options.assignment ?? server.bootstrap.ownerAssignment.id
  if (assignment !== '') headers.set('X-Assignment', assignment)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

const post = (path: string, body: unknown) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const ws = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id
const orgId = (): string => {
  const org = server.organizations.organizationOf(ws())
  if (org === undefined) throw new Error('没有组织')
  return org.id
}

interface Who {
  id: string
  token: string
  /** 他手上随便一条还在的分配（发请求用）。 */
  assignment: () => string
}

async function colleague(email: string, name: string): Promise<Who> {
  const invitation = await data<{ url: string }>(
    await call('POST', `/v1/workspaces/${ws()}/invitations`, { body: { email, name } }),
  )
  const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await data<{ person_id: string }>(
    await post(`/v1/invitations/${token}/accept`, {}),
  )
  const login = await data<{ token: string }>(await post('/v1/auth/magic-link', { email }))
  const session = await data<{ session_token: string }>(
    await post('/v1/auth/verify', { token: login.token }),
  )
  const id = accepted.person_id
  return {
    id,
    token: session.session_token,
    assignment: () =>
      server.roles.assignments
        .listByPerson(id as never, { workspace_id: ws() as never })
        .filter((a) => a.revoked_at === undefined)
        .sort(
          (a, b) =>
            Number(a.role_id.startsWith('common.')) - Number(b.role_id.startsWith('common.')),
        )[0]?.id ?? '',
  }
}

const as = (w: Who) => ({ token: w.token, assignment: w.assignment() })

const queueOf = async (person_id: string): Promise<ApprovalItem[]> =>
  (await server.txn.approvals.queue({
    workspace_id: ws(),
    person_id,
    lane: 'mine',
    state: ['pending', 'in_review'],
  })) as ApprovalItem[]

const offerCardOf = async (person_id: string, object: string): Promise<ApprovalItem | undefined> =>
  (await queueOf(person_id)).find((i) => {
    const p = i.payload as { form?: string; object?: string }
    return i.kind === 'claim' && p.form === 'handoff' && p.object === object
  })

const holdsOwner = (person: string): boolean =>
  server.roles.assignments
    .listByPerson(person as never, {
      workspace_id: ws() as never,
      role_id: 'common.owner' as never,
    })
    .some((a) => a.revoked_at === undefined)

const offers = async () =>
  (
    await data<{
      offers: { id: string; kind: string; state: string; reason?: string; to_name: string }[]
    }>(await call('GET', '/v1/org/offers'))
  ).offers

let lin: Who

beforeEach(async () => {
  now = Date.parse(T0)
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { [SECRETS_KEY_ENV]: 'b'.repeat(64) },
    mdns: () => ({ reason: '测试里不开局域网' }),
  })
  lin = await colleague('lin@example.com', '林峰')
  expect(await server.organizations.modeOf(ws())).toBe('peers')
})

afterEach(async () => {
  await server.close()
})

describe('WP278 交出发起人（决策 276）', () => {
  it('对方收「交给你」卡，接下才换；原发起人变普通同事、之后能退出', async () => {
    // 发起人现在退不了
    expect((await call('POST', `/v1/workspaces/${ws()}/leave`)).status).toBe(409)
    // 同事不能交
    expect(
      (await call('POST', '/v1/org/initiator/offer', { ...as(lin), body: { person_id: owner() } }))
        .status,
    ).toBe(403)
    const sent = await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } })
    expect(sent.status).toBe(201)
    expect(await data<{ state: string; to_name: string }>(sent)).toMatchObject({
      state: 'offered',
      to_name: '林峰',
    })
    // 等着的时候再交一次 409
    expect(
      (await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } })).status,
    ).toBe(409)
    const card = await offerCardOf(lin.id, 'initiator')
    expect(card?.title).toContain('想把发起人交给你')
    expect(
      (card?.payload as { options?: { id: string; label: string }[] } | undefined)?.options,
    ).toEqual([{ id: 'accept', label: '接下' }])
    expect(card?.summary).not.toContain('想把发起人交给你')
    // 接下前什么都不变
    expect(server.organizations.organizationOf(ws())?.owner_id).toBe(owner())
    expect(holdsOwner(lin.id)).toBe(false)

    const res = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      ...as(lin),
      body: { action: 'approve', selected_option_id: 'accept' },
    })
    expect(res.status).toBe(200)
    const org = server.organizations.organizationOf(ws())
    expect(org?.owner_id).toBe(lin.id)
    expect((await server.identity.getWorkspace(ws() as never))?.owner_id).toBe(lin.id)
    expect(holdsOwner(lin.id)).toBe(true)
    expect(holdsOwner(owner())).toBe(false)
    expect(org?.members.find((m) => m.person_id === owner())?.role).toBe('member')
    // 还是 ②（没有变成公司）
    expect(await server.organizations.modeOf(ws())).toBe('peers')
    // 原发起人现在能自己退出（用他还在的那条分配）
    const mine = server.roles.assignments
      .listByPerson(owner() as never, { workspace_id: ws() as never })
      .find((a) => a.revoked_at === undefined)
    const left = await call('POST', `/v1/workspaces/${ws()}/leave`, {
      assignment: mine?.id ?? '',
    })
    expect(left.status).toBe(200)
  })

  it('不接（带理由）、撤回、到点退回；③ 里不走这里', async () => {
    await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } })
    const first = await offerCardOf(lin.id, 'initiator')
    const no = await call('POST', `/v1/approvals/${first?.id}/decide`, {
      ...as(lin),
      body: { action: 'reject', reason: '太忙' },
    })
    expect(no.status).toBe(200)
    expect(server.organizations.organizationOf(ws())?.owner_id).toBe(owner())
    expect((await offers()).find((o) => o.id === first?.id)).toMatchObject({
      state: 'declined',
      reason: '太忙',
    })

    // 撤回：对方那张卡收掉，「我发出去的」里不再挂
    const again = await data<{ id: string }>(
      await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } }),
    )
    const back = await call('POST', `/v1/org/offers/${again.id}/withdraw`)
    expect(back.status).toBe(200)
    expect(await offerCardOf(lin.id, 'initiator')).toBeUndefined()
    expect((await offers()).some((o) => o.id === again.id)).toBe(false)
    // 只有发的人能撤回
    const third = await data<{ id: string }>(
      await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } }),
    )
    expect((await call('POST', `/v1/org/offers/${third.id}/withdraw`, as(lin))).status).toBe(403)

    // 到点（默认 3 天）没人理：退回，对方那张卡也没了
    now += 4 * DAY
    expect((await offers()).find((o) => o.id === third.id)?.state).toBe('returned')
    expect(await offerCardOf(lin.id, 'initiator')).toBeUndefined()
    expect(server.organizations.organizationOf(ws())?.owner_id).toBe(owner())

    // ③：不走这里（老板 / 管理员那一套）
    const open = await call('PUT', `/v1/orgs/${orgId()}/mode`, {
      body: { mode: 'company', legal_name: '诺伏特科技有限公司' },
    })
    expect(open.status).toBe(200)
    expect(
      (await call('POST', '/v1/org/initiator/offer', { body: { person_id: lin.id } })).status,
    ).toBe(409)
  })
})

describe('WP278 请同事一起做（决策 277）', () => {
  const linB2b = () =>
    server.roles.assignments
      .listByPerson(lin.id as never, { workspace_id: ws() as never })
      .filter((a) => a.revoked_at === undefined && a.role_id.startsWith('b2b.'))

  it('接下前分配不生效；接下那一刻才分（整个品牌）；不接什么都不分', async () => {
    const sent = await call('POST', '/v1/org/positions/b2b/offer', { body: { person_id: lin.id } })
    expect(sent.status).toBe(201)
    expect(await data<{ position_name: string }>(sent)).toMatchObject({
      position_name: expect.any(String),
    })
    expect(linB2b()).toEqual([])
    const card = await offerCardOf(lin.id, 'position')
    expect(card?.title).toMatch(/请你一起做「.+」/)
    const ok = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      ...as(lin),
      body: { action: 'approve', selected_option_id: 'accept' },
    })
    expect(ok.status).toBe(200)
    const granted = linB2b()
    expect(granted.length).toBeGreaterThan(0)
    expect(granted.every((a) => a.ranges.some((r) => r.kind === 'brand' && r.id === ws()))).toBe(
      true,
    )
    // 已经在做了：不用再请
    expect(
      (await call('POST', '/v1/org/positions/b2b/offer', { body: { person_id: lin.id } })).status,
    ).toBe(409)

    // 另一个岗位：不接 → 什么都没分
    const he = await colleague('he@example.com', '何佳')
    await call('POST', '/v1/org/positions/b2b/offer', { body: { person_id: he.id } })
    const hers = await offerCardOf(he.id, 'position')
    await call('POST', `/v1/approvals/${hers?.id}/decide`, {
      ...as(he),
      body: { action: 'reject' },
    })
    expect(
      server.roles.assignments
        .listByPerson(he.id as never, { workspace_id: ws() as never })
        .some((a) => a.revoked_at === undefined && a.role_id.startsWith('b2b.')),
    ).toBe(false)
    // 「负责人」不是岗位：交它走「把发起人交给…」
    expect(
      (await call('POST', '/v1/org/positions/owner/offer', { body: { person_id: he.id } })).status,
    ).toBe(400)
    // 同事不能请
    expect(
      (
        await call('POST', '/v1/org/positions/b2b/offer', {
          ...as(lin),
          body: { person_id: he.id },
        })
      ).status,
    ).toBe(403)
  })
})

const MAIL = (email: string, password: string) => ({
  email,
  password,
  // 连不上的地址：试连一定失败，而且不用等 DNS
  imap_host: '127.0.0.1',
  imap_port: '1',
  smtp_host: '127.0.0.1',
  smtp_port: '2',
})

async function connectMail(
  who: Who,
  email: string,
  ownership: 'person' | 'workspace',
): Promise<string> {
  const res = await call('POST', '/v1/connections/imap_smtp/submit', {
    ...as(who),
    body: { alias: email, ownership, fields: MAIL(email, `pw-${email}`) },
  })
  expect([200, 201]).toContain(res.status)
  return (await data<{ connection: { id: string } }>(res)).connection.id
}

describe('WP278 退出时个人连接跟人走（决策 278）', () => {
  it('先问（列名字）；只断他自己接的、标「个人」的，凭据删掉；共用的留下', async () => {
    const personal = await connectMail(lin, 'lin@private.cn', 'person')
    const shared = await connectMail(lin, 'sales@nordvolt.cn', 'workspace')
    const marked = await connectMail(lin, 'lin.wx@private.cn', 'workspace')
    // 事后改标「个人」：只有接它的人能改
    expect(
      (await call('PUT', `/v1/connections/${marked}/ownership`, { body: { ownership: 'person' } }))
        .status,
    ).toBe(403)
    const set = await call('PUT', `/v1/connections/${marked}/ownership`, {
      ...as(lin),
      body: { ownership: 'person' },
    })
    expect(set.status).toBe(200)
    expect(await data<{ ownership: string; mine: boolean }>(set)).toMatchObject({
      ownership: 'person',
      mine: true,
    })
    // 发起人接的个人连接不算他的
    await connectMail(
      {
        id: owner(),
        token: server.bootstrap.internalToken,
        assignment: () => server.bootstrap.ownerAssignment.id,
      },
      'boss@private.cn',
      'person',
    )

    const preview = await data<{ personal_connections: { id: string; label: string }[] }>(
      await call('GET', `/v1/workspaces/${ws()}/leave`, as(lin)),
    )
    expect(preview.personal_connections.map((c) => c.id).sort()).toEqual([personal, marked].sort())
    expect(preview.personal_connections.map((c) => c.label).join(' ')).toContain('lin@private.cn')
    expect(server.secrets.list().map((r) => r.connection_id)).toContain(personal)

    const left = await data<{ disconnected?: number }>(
      await call('POST', `/v1/workspaces/${ws()}/leave`, as(lin)),
    )
    expect(left.disconnected).toBe(2)
    const rest = (
      await data<{ connections: { id: string }[] }>(await call('GET', '/v1/connections'))
    ).connections.map((c) => c.id)
    expect(rest).toContain(shared)
    expect(rest).not.toContain(personal)
    expect(rest).not.toContain(marked)
    const vault = server.secrets.list().map((r) => r.connection_id)
    expect(vault).not.toContain(personal)
    expect(vault).not.toContain(marked)
    expect(vault).toContain(shared)
  })

  it('③ 开公司时选「我要退出」：同样只断个人的', async () => {
    // ③ 里点卡要有批准权（他在做 B2B）
    await call('POST', '/v1/assignments', {
      body: { person_id: lin.id, position_id: 'b2b', ranges: [{ kind: 'brand', id: ws() }] },
    })
    const personal = await connectMail(lin, 'lin@private.cn', 'person')
    const shared = await connectMail(lin, 'sales@nordvolt.cn', 'workspace')
    const open = await call('PUT', `/v1/orgs/${orgId()}/mode`, {
      body: { mode: 'company', legal_name: '诺伏特科技有限公司' },
    })
    expect(open.status).toBe(200)
    const notice = (await queueOf(lin.id)).find(
      (i) => (i.payload as { form?: string }).form === 'company_notice',
    )
    const preview = await data<{ personal_connections: { id: string }[] }>(
      await call('GET', `/v1/workspaces/${ws()}/leave`, as(lin)),
    )
    expect(preview.personal_connections.map((c) => c.id)).toEqual([personal])
    const res = await call('POST', `/v1/approvals/${notice?.id}/decide`, {
      ...as(lin),
      body: { action: 'approve', selected_option_id: 'leave' },
    })
    expect(res.status).toBe(200)
    const vault = server.secrets.list().map((r) => r.connection_id)
    expect(vault).not.toContain(personal)
    expect(vault).toContain(shared)
  })
})

describe('WP278 只有一个岗位的人看得到底座卡（决策 284）', () => {
  it('岗位页牌堆（?base=1）与「N 张等你定」收发给他、挂在底座职责上的卡；首页也收', async () => {
    await call('POST', '/v1/assignments', {
      body: { person_id: lin.id, position_id: 'b2b', ranges: [{ kind: 'brand', id: ws() }] },
    })
    const sales = server.roles.assignments
      .listByPerson(lin.id as never, { workspace_id: ws() as never })
      .find((a) => a.revoked_at === undefined && a.role_id === 'b2b.sales')
    if (sales === undefined) throw new Error('没分到 b2b.sales')
    const who = { token: lin.token, assignment: sales.id }
    // 有人贴码申请一起用：② 里发给每个人，卡挂在 common.owner 上（林峰没有这条）
    const invite = await data<{ code: string }>(await call('POST', '/v1/invites'))
    await post('/v1/memberships/requests', {
      code: invite.code,
      name: '陈一',
      email: 'chen@ex.com',
    })
    const card = (await queueOf(lin.id)).find((i) => i.kind === 'membership')
    expect(card?.role_id.startsWith('common.')).toBe(true)

    const plain = await data<{ cards: { id: string }[] }>(
      await call('GET', `/v1/positions/${sales.id}/cards`, who),
    )
    expect(plain.cards.some((c) => c.id === card?.id)).toBe(false)
    const withBase = await data<{ cards: { id: string }[] }>(
      await call('GET', `/v1/positions/${sales.id}/cards?base=1`, who),
    )
    expect(withBase.cards.some((c) => c.id === card?.id)).toBe(true)
    const positions = await data<{ instances?: { position_id: string; pending_cards: number }[] }>(
      await call('GET', '/v1/positions', who),
    )
    expect(positions.instances?.length).toBe(1)
    expect(positions.instances?.[0]?.pending_cards).toBeGreaterThanOrEqual(1)
    const home = await data<{ queue: { id: string }[] }>(await call('GET', '/v1/home', who))
    expect(home.queue.some((c) => c.id === card?.id)).toBe(true)
  })
})
