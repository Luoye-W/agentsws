/**
 * WP215：每个品牌一套后台，共用一个调度循环。
 *
 * 钉三件事：
 * - 品牌路由：同一个处理器名，到点时按**任务自己的** `workspace_id` 找处理器；没装配就失败，
 *   绝不退回别的品牌那一份；
 * - `hold`：停着的品牌到点不触发（不记次数、不挪排期），放开之后按 misfire 规矩补；
 * - `concurrency`：同一品牌一条接一条，品牌之间最多 N 条同时跑。
 */
import { describe, expect, it } from 'vitest'
import {
  brandBackgroundStatus,
  createBrandRouter,
  createScheduler,
  type ScheduleTask,
} from '../src/index.js'
import { recorder, TestClock, taskInput } from './helpers.js'

const T0 = '2026-10-05T01:00:00.000Z'

describe('WP215 品牌路由', () => {
  it('同一个处理器名：A 的任务只用 A 的那一份，B 的只用 B 的', async () => {
    const clock = new TestClock(T0)
    const scheduler = createScheduler({ clock })
    const router = createBrandRouter(scheduler)
    const seen: string[] = []
    router.for('ws_a').register('patrol', (ctx) => {
      seen.push(`a:${ctx.task.workspace_id}`)
    })
    router.for('ws_b').register('patrol', (ctx) => {
      seen.push(`b:${ctx.task.workspace_id}`)
    })
    const every = { kind: 'interval' as const, every_ms: 60_000 }
    await scheduler.schedule(taskInput({ workspace_id: 'ws_a', handler: 'patrol', trigger: every }))
    await scheduler.schedule(taskInput({ workspace_id: 'ws_b', handler: 'patrol', trigger: every }))
    clock.advance(60_000)
    await scheduler.runDue(clock.now())
    expect(seen.sort()).toEqual(['a:ws_a', 'b:ws_b'])
    expect(router.brands().sort()).toEqual(['ws_a', 'ws_b'])
    expect(router.handlersOf('ws_a')).toEqual(['patrol'])
  })

  it('没装配的品牌：这一次失败并说清楚，绝不借别的品牌那一份', async () => {
    const clock = new TestClock(T0)
    const scheduler = createScheduler({ clock })
    const router = createBrandRouter(scheduler)
    let ranA = 0
    router.for('ws_a').register('patrol', () => {
      ranA += 1
    })
    const task = await scheduler.schedule(
      taskInput({ workspace_id: 'ws_c', handler: 'patrol', trigger: { kind: 'once', at: T0 } }),
    )
    const out = await scheduler.runNow(task.id)
    expect(out.ok).toBe(false)
    expect(out.error?.message).toContain('ws_c')
    expect(ranA).toBe(0)
  })

  it('登记口上的其余方法照转共享调度器；drop 之后这个品牌的处理器没了', async () => {
    const clock = new TestClock(T0)
    const scheduler = createScheduler({ clock })
    const router = createBrandRouter(scheduler)
    const b = router.for('ws_b')
    const made = await b.schedule(
      taskInput({ workspace_id: 'ws_b', handler: 'patrol', trigger: { kind: 'once', at: T0 } }),
    )
    expect(scheduler.get(made.id)?.workspace_id).toBe('ws_b')
    b.register('patrol', () => 'ok')
    expect((await scheduler.runNow(made.id)).ok).toBe(true)
    router.drop('ws_b')
    expect(router.handlersOf('ws_b')).toEqual([])
  })
})

describe('WP215 hold：停着的品牌到点不跑', () => {
  it('不记触发、不挪排期；放开之后 run_once_now 补一次，skip 跳到下一次', async () => {
    const clock = new TestClock(T0)
    const { sink, events } = recorder()
    const halted = new Set<string>(['ws_b'])
    const scheduler = createScheduler({
      clock,
      eventSink: sink,
      hold: (t) => halted.has(t.workspace_id),
    })
    let runs = 0
    scheduler.register('patrol', () => {
      runs += 1
    })
    const once = await scheduler.schedule(
      taskInput({
        workspace_id: 'ws_b',
        handler: 'patrol',
        trigger: { kind: 'interval', every_ms: 15 * 60_000 },
        misfire_policy: 'run_once_now',
      }),
    )
    const skip = await scheduler.schedule(
      taskInput({
        workspace_id: 'ws_b',
        handler: 'patrol',
        trigger: { kind: 'interval', every_ms: 15 * 60_000 },
        misfire_policy: 'skip',
      }),
    )
    clock.advance(60 * 60_000)
    expect(await scheduler.runDue(clock.now())).toEqual([])
    expect(scheduler.get(once.id)?.fire_count).toBe(0)
    expect(scheduler.get(once.id)?.next_fire_at).toBe(once.next_fire_at)
    await expect(scheduler.runNow(once.id)).rejects.toThrow('停着')
    expect(events.filter((e) => e.type === 'schedule.fired')).toHaveLength(0)

    halted.clear()
    await scheduler.runDue(clock.now())
    expect(runs).toBe(1)
    expect(scheduler.get(once.id)?.fire_count).toBe(1)
    expect(scheduler.get(skip.id)?.fire_count).toBe(0)
  })
})

