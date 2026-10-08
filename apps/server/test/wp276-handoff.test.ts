/**
 * WP276（docs/95 §4.3，决策 241 / 242）：② 同事互联的**交给对方**——真服务进程。
 *
 * 钉住的：
 * 1. 接下：对方收一张卡（名字不是 id，带留言）；点「接下」后主人、分配换成接手人，之后的运行用
 *    接手人那条分配（发起人在里面说一句也一样）；发起人在这件事上的未定卡跟着走，已经点开改了
 *    一半的留给发起人；发起人那边一行通知；
 * 2. 不接：退回发起人带理由，主人不变；
 * 3. 撤回：对方那张卡一起收掉；
 * 4. 超时：3 天没人理自动退回，卡也收掉；
 * 5. 待办：转交 = 交给对方（同一张卡），接下换主人；撞车「交给他」也出卡；
 * 6. 只能交给这个品牌里的同事。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-08T02:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000

function seeded(seed = 7): () => number {
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
let runs: { person_id: string; assignment_id: string }[] = []

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

async function colleague(email: string, name: string): Promise<{ token: string; id: string }> {
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
  return { token: session.session_token, id: accepted.person_id }
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

/** 一张挂在事项上、等发起人定的卡（模拟 AI 起草的一封回信）。 */
async function cardOn(matter_id: string, title: string): Promise<ApprovalItem> {
  return (await server.txn.approvals.create({
    workspace_id: ws(),
    schema_version: 1,
    kind: 'ai_question',
    role_id: 'b2b.sales',
    subject: {
      object: { type: 'customer', id: 'acc_volthaus' },
      matter_id,
      work_item_id: matter_id,
    },
    dedupe_key: `${ws()}:t:${title}`,
    title,
    summary: title,
    payload: { question: title },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'b2b' },
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: owner(), via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
  })) as ApprovalItem
}

const queueOf = async (person_id: string): Promise<ApprovalItem[]> =>
  (await server.txn.approvals.queue({
    workspace_id: ws(),
    person_id,
    lane: 'mine',
  })) as ApprovalItem[]

const handoffCard = async (person_id: string): Promise<ApprovalItem | undefined> =>
  (await queueOf(person_id)).find(
    (i) => i.kind === 'claim' && (i.payload as { form?: string }).form === 'handoff',
  )

let lin: { token: string; id: string }
let mine = ''
let linB2b = ''

beforeEach(async () => {
  now = Date.parse(T0)
  runs = []
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: seeded(),
    quiet: true,
    startRun: ({ actor }) => {
      runs.push({ person_id: actor.person_id, assignment_id: actor.assignment_id })
      return { run_id: `run_${runs.length}` }
    },
    tokenRefreshIntervalMs: 0,
  })
  lin = await colleague('lin@example.com', '林峰')
  mine = await giveB2b(owner())
  linB2b = await giveB2b(lin.id)
  expect(await server.organizations.modeOf(ws())).toBe('peers')
})

afterEach(async () => {
  await server.close()
})

async function openMatter(title: string): Promise<string> {
  const made = await data<{ matter: { id: string } }>(
    await call('POST', '/v1/matters', { assignment: mine, body: { kind: 'project', title } }),
  )
  return made.matter.id
}

