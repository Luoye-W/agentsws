/**
 * WP510（决策 1515）：同事 / 公司模式的收件箱——服务进程这一层。
 *
 * 钉住的：
 * 1. 「谁在看」：心跳 20 秒没来算离开；`null` 立刻消失；不含自己；
 * 2. 分工存在品牌目录、重启还在；① 不让改（409）；③ 只有老板 / 管理员能改；负责人只能是同事；没连的邮箱 404；
 *    改一次写一条事件（地址遮过）；
 * 3. 真服务进程：① 个人收件箱没有团队那一面、心跳回空；② 两个人——一人打开、另一人看到「在看」，离开就没了；
 *    同事不要了一张卡，发起人的「刚处理」里写着他的名字。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalItem,
  EventEnvelope,
  InboxPresenceView,
  TeamInboxView,
} from '@agentsws/contracts'
import type { InboxView } from '@agentsws/deck'
import { createTxn } from '@agentsws/txn'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createTeamInbox, type TeamDirectory, TeamPresence } from '../src/team-inbox.js'

describe('WP510 谁在看（内存心跳）', () => {
  it('20 秒没跳算离开；null 立刻消失；不含自己；按品牌分开', () => {
    const p = new TeamPresence()
    p.beat('ws_a', 'p_lin', '林峰', 'card:1', 0)
    p.beat('ws_a', 'p_wang', '王芳', 'card:1', 0)
    p.beat('ws_b', 'p_x', 'X', 'card:1', 0)
    expect(p.viewers('ws_a', 'p_wang', 5_000)).toEqual({
      'card:1': [{ person_id: 'p_lin', name: '林峰' }],
    })
    expect(p.viewers('ws_a', 'p_wang', 25_000)).toEqual({})
    p.beat('ws_a', 'p_lin', '林峰', 'mail:t', 30_000)
    p.beat('ws_a', 'p_lin', '林峰', null, 31_000)
    expect(p.viewers('ws_a', 'p_wang', 31_000)).toEqual({})
  })
})

describe('WP510 分工（邮箱负责人、天数、交给谁）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const make = (mode: TeamDirectory['mode'], dir?: string) => {
    const events: EventEnvelope[] = []
    const clock = { now: () => '2026-10-25T02:00:00.000Z', sleep: async () => undefined }
    const txn = createTxn({ clock, random: () => 0.3, eventSink: () => undefined })
    const team = createTeamInbox({
      workspace_id: 'ws_1',
      clock,
      ...(dir === undefined ? {} : { dir }),
      appendEvent: (e) => void events.push(e as EventEnvelope),
      directory: async () => ({
        mode,
        members: [
          { person_id: 'p_wang', name: '王芳', admin: true },
          { person_id: 'p_lin', name: '林峰', admin: false },
        ],
      }),
      mailboxes: () => ['Sales@Brand.example', 'hello@brand.example'],
      holdersOf: () => [],
      approvals: txn.approvals,
    })
    return { team, events }
  }

  it('① 不让改；③ 只有老板 / 管理员能改；负责人只能是同事；没连的邮箱 404', async () => {
    await expect(make('solo').team.update('p_wang', { away_days: 5 })).rejects.toMatchObject({
      code: 'conflict',
    })
    const company = make('company').team
    expect((await company.view('p_lin')).can_edit).toBe(false)
    await expect(company.update('p_lin', { away_days: 5 })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect((await company.view('p_wang')).can_edit).toBe(true)
    await expect(
      company.update('p_wang', { mailbox: { account: 'hello@brand.example', owners: ['p_x'] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      company.update('p_wang', { mailbox: { account: 'nope@brand.example', owners: [] } }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // ② 平级：谁都能改
    expect((await make('peers').team.view('p_lin')).can_edit).toBe(true)
  })

  it('存在品牌目录、重启还在；改一次一条事件，地址遮过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp510-'))
    dirs.push(dir)
    const { team, events } = make('peers', dir)
    const view = await team.update('p_lin', {
      mailbox: { account: 'sales@brand.example', owners: ['p_lin', 'p_wang'] },
    })
    expect(view.mailboxes).toEqual([
      { account: 'sales@brand.example', owners: ['p_lin', 'p_wang'] },
      { account: 'hello@brand.example', owners: [] },
    ])
    await team.update('p_lin', { away_days: 99, fallback: 'position' })
    const again = await make('peers', dir).team.view('p_wang')
    expect(again.mailboxes[0]?.owners).toEqual(['p_lin', 'p_wang'])
    expect(again.settings).toMatchObject({
      away_days: 30,
      fallback: 'position',
      updated_by: 'p_lin',
    })
    expect(events.map((e) => e.type)).toEqual(['inbox.team_changed', 'inbox.team_changed'])
    expect(JSON.stringify(events[0]?.payload)).toContain('s***@brand.example')
    expect(JSON.stringify(events[0]?.payload)).not.toContain('sales@')
    // 没上线记录的人不算不在
    expect(again.members.every((m) => m.away === false)).toBe(true)
  })
})

/* ── 真服务进程：① 和 ② 两个人 ─────────────────────────────────────────── */

const T0 = '2026-10-25T02:00:00.000Z'
let server: Server

function seeded(seed = 13): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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

async function login(email: string): Promise<string> {
  const link = await data<{ token: string }>(await post('/v1/auth/magic-link', { email }))
  const session = await data<{ session_token: string }>(
    await post('/v1/auth/verify', { token: link.token }),
  )
  return session.session_token
}

