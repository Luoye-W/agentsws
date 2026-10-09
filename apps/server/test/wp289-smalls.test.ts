/**
 * WP289（决策 293 / 307 / 313 / 318）几件小收尾——真服务进程。
 *
 * 钉住的：
 * 1. 293：② 发起人「请他离开」先问（列出他的个人连接），移出后只断他自己接的、标「个人」的，
 *    凭据删掉；共用的留下；同事问不了也请不了；
 * 2. 307：② 非发起人也读得到余额 / 价目 / 充值档（只读），充值仍只给有权限的人；
 * 3. 313：素材库默认不列遮罩，按用途筛得到；
 * 4. 318：聊天窗「教 AI」选「以后都这样」→ 同一张「以后都这样」卡，批了落进同一本职责规矩、
 *    进运行提示词；不再另起一份知识候选。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-09T02:00:00.000Z'

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

interface Who {
  id: string
  token: string
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
  who: { token: string; assignment: string },
  email: string,
  ownership: 'person' | 'workspace',
): Promise<string> {
  const res = await call('POST', '/v1/connections/imap_smtp/submit', {
    ...who,
    body: { alias: email, ownership, fields: MAIL(email, `pw-${email}`) },
  })
  expect([200, 201]).toContain(res.status)
  return (await data<{ connection: { id: string } }>(res)).connection.id
}

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

describe('WP289 请他离开时个人连接跟人走（决策 293）', () => {
  it('先问（列他的个人连接名字）；移出后只断他自己接的「个人」的，凭据删掉；共用的留下', async () => {
    const personal = await connectMail(as(lin), 'lin@private.cn', 'person')
    const shared = await connectMail(as(lin), 'sales@nordvolt.cn', 'workspace')
    // 发起人自己接的个人连接不在里面
    const mine = await connectMail(
      { token: server.bootstrap.internalToken, assignment: server.bootstrap.ownerAssignment.id },
      'boss@private.cn',
      'person',
    )
    // 同事问不了、也请不了（家务只归发起人）
    expect(
      (await call('GET', `/v1/workspaces/${ws()}/members/${lin.id}/leave`, as(lin))).status,
    ).toBe(403)

    const preview = await data<{ personal_connections: { id: string; label: string }[] }>(
      await call('GET', `/v1/workspaces/${ws()}/members/${lin.id}/leave`),
    )
    expect(preview.personal_connections.map((c) => c.id)).toEqual([personal])
    expect(preview.personal_connections[0]?.label).toContain('lin@private.cn')

    const removed = await data<{ revoked_assignments: number; disconnected?: number }>(
      await call('DELETE', `/v1/workspaces/${ws()}/members/${lin.id}`),
    )
    expect(removed.disconnected).toBe(1)
    const rest = (
      await data<{ connections: { id: string }[] }>(await call('GET', '/v1/connections'))
    ).connections.map((c) => c.id)
    expect(rest).toContain(shared)
    expect(rest).toContain(mine)
    expect(rest).not.toContain(personal)
    const vault = server.secrets.list().map((r) => r.connection_id)
    expect(vault).not.toContain(personal)
    expect(vault).toContain(shared)
    expect(vault).toContain(mine)
  })

  it('没有个人连接：问回空、移出不带 disconnected', async () => {
    await connectMail(as(lin), 'sales@nordvolt.cn', 'workspace')
    const preview = await data<{ personal_connections: unknown[] }>(
      await call('GET', `/v1/workspaces/${ws()}/members/${lin.id}/leave`),
    )
    expect(preview.personal_connections).toEqual([])
    const removed = await data<{ disconnected?: number }>(
      await call('DELETE', `/v1/workspaces/${ws()}/members/${lin.id}`),
    )
    expect(removed.disconnected).toBeUndefined()
  })
})