describe('WP276 交给对方（真服务进程）', () => {
  it('接下：卡写名字不写 id；主人与分配换成接手人；未定的卡跟过去、改了一半的留下；之后的运行用接手人的', async () => {
    const id = await openMatter('Volthaus 的报价')
    await call('POST', '/v1/todos', {
      assignment: mine,
      body: { title: '周五前回 Volthaus', matter_id: id, due: '2026-10-10T10:00:00.000Z' },
    })
    const follow = await cardOn(id, '回 Volthaus 的询价')
    const half = await cardOn(id, '寄样确认')
    await server.txn.approvals.claim(half.id, owner()) // 发起人已经点开在改

    const offered = await data<{ handoff: { handoff: { state: string }; to_label: string } }>(
      await call('POST', `/v1/handoffs/matter/${id}`, {
        assignment: mine,
        body: { to: lin.id, note: '我这周出差，你熟这个客户' },
      }),
    )
    expect(offered.handoff.handoff.state).toBe('offered')
    expect(offered.handoff.to_label).toBe('林峰')
    // 等接的时候不接新活
    const blocked = await call('POST', `/v1/matters/${id}/messages`, {
      assignment: mine,
      body: { text: '再催一下' },
    })
    expect(blocked.status).toBe(409)

    const card = await handoffCard(lin.id)
    expect(card).toBeDefined()
    expect(card?.title).toContain('想把「Volthaus 的报价」交给你')
    expect(card?.title).not.toContain(owner())
    expect(card?.summary).toBe('我这周出差，你熟这个客户')
    const p = card?.payload as { options: { id: string; label: string }[]; due?: string }
    expect(p.options).toEqual([{ id: linB2b, label: '接下' }])
    expect(p.due).toBe('2026-10-10T10:00:00.000Z')
    const lists = await data<{ to_me: { id: string }[] }>(
      await call('GET', '/v1/handoffs', { token: lin.token, assignment: linB2b }),
    )
    expect(lists.to_me.map((x) => x.id)).toEqual([id])

    const decided = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'approve', selected_option_id: linB2b },
    })
    expect(decided.status).toBe(200)

    const view = await data<{
      matter: {
        position_id: string
        context: { participants: string[] }
        handoff: { state: string }
      }
      timeline: { text: string }[]
    }>(await call('GET', `/v1/matters/${id}`, { token: lin.token, assignment: linB2b }))
    expect(view.matter.handoff.state).toBe('accepted')
    expect(view.matter.position_id).toBe(linB2b)
    expect(view.matter.context.participants).toEqual([lin.id, owner()])
    expect(view.timeline.map((e) => e.text)).toContain('林峰 接下了')
    // 未定的卡：没点开的跟过去，点开改了一半的留给发起人
    expect(
      (await server.txn.approvals.get(follow.id))?.routing.recipients.map((r) => r.person),
    ).toEqual([lin.id])
    expect(
      (await server.txn.approvals.get(half.id))?.routing.recipients.map((r) => r.person),
    ).toEqual([owner()])
    // 待办跟着走
    const todos = await data<{ todos: { owner: string }[] }>(
      await call('GET', `/v1/todos?matter_id=${id}&mine=false`, {
        token: lin.token,
        assignment: linB2b,
      }),
    )
    expect(todos.todos.map((t) => t.owner)).toEqual([lin.id])
    // 之后的运行用接手人那条分配：接手人说一句、发起人（现在是参与者）说一句，都是
    runs = []
    await call('POST', `/v1/matters/${id}/messages`, {
      token: lin.token,
      assignment: linB2b,
      body: { text: '我接着跟' },
    })
    await call('POST', `/v1/matters/${id}/messages`, {
      assignment: mine,
      body: { text: '补一句背景' },
    })
    expect(runs).toEqual([
      { person_id: lin.id, assignment_id: linB2b },
      { person_id: lin.id, assignment_id: linB2b },
    ])
    // 发起人那边一行通知，点掉就没了
    const fromMe = await data<{ from_me: { handoff: { state: string } }[] }>(
      await call('GET', '/v1/handoffs', { assignment: mine }),
    )
    expect(fromMe.from_me.map((x) => x.handoff.state)).toEqual(['accepted'])
    await call('POST', `/v1/handoffs/matter/${id}/seen`, { assignment: mine })
    const after = await data<{ from_me: unknown[] }>(
      await call('GET', '/v1/handoffs', { assignment: mine }),
    )
    expect(after.from_me).toEqual([])
  })

  it('不接：退回发起人带理由，主人不变；没写理由也行', async () => {
    const id = await openMatter('展会样品')
    await call('POST', `/v1/handoffs/matter/${id}`, { assignment: mine, body: { to: lin.id } })
    const card = await handoffCard(lin.id)
    const res = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'reject', reason: '太忙' },
    })
    expect(res.status).toBe(200)
    const view = await data<{
      matter: { context: { participants: string[] }; handoff: { state: string; reason?: string } }
    }>(await call('GET', `/v1/matters/${id}`, { assignment: mine }))
    expect(view.matter.handoff).toMatchObject({ state: 'declined', reason: '太忙' })
    expect(view.matter.context.participants).toEqual([owner()])

    // 再交一次，这次不写理由直接不接
    await call('POST', `/v1/handoffs/matter/${id}`, { assignment: mine, body: { to: lin.id } })
    const again = await handoffCard(lin.id)
    const res2 = await call('POST', `/v1/approvals/${again?.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'reject' },
    })
    expect(res2.status).toBe(200)
    const v2 = await data<{ matter: { handoff: { state: string; reason?: string } } }>(
      await call('GET', `/v1/matters/${id}`, { assignment: mine }),
    )
    expect(v2.matter.handoff.state).toBe('declined')
    expect(v2.matter.handoff.reason).toBeUndefined()
  })

  it('撤回：对方那张卡一起收掉；超时：3 天没人理自动退回、卡也收掉', async () => {
    const a = await openMatter('A 客户')
    await call('POST', `/v1/handoffs/matter/${a}`, { assignment: mine, body: { to: lin.id } })
    const cardA = await handoffCard(lin.id)
    const w = await call('POST', `/v1/handoffs/matter/${a}/withdraw`, { assignment: mine })
    expect(w.status).toBe(200)
    expect((await server.txn.approvals.get(cardA?.id ?? ''))?.state).toBe('withdrawn')
    // 对方不能替发起人撤
    const b = await openMatter('B 客户')
    await call('POST', `/v1/handoffs/matter/${b}`, { assignment: mine, body: { to: lin.id } })
    const forbidden = await call('POST', `/v1/handoffs/matter/${b}/withdraw`, {
      token: lin.token,
      assignment: linB2b,
    })
    expect(forbidden.status).toBe(403)
    const cardB = await handoffCard(lin.id)
    now += 3 * DAY + 1000
    const lists = await data<{ from_me: { id: string; handoff: { state: string } }[] }>(
      await call('GET', '/v1/handoffs', { assignment: mine }),
    )
    expect(lists.from_me.find((x) => x.id === b)?.handoff.state).toBe('returned')
    expect(['withdrawn', 'expired']).toContain(
      (await server.txn.approvals.get(cardB?.id ?? ''))?.state,
    )
  })

  it('待办：转交走同一张卡，接下换主人；只能交给品牌里的同事', async () => {
    const todo = await data<{ todo: { id: string } }>(
      await call('POST', '/v1/todos', { assignment: mine, body: { title: '核对样品单' } }),
    )
    const res = await call('POST', `/v1/todos/${todo.todo.id}/transfer`, {
      assignment: mine,
      body: { to: lin.id },
    })
    expect(res.status).toBe(200)
    const card = await handoffCard(lin.id)
    expect(card?.title).toContain('想把「核对样品单」交给你')
    // 已经出了卡的转交不再挂进「待认领」（同一件事不说两遍）
    const pool = await data<{ pool: unknown[] }>(
      await call('GET', '/v1/todos/pool', { token: lin.token, assignment: linB2b }),
    )
    expect(pool.pool).toEqual([])
    await call('POST', `/v1/approvals/${card?.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'approve', selected_option_id: linB2b },
    })
    const mineNow = await data<{ todos: { id: string; owner: string; position_id?: string }[] }>(
      await call('GET', '/v1/todos', { token: lin.token, assignment: linB2b }),
    )
    expect(mineNow.todos.find((t) => t.id === todo.todo.id)).toMatchObject({
      owner: lin.id,
      position_id: linB2b,
    })

    const stranger = await call('POST', `/v1/handoffs/matter/${await openMatter('C')}`, {
      assignment: mine,
      body: { to: 'p_nobody' },
    })
    expect(stranger.status).toBe(400)
  })

  it('同事名单带忙闲、不含自己', async () => {
    await openMatter('手上一件')
    const out = await data<{ colleagues: { person_id: string; name: string; load: string }[] }>(
      await call('GET', '/v1/work/colleagues', { token: lin.token, assignment: linB2b }),
    )
    expect(out.colleagues.map((c) => c.person_id)).toEqual([owner()])
    expect(out.colleagues[0]?.load).toBe('手上 1 件')
  })
})