async function joinWithCode(name: string, email: string): Promise<string> {
  const invite = await data<{ code: string }>(await call('POST', '/v1/invites'))
  const request = await data<{ id: string }>(
    await post('/v1/memberships/requests', { code: invite.code, name, email }),
  )
  const card = (
    (await server.txn.approvals.queue({
      workspace_id: ws(),
      person_id: owner(),
      lane: 'mine',
    })) as ApprovalItem[]
  ).find(
    (i) =>
      i.kind === 'membership' && (i.payload as { request_id?: string }).request_id === request.id,
  )
  if (card === undefined) throw new Error('没有申请卡')
  await call('POST', `/v1/approvals/${card.id}/decide`, { body: { action: 'approve' } })
  const person = server.identity.personByEmail(email)
  if (person === undefined) throw new Error('没建人')
  return person.id
}

async function giveB2b(person_id: string): Promise<string> {
  const granted = await data<{ assignment_id: string; role_id: string }[]>(
    await call('POST', '/v1/assignments', {
      body: { person_id, position_id: 'b2b', ranges: [{ kind: 'brand', id: ws() }] },
    }),
  )
  const sales = granted.find((a) => a.role_id === 'b2b.sales')
  if (sales === undefined) throw new Error('没分到 b2b.sales')
  return sales.assignment_id
}

describe('WP510 真服务进程', () => {
  afterEach(async () => {
    await server?.close()
  })
  const start = async (): Promise<void> => {
    let now = Date.parse(T0)
    server = await createServer({
      clock: { now: () => new Date(now++).toISOString() },
      random: seeded(),
      quiet: true,
      startRun: false,
      tokenRefreshIntervalMs: 0,
    })
  }

  it('① 个人：收件箱没有团队那一面，心跳回空，分工照实说是 ①', async () => {
    await start()
    const view = await data<InboxView>(await call('GET', '/v1/inbox?scope=all'))
    expect(view.team).toBeUndefined()
    const beat = await data<InboxPresenceView>(
      await call('POST', '/v1/inbox/presence', { body: { item: 'card:x' } }),
    )
    expect(beat.viewers).toEqual({})
    const team = await data<TeamInboxView>(await call('GET', '/v1/inbox/team'))
    expect(team.mode).toBe('solo')
    expect(team.can_edit).toBe(false)
    expect((await call('PUT', '/v1/inbox/team', { body: { away_days: 5 } })).status).toBe(409)
  })

  it('② 两个人：一人打开、另一人看到「在看」，离开就没了；同事处理的卡留名', async () => {
    await start()
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    const as = { token: linToken, assignment: linB2b }

    // 林峰打开一张，发起人那边看到「林峰在看」
    await call('POST', '/v1/inbox/presence', { ...as, body: { item: 'card:ap_demo' } })
    const seen = await data<InboxPresenceView>(
      await call('POST', '/v1/inbox/presence', { body: { item: null } }),
    )
    expect(seen.viewers['card:ap_demo']).toEqual([{ person_id: lin, name: '林峰' }])
    // 林峰自己那边不出自己
    const own = await data<InboxPresenceView>(
      await call('POST', '/v1/inbox/presence', { ...as, body: { item: 'card:ap_demo' } }),
    )
    expect(own.viewers['card:ap_demo']).toBeUndefined()
    // 离开就没了
    await call('POST', '/v1/inbox/presence', { ...as, body: { item: null } })
    const gone = await data<InboxPresenceView>(
      await call('POST', '/v1/inbox/presence', { body: { item: null } }),
    )
    expect(gone.viewers).toEqual({})

    // 分工：两个人都在，② 谁都能改
    const team = await data<TeamInboxView>(await call('GET', '/v1/inbox/team', as))
    expect(team.mode).toBe('peers')
    expect(team.can_edit).toBe(true)
    expect(team.members).toHaveLength(2)
    expect(team.members.find((m) => m.person_id === lin)).toMatchObject({
      name: '林峰',
      admin: false,
    })
    expect(team.members.find((m) => m.person_id === owner())?.admin).toBe(true)

    // 一张发给林峰的卡：林峰「不要了」→ 发起人的「刚处理」里写着林峰
    const card = await server.txn.approvals.create({
      workspace_id: ws(),
      schema_version: 1,
      kind: 'home_suggestion',
      role_id: 'b2b.sales',
      subject: { object: { type: 'thread', id: 'thr_wp510' } },
      dedupe_key: 'wp510:handled',
      title: '给 Lumen 发样品报价',
      summary: '要不要发',
      payload: {},
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'system', id: 'test' },
      automation: { level_at_creation: 'L1' } as never,
      routing: {
        recipients: [{ person: lin, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    const all = await data<InboxView>(await call('GET', '/v1/inbox?scope=all'))
    expect(all.team?.scope).toBe('all')
    const row = all.items.find((i) => i.card?.id === card.id)
    expect(row?.mine).toBe(false)
    expect(row?.owners).toEqual([{ person_id: lin, name: '林峰' }])
    const mine = await data<InboxView>(await call('GET', '/v1/inbox'))
    expect(mine.items.some((i) => i.card?.id === card.id)).toBe(false)

    const res = await call('POST', `/v1/approvals/${card.id}/decide`, {
      ...as,
      body: { action: 'reject', reason: '先不发' },
    })
    expect(res.status).toBe(200)
    const after = await data<InboxView>(await call('GET', '/v1/inbox'))
    expect(after.team?.handled[0]).toMatchObject({
      card_id: card.id,
      by: { person_id: lin, name: '林峰' },
      self: false,
      action: 'reject',
    })
  })
})
