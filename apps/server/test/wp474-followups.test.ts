/**
 * WP474：服务端端到端——
 * - 「本周」= 周一到周日（决策 1531）：周四记的没日子的「本周」待办，下周一读出来还在本周、标「上周没做完」；
 * - 「我的作息」（决策 1530）：默认值、改了以后「帮我排进空档」照它排（周末、上班时间）；存在品牌目录、重开还在。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WORK_HOURS,
  type Todo,
  type TodoSlotResult,
  type WorkHours,
} from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createWorkHoursStore } from '../src/work-hours.js'

const SECRETS_KEY = 'e'.repeat(64)
/** 北京时间 2026-10-<day> hh:mm（10-22 周四、10-24 周六、10-26 周一） */
const bj = (day: number, hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 9, day, hh - 8, mm)).toISOString()

function seeded(seed = 474): () => number {
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
let now = bj(22, 10)

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

beforeEach(async () => {
  now = bj(22, 10)
  server = await createServer({
    quiet: true,
    clock: { now: () => now },
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

describe('WP474 本周 = 周一到周日（服务端）', () => {
  it('周四记的「本周」：周日还在本周；下周一挪进新的本周、标上周没做完', async () => {
    const made = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '回 Leo 的合作邮件',
      horizon: 'week',
    })
    expect(made.status).toBe(201)
    const id = made.data?.todo.id as string
    const list = async (): Promise<Todo | undefined> =>
      (await call<{ todos: Todo[] }>('GET', '/v1/todos?status=open')).data?.todos.find(
        (t) => t.id === id,
      )
    now = bj(25, 23, 59)
    expect(await list()).toMatchObject({ horizon: 'week' })
    expect((await list())?.carried_over).toBeUndefined()
    now = bj(26, 0)
    expect(await list()).toMatchObject({ horizon: 'week', carried_over: true })
  })

  it('周四带了下周二截止的：读出来在「以后」，到了那一周的周一进本周', async () => {
    const made = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '寄样',
      due: bj(27, 12),
    })
    const id = made.data?.todo.id as string
    expect(made.data?.todo.horizon).toBe('backlog')
    now = bj(26, 9)
    const week = await call<{ todos: Todo[] }>('GET', '/v1/todos?horizon=week')
    expect(week.data?.todos.map((t) => t.id)).toContain(id)
  })
})

describe('WP474 我的作息（服务端）', () => {
  it('默认值；改成排周末、10 点上班后，「帮我排进空档」排到周六 10:00', async () => {
    const first = await call<WorkHours>('GET', '/v1/settings/work-hours')
    expect(first.data).toEqual(DEFAULT_WORK_HOURS)
    const todo = await call<{ todo: Todo }>('POST', '/v1/todos', {
      title: '给工厂确认备货量',
      horizon: 'week',
    })
    const id = todo.data?.todo.id as string
    const weekend = { from: bj(24, 0), to: bj(26, 0), tz_offset_minutes: 480 }
    const before = await call<TodoSlotResult>('POST', '/v1/todos/slots', {
      todo_ids: [id],
      ...weekend,
    })
    expect(before.data?.unplaced).toEqual([id])

    const saved = await call<WorkHours>('PUT', '/v1/settings/work-hours', {
      ...DEFAULT_WORK_HOURS,
      start_min: 600,
      weekends: true,
    })
    expect(saved.status).toBe(200)
    expect((await call<WorkHours>('GET', '/v1/settings/work-hours')).data?.weekends).toBe(true)
    const after = await call<TodoSlotResult>('POST', '/v1/todos/slots', {
      todo_ids: [id],
      ...weekend,
    })
    expect(after.data?.proposals[0]?.options[0]?.start).toBe(bj(24, 10))
  })

  it('存在文件里：每人一份，重开还在；文件坏了回默认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp474-hours-'))
    try {
      const file = join(dir, 'work-hours.json')
      const a = createWorkHoursStore(file)
      a.set('per_a', { ...DEFAULT_WORK_HOURS, avoid_lunch: true })
      const b = createWorkHoursStore(file)
      expect(b.get('per_a').avoid_lunch).toBe(true)
      expect(b.get('per_b')).toEqual(DEFAULT_WORK_HOURS)
      writeFileSync(file, '{坏了', 'utf8')
      expect(createWorkHoursStore(file).get('per_a')).toEqual(DEFAULT_WORK_HOURS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
