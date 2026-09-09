/**
 * 25 的装配：七个消费者各一条，跑的是**服务进程真装配出来的那条调度线**
 * （`createServer` → `createScheduleAssembly` → 七个 `register`），不是另拼一套。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryIdempotencyStore } from '@agentsws/api'
import type { ApprovalItem, MeetingRecordSource } from '@agentsws/contracts'
import { createScheduler } from '@agentsws/schedule'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createServer,
  HANDLERS,
  isMonthEnd,
  nextMorningAt,
  nextTokenCheck,
  offsetToTz,
  registerIdempotencySweep,
  type Server,
  TOKEN_IDLE_INTERVAL_MS,
  TOKEN_REFRESH_LEAD_MS,
} from '../src/index.js'

/** 东八区 2026-09-10（周四）早上 08:00 = UTC 00:00。 */
const T0 = '2026-09-10T00:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
    set: (at: string) => {
      t = Date.parse(at)
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let clock: ReturnType<typeof makeClock>
let server: Server

const start = async (over: Parameters<typeof createServer>[0] = {}): Promise<Server> => {
  clock = makeClock()
  const s = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    // 测试自己驱动 runDue：不留后台计时器
    scheduleIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    ...over,
  })
  return s
}

const cardsOf = async (kind: string): Promise<ApprovalItem[]> =>
  (
    (await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
      state: ['pending', 'in_review', 'approved', 'applied'],
    })) as ApprovalItem[]
  ).filter((i) => i.kind === kind)

