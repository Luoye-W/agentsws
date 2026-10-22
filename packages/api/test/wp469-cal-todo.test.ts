/**
 * WP469（决策 1521–1527）：日历与待办合成一页——网关这一侧只加不改的几处：
 * - `POST /v1/todos/slots`「帮我排进空档」（只给候选；端口没有就 501）；
 * - `GET /v1/calendar?done=true` 做完的待办也要（不传 = 老样子）；
 * - `PUT /v1/todos/:id` 能一次换档（`scheduled` / `due` / `horizon` 一起改）；
 * - `POST /v1/todos` 认 `scheduled`（带钟点的一建就排上）和 `from_inbox`（收件箱「记成待办」）。
 */
import type { CalendarItem, Todo, TodoSlotResult } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { GatewayDeps, WorkActor, WorkPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness, T0 } from './helpers.js'

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  title: '写新品页文案',
  owner: 'per_me',
  horizon: 'week',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: T0,
  updated_at: T0,
  ...over,
})

const SLOTS: TodoSlotResult = {
  proposals: [
    {
      todo_id: 'td_1',
      title: '写新品页文案',
      minutes: 120,
      options: [{ start: '2026-09-09T05:30:00.000Z', end: '2026-09-09T07:30:00.000Z' }],
    },
  ],
  unplaced: [],
}

function fakePort(withSlots: boolean): { port: WorkPort; calls: Map<string, unknown[]> } {
  const calls = new Map<string, unknown[]>()
  const port = {
    createTodo(_a: WorkActor, input: unknown): Todo {
      calls.set('createTodo', [input])
      return todo({ id: 'td_new' })
    },
    updateTodo(_a: WorkActor, id: string, patch: unknown): Todo {
      calls.set('updateTodo', [id, patch])
      return todo({ id })
    },
    calendar(_a: WorkActor, range: unknown): CalendarItem[] {
      calls.set('calendar', [range])
      return []
    },
    ...(withSlots
      ? {
          proposeSlots(_a: WorkActor, input: unknown): TodoSlotResult {
            calls.set('proposeSlots', [input])
            return SLOTS
          },
        }
      : {}),
  } as unknown as WorkPort
  return { port, calls }
}

async function setup(withSlots = true) {
  const h = await harness()
  const { port, calls } = fakePort(withSlots)
  const deps: GatewayDeps = { ...h.deps, work: port }
  const gateway = createGateway(deps)
  const call = (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  return { call, calls }
}

const WINDOW = { from: '2026-09-06T16:00:00.000Z', to: '2026-09-13T16:00:00.000Z' }

describe('WP469 帮我排进空档', () => {
  it('给候选，原样递到端口；什么都不写', async () => {
    const { call, calls } = await setup()
    const res = await call('POST', '/v1/todos/slots', {
      todo_ids: ['td_1'],
      ...WINDOW,
      tz_offset_minutes: 480,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: TodoSlotResult }
    expect(body.data).toEqual(SLOTS)
    expect(calls.get('proposeSlots')?.[0]).toEqual({
      todo_ids: ['td_1'],
      ...WINDOW,
      tz_offset_minutes: 480,
    })
    expect(calls.has('updateTodo')).toBe(false)
  })

  it('时间不对、空清单是 400；端口没有这件事是 501', async () => {
    const { call } = await setup()
    expect((await call('POST', '/v1/todos/slots', { todo_ids: [], ...WINDOW })).status).toBe(400)
    expect(
      (await call('POST', '/v1/todos/slots', { todo_ids: ['td_1'], from: 'x', to: 'y' })).status,
    ).toBe(400)
    expect(
      (
        await call('POST', '/v1/todos/slots', {
          todo_ids: ['td_1'],
          from: WINDOW.to,
          to: WINDOW.from,
        })
      ).status,
    ).toBe(400)
    const bare = await setup(false)
    const res = await bare.call('POST', '/v1/todos/slots', { todo_ids: ['td_1'], ...WINDOW })
    expect(res.status).toBe(501)
  })
})

describe('WP469 日历要做完的', () => {
  it('done=true 才带 include_done；不传和以前一样', async () => {
    const { call, calls } = await setup()
    await call('GET', `/v1/calendar?from=${WINDOW.from}&to=${WINDOW.to}`)
    expect(calls.get('calendar')?.[0]).not.toHaveProperty('include_done')
    await call('GET', `/v1/calendar?from=${WINDOW.from}&to=${WINDOW.to}&done=true`)
    expect(calls.get('calendar')?.[0]).toMatchObject({ include_done: true })
  })
})

describe('WP469 换档与记成待办', () => {
  it('PUT 一次换档：拖回「还没排期的」', async () => {
    const { call, calls } = await setup()
    const res = await call('PUT', '/v1/todos/td_1', {
      scheduled: null,
      due: null,
      horizon: 'week',
    })
    expect(res.status).toBe(200)
    expect(calls.get('updateTodo')?.[1]).toEqual({ scheduled: null, due: null, horizon: 'week' })
    const timed = await call('PUT', '/v1/todos/td_1', {
      scheduled: { start: T0, end: '2026-09-07T10:00:00.000Z' },
    })
    expect(timed.status).toBe(200)
  })

  it('POST 认 scheduled 与 from_inbox', async () => {
    const { call, calls } = await setup()
    const res = await call('POST', '/v1/todos', {
      title: '补营业执照',
      horizon: 'week',
      from_inbox: 'mail:thr_1',
    })
    expect(res.status).toBe(201)
    expect(calls.get('createTodo')?.[0]).toMatchObject({ from_inbox: 'mail:thr_1' })
    const timed = await call('POST', '/v1/todos', {
      title: '拍样品',
      scheduled: { start: T0, end: '2026-09-07T10:00:00.000Z' },
    })
    expect(timed.status).toBe(201)
  })
})
