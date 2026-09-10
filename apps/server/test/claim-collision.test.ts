/**
 * 认领与撞车端到端（40 §3，WP38）：真装配线（路由 → WorkPort → `@agentsws/work`），不打桩。
 *
 * 钉住的四条：
 * - 建之前先查：两个人建同一订单的待办，第二个人拿到 409 + 候选（看得见主人）
 * - `force` 不写区别 → 400；写了 → 建得成
 * - 认领即锁：第一个成功的是主人，第二个人 409 `already_claimed`
 * - 「看得见谁在做」这条路是真的：`GET /v1/work/in-progress` 回主人、开始时间、卡数
 */
import type { Assignment, Todo } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, HANDLERS, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 23): () => number {
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
/** 同事李默的那条分配（第二个人）。 */
let colleague: Assignment
let colleagueToken: string

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

interface Body {
  code?: string
  message?: string
  details?: { reason?: string; owner?: string; candidates?: { owner: string; title: string }[] }
  data?: unknown
}

const bodyOf = async (res: Response): Promise<Body> => (await res.json()) as Body

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = await bodyOf(res)
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

/** 邀请一位同事并让他登录，返回他的会话 token 与 person_id。 */
async function inviteColleague(email: string): Promise<{ token: string; person_id: string }> {
  const invitation = await dataOf<{ url: string }>(
    await call('POST', `/v1/workspaces/${server.bootstrap.workspace.id}/invitations`, {
      body: { email, name: '李默' },
    }),
  )
  const raw = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await dataOf<{ person_id: string }>(
    await server.gateway.fetch(
      new Request(`http://127.0.0.1/v1/invitations/${raw}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ),
  )
  const link = await dataOf<{ token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    ),
  )
  const session = await dataOf<{ session_token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: link.token }),
      }),
    ),
  )
  return { token: session.session_token, person_id: accepted.person_id }
}

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
  const invited = await inviteColleague('li@example.com')
  colleagueToken = invited.token
  colleague = server.roles.assignments.create({
    person_id: invited.person_id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.aftersales',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

const REFS = [{ type: 'order', id: 'ord_1001' }]

describe('建之前先查（40 §3.1）', () => {
  it('两个人建同一订单的待办 → 第二个人 409，并看得见主人', async () => {
    const first = await call('POST', '/v1/todos', {
      body: { title: '核对昨天的退款单', refs: REFS },
    })
    expect(first.status).toBe(201)

    const second = await call('POST', '/v1/todos', {
      body: { title: '把昨天的退款单核对一下', refs: REFS },
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(second.status).toBe(409)
    const err = await bodyOf(second)
    expect(err.code).toBe('conflict')
    expect(err.details?.reason).toBe('similar_in_progress')
    expect(err.details?.candidates?.[0]?.owner).toBe(server.bootstrap.person.id)
    expect(err.details?.candidates?.[0]?.title).toBe('核对昨天的退款单')
  })

  it('「我这个不一样」不写区别 → 400；写了 → 201', async () => {
    await call('POST', '/v1/todos', { body: { title: '核对昨天的退款单', refs: REFS } })
    const short = await call('POST', '/v1/todos', {
      body: {
        title: '把昨天的退款单核对一下',
        refs: REFS,
        collision: 'force',
        distinct_reason: '不同',
      },
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(short.status).toBe(400)
    expect((await bodyOf(short)).details?.reason).toBe('distinct_reason_required')

    const ok = await call('POST', '/v1/todos', {
      body: {
        title: '把昨天的退款单核对一下',
        refs: REFS,
        collision: 'force',
        distinct_reason: '我这条是另一家店的同号订单，不是同一件事',
      },
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(ok.status).toBe(201)
  })

  it('join：加进对方的事项，第二条待办挂到同一个事项上', async () => {
    const matter = server.work.createMatter({
      kind: 'conversation',
      title: 'Anna 的退款',
      participants: [server.bootstrap.person.id],
      pinned: [{ type: 'order', id: 'ord_1001' }],
    })
    server.work.createTodo({
      title: '核对昨天的退款单',
      owner: server.bootstrap.person.id,
      matter_id: matter.id,
    })
    const res = await call('POST', '/v1/todos', {
      body: { title: '把昨天的退款单核对一下', refs: REFS, collision: 'join' },
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(res.status).toBe(201)
    const { todo } = await dataOf<{ todo: Todo }>(res)
    expect(todo.matter_id).toBe(matter.id)
    expect(server.work.requireMatter(matter.id).context.participants).toHaveLength(2)
  })
})

describe('待认领池与认领即锁（40 §3.2）', () => {
  it('池里能看到，第一个认领的是主人，第二个人 409 already_claimed', async () => {
    const pooled = server.work.poolTodo({ title: '把上周的退款汇总一下', source: 'meeting' })

    const pool = await dataOf<{ pool: { todo_id: string; title: string }[] }>(
      await call('GET', '/v1/todos/pool'),
    )
    expect(pool.pool.map((p) => p.todo_id)).toContain(pooled.id)

    const mine = await call('POST', `/v1/todos/${pooled.id}/claim`, { body: {} })
    expect(mine.status).toBe(200)
    const { todo } = await dataOf<{ todo: Todo }>(mine)
    expect(todo.owner).toBe(server.bootstrap.person.id)

    const late = await call('POST', `/v1/todos/${pooled.id}/claim`, {
      body: {},
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(late.status).toBe(409)
    const err = await bodyOf(late)
    expect(err.details?.reason).toBe('already_claimed')
    expect(err.details?.owner).toBe(server.bootstrap.person.id)
  })

  it('转交：对方接下之前主人不变，接下之后才换人', async () => {
    const pooled = server.work.poolTodo({ title: '盘一下上月库存差异' })
    await call('POST', `/v1/todos/${pooled.id}/claim`, { body: {} })
    const invited = server.roles.assignments.get(colleague.id)
    if (invited === undefined) throw new Error('同事的分配不见了')

    const moved = await call('POST', `/v1/todos/${pooled.id}/transfer`, {
      body: { to: invited.person_id },
    })
    expect(moved.status).toBe(200)
    expect((await dataOf<{ todo: Todo }>(moved)).todo.owner).toBe(server.bootstrap.person.id)

    const taken = await call('POST', `/v1/todos/${pooled.id}/claim`, {
      body: {},
      token: colleagueToken,
      assignment: colleague.id,
    })
    expect(taken.status).toBe(200)
    expect((await dataOf<{ todo: Todo }>(taken)).todo.owner).toBe(invited.person_id)
  })

  it('加协作者', async () => {
    const { todo } = await dataOf<{ todo: Todo }>(
      await call('POST', '/v1/todos', { body: { title: '盘一下上月库存差异' } }),
    )
    const invited = server.roles.assignments.get(colleague.id)
    if (invited === undefined) throw new Error('同事的分配不见了')
    const res = await call('POST', `/v1/todos/${todo.id}/collaborators`, {
      body: { person_id: invited.person_id },
    })
    expect(res.status).toBe(200)
  })
})

describe('看得见谁在做（40 §3.3）', () => {
  it('本岗位与全工作区两个范围都回主人、开始时间、卡数', async () => {
    await call('POST', '/v1/todos', { body: { title: '核对昨天的退款单', refs: REFS } })
    const own = await dataOf<{
      items: { owner: string; owner_label: string; cards: number; started_at: string }[]
      scope: string
    }>(await call('GET', '/v1/work/in-progress'))
    expect(own.scope).toBe('position')
    expect(own.items[0]?.owner).toBe(server.bootstrap.person.id)
    expect(own.items[0]?.owner_label).not.toBe('')
    expect(own.items[0]?.cards).toBe(0)
    expect(Date.parse(own.items[0]?.started_at ?? '')).toBeGreaterThan(0)

    const all = await dataOf<{ items: unknown[]; scope: string }>(
      await call('GET', '/v1/work/in-progress?scope=workspace'),
    )
    expect(all.scope).toBe('workspace')
    expect(all.items.length).toBeGreaterThanOrEqual(1)
  })

  it('scope 只认 position / workspace', async () => {
    expect((await call('GET', '/v1/work/in-progress?scope=everything')).status).toBe(400)
  })
})

describe('闲置回收（40 §3.5）', () => {
  it('调度器上有一条每天 09:00 的巡检任务，处理器已登记', () => {
    const task = server.schedule.scheduler.get('sched_idle_todos')
    expect(task?.handler).toBe(HANDLERS.idleTodos)
    expect(task?.trigger).toMatchObject({ kind: 'cron', expr: '0 9 * * *' })
    expect(server.schedule.scheduler.handlers()).toContain(HANDLERS.idleTodos)
  })

  it('跑一次：没到点什么都不动', async () => {
    const pooled = server.work.poolTodo({ title: '盘一下上月库存差异' })
    server.work.claimTodo(pooled.id, server.bootstrap.person.id)
    const out = await server.schedule.scheduler.runNow('sched_idle_todos')
    expect(out.ok).toBe(true)
    expect(out.result).toMatchObject({ reminded: 0, recycled: 0 })
    expect(server.work.requireTodo(pooled.id).owner).toBe(server.bootstrap.person.id)
  })
})