describe('七个消费者', () => {
  beforeEach(async () => {
    server = await start()
  })

  afterEach(async () => {
    await server.close()
  })

  it('装配之后七条系统任务都在，各自登记了处理器', () => {
    const tasks = server.schedule.scheduler.list({ workspace_id: server.bootstrap.workspace.id })
    const handlers = new Set(tasks.map((t) => t.handler))
    expect(handlers).toContain(HANDLERS.dailyPlan)
    expect(handlers).toContain(HANDLERS.review)
    expect(handlers).toContain(HANDLERS.meetingsPoll)
    expect(handlers).toContain(HANDLERS.shopifyRefresh)
    expect(handlers).toContain(HANDLERS.skillsWeekly)
    // 每条都有人接（没登记的处理器会在触发时回 not_implemented）
    const registered = new Set(server.schedule.scheduler.handlers())
    for (const t of tasks) expect(registered.has(String(t.handler))).toBe(true)
  })

  it('① 每日计划：08:00 触发 → 一张 daily_plan 卡', async () => {
    const asg = server.bootstrap.ownerAssignment.id
    const task = server.schedule.scheduler.get(`sched_daily_plan_${asg}`)
    expect(task?.trigger).toMatchObject({ kind: 'cron', expr: '0 8 * * *' })
    const out = await server.schedule.scheduler.runNow(`sched_daily_plan_${asg}`)
    expect(out.ok).toBe(true)
    const cards = await cardsOf('daily_plan')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.payload).toHaveProperty('suggestions')
    // 一天一条：再跑一次不重复出卡
    await server.schedule.scheduler.runNow(`sched_daily_plan_${asg}`)
    expect(await cardsOf('daily_plan')).toHaveLength(1)
  })

  it('② 复盘：20:00 触发 → 一张 review 卡；周五 / 月末各有一条长周期版本', async () => {
    const asg = server.bootstrap.ownerAssignment.id
    expect(server.schedule.scheduler.get(`sched_review_day_${asg}`)?.trigger).toMatchObject({
      expr: '0 20 * * *',
    })
    expect(server.schedule.scheduler.get(`sched_review_week_${asg}`)?.trigger).toMatchObject({
      expr: '30 20 * * 5',
    })
    expect(server.schedule.scheduler.get(`sched_review_month_${asg}`)?.trigger).toMatchObject({
      expr: '45 20 28-31 * *',
    })
    const out = await server.schedule.scheduler.runNow(`sched_review_day_${asg}`)
    expect(out.ok).toBe(true)
    const cards = await cardsOf('review')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.payload).toHaveProperty('next_plan_draft')
  })

  it('② 月复盘不到月末就跳过（cron 没有「月末」）', async () => {
    const asg = server.bootstrap.ownerAssignment.id
    const out = await server.schedule.scheduler.runNow(`sched_review_month_${asg}`)
    expect(out.result).toEqual({ skipped: 'not_month_end' })
    expect(await cardsOf('review')).toHaveLength(0)
  })

  it('⑦ 复盘跑完 → 注册一个次日早上的 at 任务（计划草案接力）', async () => {
    const asg = server.bootstrap.ownerAssignment.id
    await server.schedule.scheduler.runNow(`sched_review_day_${asg}`)
    const relay = server.schedule.scheduler
      .list({ workspace_id: server.bootstrap.workspace.id })
      .filter((t) => t.handler === HANDLERS.planFromReview)
    expect(relay).toHaveLength(1)
    expect(relay[0]?.trigger.kind).toBe('once')
    // 明早 07:55（东八区）= UTC 前一天 23:55
    expect(relay[0]?.next_fire_at).toBe('2026-09-10T23:55:00.000Z')

    // 到点跑一次：把复盘产物接成草案
    clock.set('2026-09-10T23:55:00.000Z')
    const out = await server.schedule.scheduler.runDue(clock.now())
    const fired = out.find((o) => o.task.handler === HANDLERS.planFromReview)
    expect(fired?.ok).toBe(true)
    expect(fired?.result).toMatchObject({ suggestions: expect.any(Number) })
  })

  it('③ 会议记录源：每 15 分钟拉一次，只拉 poll 档的来源', async () => {
    const task = server.schedule.scheduler.get('sched_meetings_poll')
    expect(task?.trigger).toEqual({ kind: 'interval', every_ms: 15 * 60_000 })
    // 默认六个来源都是 manual / device_sync（实时入会是付费增强），所以拉到零个
    const before = await server.schedule.scheduler.runNow('sched_meetings_poll')
    expect(before.result).toMatchObject({ polled: 0, drafts: 0 })

    // 装一个 poll 档的来源（付费应用就是这么顶上来的），不改一行装配就开始工作
    let polled = 0
    const source: MeetingRecordSource = {
      id: 'test/poller',
      kind: 'online_meeting',
      mode: 'poll',
      poll: () => {
        polled += 1
        return []
      },
    }
    server.meetings.pipeline.sources.register(source)
    const after = await server.schedule.scheduler.runNow('sched_meetings_poll')
    expect(polled).toBe(1)
    expect(after.result).toMatchObject({ polled: 1 })
  })

  it('③ 一个来源拉不动不拖垮别的来源', async () => {
    server.meetings.pipeline.sources.register({
      id: 'test/broken',
      kind: 'online_meeting',
      mode: 'poll',
      poll: () => {
        throw new Error('平台挂了')
      },
    })
    server.meetings.pipeline.sources.register({
      id: 'test/ok',
      kind: 'third_party',
      mode: 'poll',
      poll: () => [],
    })
    const out = await server.schedule.scheduler.runNow('sched_meetings_poll')
    expect(out.ok).toBe(true)
    expect(out.result).toMatchObject({ polled: 2, failed: ['test/broken'] })
  })

  it('⑤ Shopify 令牌：跑完把下一次排到「到期前一小时」', async () => {
    const task = server.schedule.scheduler.get('sched_shopify_refresh')
    expect(task?.trigger).toEqual({ kind: 'interval', every_ms: TOKEN_IDLE_INTERVAL_MS })
    const out = await server.schedule.scheduler.runNow('sched_shopify_refresh')
    expect(out.ok).toBe(true)
    // 一条连接都没有：一小时后再看一眼
    expect(out.task.next_fire_at).toBe(
      new Date(Date.parse(T0) + TOKEN_IDLE_INTERVAL_MS).toISOString(),
    )
  })

  it('⑥ 技能周合并：周一 06:00', async () => {
    const task = server.schedule.scheduler.get('sched_skills_weekly')
    expect(task?.trigger).toMatchObject({ kind: 'cron', expr: '0 6 * * 1' })
    const out = await server.schedule.scheduler.runNow('sched_skills_weekly')
    expect(out.ok).toBe(true)
    expect(out.result).toEqual({ proposals: 0 })
  })

  it('一个消费者炸了不影响别的（同一拍里两条都到点）', async () => {
    const s = server.schedule.scheduler
    s.register('会炸的', () => {
      throw new Error('炸了')
    })
    await s.schedule({
      workspace_id: server.bootstrap.workspace.id,
      owner: server.bootstrap.person.id,
      role_id: server.bootstrap.ownerAssignment.role_id,
      assignment_id: server.bootstrap.ownerAssignment.id,
      handler: '会炸的',
      trigger: { kind: 'once', at: clock.now() },
      created_by: 'user',
      misfire_policy: 'skip',
    })
    await s.schedule({
      workspace_id: server.bootstrap.workspace.id,
      owner: server.bootstrap.person.id,
      role_id: server.bootstrap.ownerAssignment.role_id,
      assignment_id: server.bootstrap.ownerAssignment.id,
      handler: HANDLERS.skillsWeekly,
      trigger: { kind: 'once', at: clock.now() },
      created_by: 'user',
      misfire_policy: 'skip',
    })
    const out = await s.runDue(clock.now())
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    expect(out.filter((o) => !o.ok)).toHaveLength(1)
  })

  it('触发写事件：schedule.fired 进同一条事件日志', async () => {
    const asg = server.bootstrap.ownerAssignment.id
    await server.schedule.scheduler.runNow(`sched_skills_weekly`)
    const types: string[] = []
    for await (const e of server.kernel.eventLog.read({
      workspace_id: server.bootstrap.workspace.id,
      types: ['schedule.created', 'schedule.fired'],
    })) {
      types.push(e.type)
    }
    expect(types).toContain('schedule.created')
    expect(types).toContain('schedule.fired')
    expect(asg).toBeTruthy()
  })
})