describe('WP215 concurrency：同品牌串行，品牌之间并行且有上限', () => {
  it('上限 2：三个品牌同时到点，最多两条同时在跑；同一品牌的两条不重叠', async () => {
    const clock = new TestClock(T0)
    const scheduler = createScheduler({ clock, concurrency: () => 2 })
    let live = 0
    let peak = 0
    const perBrand = new Map<string, number>()
    let brandOverlap = false
    scheduler.register('patrol', async (ctx) => {
      const ws = ctx.task.workspace_id
      live += 1
      peak = Math.max(peak, live)
      perBrand.set(ws, (perBrand.get(ws) ?? 0) + 1)
      if ((perBrand.get(ws) ?? 0) > 1) brandOverlap = true
      await new Promise((r) => setTimeout(r, 5))
      perBrand.set(ws, (perBrand.get(ws) ?? 1) - 1)
      live -= 1
      return ws
    })
    const at = { kind: 'once' as const, at: '2026-10-05T01:01:00.000Z' }
    for (const ws of ['ws_a', 'ws_a', 'ws_b', 'ws_c'])
      await scheduler.schedule(taskInput({ workspace_id: ws, handler: 'patrol', trigger: at }))
    clock.advance(60_000)
    const out = await scheduler.runDue(clock.now())
    expect(out).toHaveLength(4)
    expect(out.every((o) => o.ok)).toBe(true)
    // 结果顺序与触发顺序一致
    expect(out.map((o) => o.task.workspace_id)).toEqual(['ws_a', 'ws_a', 'ws_b', 'ws_c'])
    expect(peak).toBe(2)
    expect(brandOverlap).toBe(false)
  })

  it('不给 concurrency 就是一条接一条（与之前一模一样）', async () => {
    const clock = new TestClock(T0)
    const scheduler = createScheduler({ clock })
    let live = 0
    let peak = 0
    scheduler.register('patrol', async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live -= 1
    })
    const at = { kind: 'once' as const, at: '2026-10-05T01:01:00.000Z' }
    for (const ws of ['ws_a', 'ws_b'])
      await scheduler.schedule(taskInput({ workspace_id: ws, handler: 'patrol', trigger: at }))
    clock.advance(60_000)
    await scheduler.runDue(clock.now())
    expect(peak).toBe(1)
  })
})

describe('WP215 后台状态', () => {
  const base = (over: Partial<ScheduleTask>): ScheduleTask => ({
    id: 'sched_x',
    workspace_id: 'ws_b',
    owner: 'p_owner',
    role_id: 'common.owner',
    assignment_id: 'asg_1',
    trigger: { kind: 'interval', every_ms: 60_000 },
    state: 'active',
    fire_count: 0,
    created_by: 'user',
    misfire_policy: 'skip',
    created_at: T0,
    updated_at: T0,
    ...over,
  })

  it('在跑几条、最近一次、红点只看这个品牌；进程级的家务可以排除', () => {
    const tasks = [
      base({
        id: 't1',
        last_fire_at: '2026-10-05T02:00:00.000Z',
        next_fire_at: '2026-10-05T02:15:00.000Z',
      }),
      base({
        id: 't2',
        title: '品牌监控',
        last_fire_at: '2026-10-05T03:00:00.000Z',
        last_error: 'feed 404',
      }),
      base({ id: 't3', state: 'paused' }),
      base({ id: 't4', workspace_id: 'ws_a', last_fire_at: '2026-10-05T09:00:00.000Z' }),
      base({
        id: 't5',
        handler: 'api.idempotency_sweep',
        last_fire_at: '2026-10-05T08:00:00.000Z',
      }),
    ]
    const view = brandBackgroundStatus(tasks, {
      workspace_id: 'ws_b',
      halted: false,
      stopped: false,
      exclude: (t) => t.handler === 'api.idempotency_sweep',
    })
    expect(view.state).toBe('running')
    expect(view.scheduled).toBe(2)
    expect(view.last_run_at).toBe('2026-10-05T03:00:00.000Z')
    expect(view.next_run_at).toBe('2026-10-05T02:15:00.000Z')
    expect(view.errors).toBe(1)
    expect(view.last_error).toMatchObject({ task_id: 't2', title: '品牌监控', message: 'feed 404' })
  })

  it('停用压过急停：stopped > halted > running', () => {
    expect(
      brandBackgroundStatus([], { workspace_id: 'w', halted: true, stopped: true }).state,
    ).toBe('stopped')
    expect(
      brandBackgroundStatus([], { workspace_id: 'w', halted: true, stopped: false }).state,
    ).toBe('halted')
  })
})
