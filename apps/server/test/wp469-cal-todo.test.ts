/**
 * WP469（决策 1521 / 1522 / 1524）：日历与待办——服务端端到端。
 *
 * - 「帮我排进空档」只给候选：返回的那几个空档避开了已经排了钟点的待办，调完待办一个字没变；
 * - 收件箱「记成待办」：同一行记两次只有一条；记下的带着从哪一行来的；
 * - 做完的待办 `?done=true` 才上日历。
 */
import type { CalendarItem, Todo, TodoSlotResult } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

/** 2026-09-16 周三 北京 09:00 */
const T0 = '2026-09-16T01:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

function seeded(seed = 469): () => number {
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

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
}

const bj = (day: number, hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 8, day, hh - 8, mm)).toISOString()

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP469 帮我排进空档（服务端）', () => {
  it('避开已经排了钟点的待办；只给候选，待办不变', async () => {
    const busy = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '供应商对账',
      scheduled: { start: bj(16, 9, 30), end: bj(16, 11) },
    })
    expect(busy.status).toBe(201)
    const free = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '给工厂确认备货量',
      horizon: 'week',
    })
    const id = free.data?.todo.id as string
    expect(free.data?.todo.horizon).toBe('week')

    const res = await call<TodoSlotResult>('POST', '/v1/todos/slots', {
      todo_ids: [id],
      from: bj(14, 0),
      to: bj(21, 0),
      tz_offset_minutes: 480,
    })
    expect(res.status).toBe(200)
    const first = res.data?.proposals[0]?.options[0]
    // 9:00–10:00 撞 9:30 的对账；10:00 也撞；11:00 是第一个空档
    expect(first).toEqual({ start: bj(16, 11), end: bj(16, 12) })

    const after = await call<{ todos: Todo[] }>('GET', '/v1/todos?status=open')
    const same = after.data?.todos.find((t) => t.id === id)
    expect(same?.scheduled).toBeUndefined()
    expect(same?.horizon).toBe('week')
  })
})

describe('WP469 收件箱「记成待办」（服务端）', () => {
  it('同一行记两次只有一条；带着从哪一行来的', async () => {
    const one = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '补营业执照',
      horizon: 'week',
      from_inbox: 'card:ap_1',
      collision: 'force',
      distinct_reason: '从收件箱记下',
    })
    expect(one.status).toBe(201)
    expect(one.data?.todo.origin).toEqual({ inbox_item: 'card:ap_1', card_id: 'ap_1' })
    expect(one.data?.todo.source).toBe('card')
    const two = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '补营业执照',
      horizon: 'week',
      from_inbox: 'card:ap_1',
      collision: 'force',
      distinct_reason: '从收件箱记下',
    })
    expect(two.data?.todo.id).toBe(one.data?.todo.id)
  })
})

describe('WP469 做完的待办上日历（服务端）', () => {
  it('?done=true 才给，状态 done', async () => {
    const made = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '核对退款单',
      due: bj(16, 12),
    })
    const id = made.data?.todo.id as string
    await call('POST', `/v1/todos/${id}/done`)
    const window = `from=${bj(14, 0)}&to=${bj(21, 0)}`
    const plain = await call<{ items: CalendarItem[] }>('GET', `/v1/calendar?${window}`)
    expect(plain.data?.items.filter((i) => i.source === 'todo')).toHaveLength(0)
    const withDone = await call<{ items: CalendarItem[] }>(
      'GET',
      `/v1/calendar?${window}&done=true`,
    )
    const done = withDone.data?.items.find((i) => i.ref.id === id)
    expect(done).toMatchObject({ status: 'done', drag: 'readonly', all_day: true })
  })
})