describe('④ 幂等表清理', () => {
  it('每小时扫一次过期记录', async () => {
    const c = makeClock()
    const store = new MemoryIdempotencyStore(1000)
    store.put('scope', 'k1', {
      fingerprint: 'f',
      status: 200,
      body: '{}',
      content_type: 'application/json',
      stored_at: Date.parse(T0),
    })
    const scheduler = createScheduler({ clock: c })
    registerIdempotencySweep(scheduler, { clock: c, store })
    await scheduler.schedule({
      workspace_id: 'ws',
      owner: 'p',
      role_id: 'r',
      assignment_id: 'a',
      handler: HANDLERS.idempotencySweep,
      trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      created_by: 'user',
      misfire_policy: 'skip',
    })
    expect(store.size).toBe(1)
    c.set('2026-09-10T01:00:00.000Z')
    const [out] = await scheduler.runDue(c.now())
    expect(out?.result).toEqual({ removed: 1 })
    expect(store.size).toBe(0)
  })

  it('落盘档的服务进程里这条任务真的建出来了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-sched-'))
    try {
      const s = await start({ dbDir: dir })
      expect(s.schedule.scheduler.get('sched_idempotency_sweep')?.handler).toBe(
        HANDLERS.idempotencySweep,
      )
      await s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('重启续跑', () => {
  it('用户改过时间的系统任务，重启后照他改的来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-sched-'))
    try {
      const first = await start({ dbDir: dir })
      const asg = first.bootstrap.ownerAssignment.id
      await first.schedule.scheduler.update(`sched_daily_plan_${asg}`, {
        trigger: { kind: 'cron', expr: '0 9 * * *', tz: '+08:00' },
      })
      await first.close()

      const second = await start({ dbDir: dir })
      const reloaded = second.schedule.scheduler.get(
        `sched_daily_plan_${second.bootstrap.ownerAssignment.id}`,
      )
      expect(reloaded?.trigger).toMatchObject({ expr: '0 9 * * *' })
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('停掉的任务重启后还是停的', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-sched-'))
    try {
      const first = await start({ dbDir: dir })
      await first.schedule.scheduler.pause('sched_skills_weekly')
      await first.close()
      const second = await start({ dbDir: dir })
      expect(second.schedule.scheduler.get('sched_skills_weekly')?.state).toBe('paused')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('小工具', () => {
  it('offsetToTz', () => {
    expect(offsetToTz(480)).toBe('+08:00')
    expect(offsetToTz(-330)).toBe('-05:30')
    expect(offsetToTz(0)).toBe('+00:00')
  })

  it('nextMorningAt：明早 07:55（本地）', () => {
    expect(nextMorningAt('2026-09-10T12:00:00.000Z', '+08:00')).toBe('2026-09-10T23:55:00.000Z')
    expect(nextMorningAt('2026-09-10T12:00:00.000Z', 'UTC')).toBe('2026-09-11T07:55:00.000Z')
  })

  it('isMonthEnd', () => {
    expect(isMonthEnd('2026-09-30T12:00:00.000Z', 'UTC')).toBe(true)
    expect(isMonthEnd('2026-09-29T12:00:00.000Z', 'UTC')).toBe(false)
  })

  it('nextTokenCheck：最早到期减一小时，至少一分钟以后', () => {
    const now = T0
    const deps = {
      clock: { now: () => now },
      scheduler: {} as never,
      refreshTokens: async () => {},
      expiries: () => ['2026-09-11T00:00:00.000Z', '2026-09-10T12:00:00.000Z'],
    }
    expect(nextTokenCheck(deps, now)).toBe(
      new Date(Date.parse('2026-09-10T12:00:00.000Z') - TOKEN_REFRESH_LEAD_MS).toISOString(),
    )
    expect(nextTokenCheck({ ...deps, expiries: () => [] }, now)).toBe(
      new Date(Date.parse(now) + TOKEN_IDLE_INTERVAL_MS).toISOString(),
    )
    // 已经过期的：至少一分钟以后再看，不然就把自己排成死循环
    expect(nextTokenCheck({ ...deps, expiries: () => ['2026-09-09T00:00:00.000Z'] }, now)).toBe(
      new Date(Date.parse(now) + 60_000).toISOString(),
    )
  })
})

/* ------------------------------------------------------------------ */
/* C. `/v1/schedules` 与 `/v1/workflows`（25 §5）                        */
/* ------------------------------------------------------------------ */

describe('25 §5 API', () => {
  beforeEach(async () => {
    server = await start()
  })

  afterEach(async () => {
    await server.close()
  })

  const call = async (
    path: string,
    init: RequestInit & { assignment?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', init.assignment ?? server.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }))
  }

  const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

  it('GET /v1/schedules：默认只回本岗位；scope=workspace 回整个工作区', async () => {
    const mine = await dataOf<{ id: string }[]>(await call('/v1/schedules'))
    // 本岗位那十一条：计划 + 日 / 周 / 月复盘 + 会议轮询 + 令牌刷新 + 技能周合并
    // + WP29 的学习提案 + WP34 的三条（审批家务 / 邮箱轮询 / 原始材料保留期）
    // （内存档没有幂等表落盘，所以没有那条清理任务）
    expect(mine).toHaveLength(11)
    const all = await dataOf<{ id: string }[]>(await call('/v1/schedules?scope=workspace'))
    expect(all.length).toBe(mine.length)
    const byPerson = await dataOf<{ id: string }[]>(await call('/v1/schedules?scope=mine'))
    expect(byPerson.length).toBe(all.length)
    expect((await call('/v1/schedules?scope=乱写')).status).toBe(400)
  })

  it('GET /v1/schedules?state= 过滤；?conversation= 只看这次对话设的', async () => {
    await call('/v1/schedules', {
      method: 'POST',
      body: JSON.stringify({
        title: '这次对话设的',
        trigger: { kind: 'cron', expr: '0 9 * * *', tz: '+08:00' },
        conversation_id: 'conv_1',
      }),
    })
    const byConv = await dataOf<{ title: string }[]>(
      await call('/v1/schedules?conversation=conv_1'),
    )
    expect(byConv.map((t) => t.title)).toEqual(['这次对话设的'])
    const paused = await dataOf<unknown[]>(await call('/v1/schedules?state=paused'))
    expect(paused).toHaveLength(0)
  })

  it('POST /v1/schedules：本人给自己岗位建的直接生效（25 §5）', async () => {
    const res = await call('/v1/schedules', {
      method: 'POST',
      body: JSON.stringify({
        title: '每天早上看一眼昨天的单',
        trigger: { kind: 'cron', expr: '0 9 * * *', tz: '+08:00' },
        effect: 'read_only',
      }),
    })
    expect(res.status).toBe(201)
    const task = await dataOf<{ state: string; approval?: string; next_fire_at: string }>(res)
    expect(task.state).toBe('active')
    expect(task.approval).toBeUndefined()
    expect(task.next_fire_at).toBe('2026-09-10T01:00:00.000Z')
  })

  it('POST /v1/schedules：给别人的岗位建 → 先出一条 scheduled_task 审批项', async () => {
    // 再建一条岗位，分给另一个人
    const other = server.roles.assignments.create({
      person_id: 'p_other',
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'common.member',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    const task = await dataOf<{ state: string; approval?: string; owner: string }>(
      await call('/v1/schedules', {
        method: 'POST',
        body: JSON.stringify({
          title: '每周一给客户发跟进',
          trigger: { kind: 'cron', expr: '0 9 * * 1', tz: '+08:00' },
          effect: 'sends',
          assignment_id: other.id,
        }),
      }),
    )
    expect(task.state).toBe('pending')
    expect(task.owner).toBe('p_other')
    expect(task.approval).toBeDefined()
    const items = (await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: 'p_other',
      lane: 'mine',
    })) as ApprovalItem[]
    expect(items.map((i) => i.kind)).toContain('scheduled_task')
  })

  it('POST /v1/schedules：岗位不存在 → 404；请求体不合法 → 400', async () => {
    expect(
      (
        await call('/v1/schedules', {
          method: 'POST',
          body: JSON.stringify({
            title: 'x',
            trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
            assignment_id: '没这个岗位',
          }),
        })
      ).status,
    ).toBe(404)
    expect(
      (await call('/v1/schedules', { method: 'POST', body: JSON.stringify({ title: '' }) })).status,
    ).toBe(400)
  })

  it('PATCH /v1/schedules/:id：暂停 → 恢复 → 改时间', async () => {
    const id = `sched_skills_weekly`
    const paused = await dataOf<{ state: string }>(
      await call(`/v1/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'pause' }),
      }),
    )
    expect(paused.state).toBe('paused')
    const resumed = await dataOf<{ state: string }>(
      await call(`/v1/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'resume' }),
      }),
    )
    expect(resumed.state).toBe('active')
    const moved = await dataOf<{ next_fire_at: string; title: string }>(
      await call(`/v1/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          trigger: { kind: 'cron', expr: '0 7 * * 1', tz: 'UTC' },
          title: '改成 7 点',
        }),
      }),
    )
    expect(moved.title).toBe('改成 7 点')
    expect(moved.next_fire_at).toBe('2026-09-14T07:00:00.000Z')
    // 什么都不改 → 400
    expect(
      (await call(`/v1/schedules/${id}`, { method: 'PATCH', body: JSON.stringify({}) })).status,
    ).toBe(400)
  })

  it('DELETE /v1/schedules/:id：不再触发，记录留着看历史', async () => {
    const deleted = await dataOf<{ state: string }>(
      await call('/v1/schedules/sched_skills_weekly', { method: 'DELETE' }),
    )
    expect(deleted.state).toBe('cancelled')
    expect(server.schedule.scheduler.get('sched_skills_weekly')?.next_fire_at).toBeUndefined()
  })

  it('POST /v1/schedules/:id/run-now：立即跑一次，排期不动', async () => {
    const before = server.schedule.scheduler.get('sched_skills_weekly')?.next_fire_at
    const out = await dataOf<{ ok: boolean; task: { next_fire_at: string; fire_count: number } }>(
      await call('/v1/schedules/sched_skills_weekly/run-now', { method: 'POST' }),
    )
    expect(out.ok).toBe(true)
    expect(out.task.fire_count).toBe(1)
    expect(out.task.next_fire_at).toBe(before)
  })

  it('别人的定时任务：看不见也改不了（403 / 404）', async () => {
    const other = server.roles.assignments.create({
      person_id: 'p_other',
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'common.member',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    const task = await dataOf<{ id: string }>(
      await call('/v1/schedules', {
        method: 'POST',
        body: JSON.stringify({
          title: '别人的',
          trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
          assignment_id: other.id,
        }),
      }),
    )
    expect((await call(`/v1/schedules/${task.id}`, { method: 'DELETE' })).status).toBe(403)
    expect((await call('/v1/schedules/没这条', { method: 'DELETE' })).status).toBe(404)
  })

  it('GET /v1/workflows 与 /v1/workflows/:id', async () => {
    const instance = await server.schedule.workflows.start(
      {
        id: 'creator.collab',
        version: '1',
        name: '红人合作',
        role_id: 'common.owner',
        steps: [{ id: 'wait', kind: 'wait_event', params: { event: 'shipment.delivered' } }],
      },
      { type: 'creator', id: 'cr_1' },
      { workspace_id: server.bootstrap.workspace.id },
    )
    const list = await dataOf<{ id: string; state: string }[]>(await call('/v1/workflows'))
    expect(list.map((i) => i.id)).toEqual([instance.id])
    expect((await dataOf<unknown[]>(await call('/v1/workflows?state=done'))).length).toBe(0)
    expect((await dataOf<unknown[]>(await call('/v1/workflows?subject=creator:cr_1'))).length).toBe(
      1,
    )
    expect((await call('/v1/workflows?subject=乱写')).status).toBe(400)

    const one = await dataOf<{ cursor: string; history: unknown[] }>(
      await call(`/v1/workflows/${instance.id}`),
    )
    expect(one.cursor).toBe('wait')
    // 投影不把定义快照与 attempts 端给前端
    expect(one).not.toHaveProperty('definition')
    expect((await call('/v1/workflows/没这条')).status).toBe(404)
  })

  it('OpenAPI 里有这七条路由', async () => {
    const doc = (await (
      await server.gateway.fetch(new Request('http://127.0.0.1/openapi.json'))
    ).json()) as { paths: Record<string, Record<string, unknown>> }
    expect(doc.paths['/v1/schedules']).toHaveProperty('get')
    expect(doc.paths['/v1/schedules']).toHaveProperty('post')
    expect(doc.paths['/v1/schedules/{id}']).toHaveProperty('patch')
    expect(doc.paths['/v1/schedules/{id}']).toHaveProperty('delete')
    expect(doc.paths['/v1/schedules/{id}/run-now']).toHaveProperty('post')
    expect(doc.paths['/v1/workflows']).toHaveProperty('get')
    expect(doc.paths['/v1/workflows/{id}']).toHaveProperty('get')
  })
})
