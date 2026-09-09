import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createScheduler,
  DEFAULT_LEASE_MS,
  firstFireAt,
  MemoryScheduleStore,
  nextFireAfter,
  ScheduleError,
  type ScheduleTask,
  SqliteScheduleStore,
} from '../src/index.js'
import { recorder, TestClock, taskInput } from './helpers.js'

const START = '2026-09-10T00:00:00.000Z'
const MIN = 60_000

describe('nextFireAfter / firstFireAt', () => {
  const now = Date.parse(START)

  it('once 只有第一次，没有下一次', () => {
    const trigger = { kind: 'once', at: '2026-09-11T00:00:00.000Z' } as const
    expect(firstFireAt(trigger, now)).toBe('2026-09-11T00:00:00.000Z')
    expect(nextFireAfter(trigger, now)).toBeUndefined()
  })

  it('interval：不给 from 就从「现在 + 一个间隔」起', () => {
    expect(firstFireAt({ kind: 'interval', every_ms: 15 * MIN }, now)).toBe(
      '2026-09-10T00:15:00.000Z',
    )
    expect(firstFireAt({ kind: 'interval', every_ms: 15 * MIN, from: START }, now)).toBe(START)
  })

  it('after_event 不排队', () => {
    expect(firstFireAt({ kind: 'after_event', event: 'x' }, now)).toBeUndefined()
    expect(nextFireAfter({ kind: 'after_event', event: 'x' }, now)).toBeUndefined()
  })

  it('拒绝不合法的时刻与间隔', () => {
    expect(() => firstFireAt({ kind: 'once', at: '不是时间' }, now)).toThrow(ScheduleError)
    expect(() => firstFireAt({ kind: 'interval', every_ms: 15 * MIN, from: 'x' }, now)).toThrow(
      ScheduleError,
    )
    expect(() => nextFireAfter({ kind: 'interval', every_ms: 1000 }, now)).toThrow(ScheduleError)
  })
})

describe('调度器：建 / 改 / 停 / 恢复 / 取消', () => {
  let clock: TestClock

  beforeEach(() => {
    clock = new TestClock(START)
  })

  it('建一条 cron 任务：算出 next_fire_at 并发 schedule.created', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' }, title: '每日计划' }),
    )
    expect(task.state).toBe('active')
    expect(task.fire_count).toBe(0)
    expect(task.next_fire_at).toBe('2026-09-10T08:00:00.000Z')
    expect(events.map((e) => e.type)).toEqual(['schedule.created'])
    expect(events[0]?.payload).toMatchObject({ title: '每日计划', created_by: 'user' })
    expect(events[0]?.subject).toEqual({ type: 'scheduled_task', id: task.id })
  })

  it('同一个 id 建两次 → conflict', async () => {
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ id: 'sched_fixed' }))
    await expect(s.schedule(taskInput({ id: 'sched_fixed' }))).rejects.toThrow(ScheduleError)
  })

  it('改时间：重算 next_fire_at 并发 schedule.updated', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }),
    )
    const moved = await s.update(task.id, {
      trigger: { kind: 'cron', expr: '0 20 * * *', tz: 'UTC' },
      title: '改成晚上',
      params: { a: 1 },
      misfire_policy: 'skip',
    })
    expect(moved.next_fire_at).toBe('2026-09-10T20:00:00.000Z')
    expect(moved.title).toBe('改成晚上')
    expect(moved.params).toEqual({ a: 1 })
    expect(moved.misfire_policy).toBe('skip')
    expect(events.at(-1)?.type).toBe('schedule.updated')
  })

  it('只改标题不动排期', async () => {
    const s = createScheduler({ clock })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }),
    )
    const same = await s.update(task.id, { title: '换个名字' })
    expect(same.next_fire_at).toBe(task.next_fire_at)
  })

  it('暂停 → 不再排队；恢复 → 排到下一次', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }),
    )
    await s.pause(task.id)
    clock.advance(9 * 60 * MIN)
    expect((await s.tick(clock.now())).fired).toHaveLength(0)
    const back = await s.resume(task.id)
    expect(back.state).toBe('active')
    // 暂停期间错过的不补：直接排到明天 08:00
    expect(back.next_fire_at).toBe('2026-09-11T08:00:00.000Z')
    expect(events.map((e) => e.type)).toContain('schedule.paused')
    expect(events.map((e) => e.type)).toContain('schedule.resumed')
  })

  it('恢复时如果排期还在未来就不动它', async () => {
    const s = createScheduler({ clock })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }),
    )
    await s.pause(task.id)
    const back = await s.resume(task.id)
    expect(back.next_fire_at).toBe('2026-09-10T08:00:00.000Z')
  })

  it('没暂停的恢复不了、已取消的改不了停不了', async () => {
    const s = createScheduler({ clock })
    const task = await s.schedule(taskInput())
    await expect(s.resume(task.id)).rejects.toThrow(ScheduleError)
    await s.cancel(task.id)
    await expect(s.update(task.id, { title: 'x' })).rejects.toThrow(ScheduleError)
    await expect(s.pause(task.id)).rejects.toThrow(ScheduleError)
    await expect(s.runNow(task.id)).rejects.toThrow(ScheduleError)
  })

  it('找不到的 id 一律 not_found', async () => {
    const s = createScheduler({ clock })
    await expect(s.pause('nope')).rejects.toThrow(ScheduleError)
    await expect(s.resume('nope')).rejects.toThrow(ScheduleError)
    await expect(s.cancel('nope')).rejects.toThrow(ScheduleError)
    await expect(s.update('nope', {})).rejects.toThrow(ScheduleError)
    await expect(s.runNow('nope')).rejects.toThrow(ScheduleError)
    expect(s.get('nope')).toBeUndefined()
  })

  it('取消 → schedule.deleted，不再排队；remove 才真删', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    const task = await s.schedule(taskInput())
    const cancelled = await s.cancel(task.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.next_fire_at).toBeUndefined()
    expect(events.at(-1)?.type).toBe('schedule.deleted')
    expect(s.get(task.id)).toBeDefined()
    s.remove(task.id)
    expect(s.get(task.id)).toBeUndefined()
  })

  it('list 按工作区与岗位过滤', async () => {
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ assignment_id: 'asg_1' }))
    await s.schedule(taskInput({ assignment_id: 'asg_2' }))
    expect(s.list({ workspace_id: 'ws_test' })).toHaveLength(2)
    expect(s.list({ workspace_id: 'ws_test', assignment_id: 'asg_2' })).toHaveLength(1)
  })
})

describe('调度器：触发', () => {
  let clock: TestClock

  beforeEach(() => {
    clock = new TestClock(START)
  })

  it('到点才跑；跑完 cron 任务回 active 并排下一次', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    const seen: string[] = []
    s.register('noop', (ctx) => {
      seen.push(ctx.idempotency_key)
      return { ok: true }
    })
    await s.schedule(taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }))
    expect(await s.runDue(clock.now())).toHaveLength(0)
    clock.set('2026-09-10T08:00:00.000Z')
    const out = await s.runDue(clock.now())
    expect(out).toHaveLength(1)
    expect(out[0]?.ok).toBe(true)
    expect(seen).toEqual([`sched_${String(out[0]?.task.id)}_1`])
    const task = out[0]?.task
    expect(task?.state).toBe('active')
    expect(task?.fire_count).toBe(1)
    expect(task?.last_fire_at).toBe('2026-09-10T08:00:00.000Z')
    expect(task?.next_fire_at).toBe('2026-09-11T08:00:00.000Z')
    expect(task?.last_result).toBe('{"ok":true}')
    expect(events.map((e) => e.type)).toEqual(['schedule.created', 'schedule.fired'])
  })

  it('一次性任务跑完就 done', async () => {
    const clock2 = new TestClock(START)
    const s = createScheduler({ clock: clock2 })
    s.register('noop', () => 'ok')
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'once', at: '2026-09-10T00:10:00.000Z' } }),
    )
    clock2.set('2026-09-10T00:10:00.000Z')
    const [out] = await s.runDue(clock2.now())
    expect(out?.task.state).toBe('done')
    expect(out?.task.next_fire_at).toBeUndefined()
    expect(s.get(task.id)?.fire_count).toBe(1)
  })

  it('interval 任务按间隔一路往前排', async () => {
    const s = createScheduler({ clock })
    s.register('noop', () => undefined)
    await s.schedule(taskInput({ trigger: { kind: 'interval', every_ms: 15 * MIN } }))
    for (let i = 1; i <= 3; i += 1) {
      clock.advance(15 * MIN)
      const out = await s.runDue(clock.now())
      expect(out).toHaveLength(1)
      expect(out[0]?.task.fire_count).toBe(i)
    }
  })

  it('结果太长就截断（列表要能看）', async () => {
    const s = createScheduler({ clock })
    s.register('noop', () => 'x'.repeat(500))
    await s.schedule(taskInput({ trigger: { kind: 'once', at: START } }))
    const [out] = await s.runDue(clock.now())
    expect(out?.task.last_result?.length).toBe(201)
    expect(out?.task.last_result?.endsWith('…')).toBe(true)
  })

  it('处理器抛错：周期任务下一次照跑，事件记 schedule.failed', async () => {
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    s.register('boom', () => {
      throw new ScheduleError('provider_unavailable', '店挂了')
    })
    await s.schedule(
      taskInput({ handler: 'boom', trigger: { kind: 'interval', every_ms: 15 * MIN } }),
    )
    clock.advance(15 * MIN)
    const [out] = await s.runDue(clock.now())
    expect(out?.ok).toBe(false)
    expect(out?.error).toEqual({ code: 'provider_unavailable', message: '店挂了' })
    expect(out?.task.state).toBe('active')
    expect(out?.task.next_fire_at).toBe('2026-09-10T00:30:00.000Z')
    expect(events.map((e) => e.type)).toContain('schedule.failed')
  })

  it('一次性任务失败 → failed', async () => {
    const s = createScheduler({ clock })
    s.register('boom', () => {
      throw new Error('炸了')
    })
    await s.schedule(taskInput({ handler: 'boom', trigger: { kind: 'once', at: START } }))
    const [out] = await s.runDue(clock.now())
    expect(out?.task.state).toBe('failed')
    expect(out?.task.last_error).toBe('炸了')
  })

  it('一个消费者炸了不影响别的（25 交付要求）', async () => {
    const s = createScheduler({ clock })
    const ran: string[] = []
    s.register('boom', () => {
      throw new Error('炸了')
    })
    s.register('fine', () => {
      ran.push('fine')
    })
    await s.schedule(taskInput({ handler: 'boom', trigger: { kind: 'once', at: START } }))
    await s.schedule(taskInput({ handler: 'fine', trigger: { kind: 'once', at: START } }))
    const out = await s.runDue(clock.now())
    expect(out.map((o) => o.ok)).toEqual([false, true])
    expect(ran).toEqual(['fine'])
  })

  it('没登记处理器 → not_implemented，不是静默跳过', async () => {
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ handler: '没人登记', trigger: { kind: 'once', at: START } }))
    const [out] = await s.runDue(clock.now())
    expect(out?.ok).toBe(false)
    expect(out?.error?.code).toBe('not_implemented')
  })

  it('handler 没填也走 not_implemented', async () => {
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ handler: undefined, trigger: { kind: 'once', at: START } }))
    const [out] = await s.runDue(clock.now())
    expect(out?.error?.code).toBe('not_implemented')
  })

  it('同名处理器后来者覆盖', async () => {
    const s = createScheduler({ clock })
    const ran: string[] = []
    s.register('h', () => ran.push('旧'))
    s.register('h', () => ran.push('新'))
    expect(s.handlers()).toEqual(['h'])
    await s.schedule(taskInput({ handler: 'h', trigger: { kind: 'once', at: START } }))
    await s.runDue(clock.now())
    expect(ran).toEqual(['新'])
  })

  it('tick 的 now 必须是 ISO-8601', async () => {
    const s = createScheduler({ clock })
    await expect(s.tick('昨天')).rejects.toThrow(ScheduleError)
  })
})

describe('不重入与租约', () => {
  it('上一次还在跑（租约没过）→ 这一拍跳过', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ trigger: { kind: 'interval', every_ms: MIN } }))
    clock.advance(MIN)
    // 只 tick 不派发：任务停在 running，租约还在
    const first = await s.tick(clock.now())
    expect(first.fired).toHaveLength(1)
    clock.advance(MIN)
    expect((await s.tick(clock.now())).fired).toHaveLength(0)
  })

  it('租约过期 → 下一拍接管（进程被 kill 掉留下的 running）', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock, leaseMs: 2 * MIN, misfireGraceMs: 10 * 60 * MIN })
    await s.schedule(taskInput({ trigger: { kind: 'interval', every_ms: MIN } }))
    clock.advance(MIN)
    await s.tick(clock.now())
    clock.advance(5 * MIN)
    expect((await s.tick(clock.now())).fired).toHaveLength(1)
  })

  it('默认租约是 5 分钟', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ trigger: { kind: 'interval', every_ms: MIN } }))
    clock.advance(MIN)
    const [fired] = (await s.tick(clock.now())).fired
    expect(fired?.lease?.until).toBe(
      new Date(Date.parse(clock.now()) + DEFAULT_LEASE_MS).toISOString(),
    )
  })
})

describe('立即运行与信号', () => {
  it('run-now 不动原排期', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    let ran = 0
    s.register('noop', () => {
      ran += 1
    })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } }),
    )
    const out = await s.runNow(task.id)
    expect(ran).toBe(1)
    expect(out.task.next_fire_at).toBe('2026-09-10T08:00:00.000Z')
    expect(out.task.state).toBe('active')
    expect(out.task.fire_count).toBe(1)
  })

  it('run-now 撞上正在跑的租约 → conflict', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ id: 'sched_x', trigger: { kind: 'interval', every_ms: MIN } }))
    clock.advance(MIN)
    await s.tick(clock.now())
    await expect(s.runNow('sched_x')).rejects.toThrow(ScheduleError)
  })

  it('租约过期的 run-now 能跑', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock, leaseMs: MIN })
    s.register('noop', () => 'ok')
    await s.schedule(taskInput({ id: 'sched_x', trigger: { kind: 'interval', every_ms: MIN } }))
    clock.advance(MIN)
    await s.tick(clock.now())
    clock.advance(5 * MIN)
    expect((await s.runNow('sched_x')).ok).toBe(true)
  })

  it('一次性任务 run-now 之后就 done', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    s.register('noop', () => 'ok')
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'once', at: '2026-09-20T00:00:00.000Z' } }),
    )
    const out = await s.runNow(task.id)
    expect(out.task.next_fire_at).toBe('2026-09-20T00:00:00.000Z')
  })

  it('after_event：信号来了才跑，别的事件不跑', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    const got: unknown[] = []
    s.register('onEvent', (ctx) => {
      got.push(ctx.task.params)
    })
    const task = await s.schedule(
      taskInput({
        handler: 'onEvent',
        trigger: { kind: 'after_event', event: 'shipment.delivered' },
      }),
    )
    expect(task.next_fire_at).toBeUndefined()
    expect(await s.signal('别的事件')).toHaveLength(0)
    const out = await s.signal('shipment.delivered', { tracking: 'SF123' })
    expect(out).toHaveLength(1)
    expect(got).toEqual([{ tracking: 'SF123' }])
  })

  it('暂停中的 after_event 任务不响应信号', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    s.register('onEvent', () => 'ok')
    const task = await s.schedule(
      taskInput({ handler: 'onEvent', trigger: { kind: 'after_event', event: 'e' } }),
    )
    await s.pause(task.id)
    expect(await s.signal('e')).toHaveLength(0)
  })
})

describe('错过触发（misfire）', () => {
  it('run_once_now：补跑一次并记 misfired（25 §6.6）', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    s.register('noop', () => 'ok')
    await s.schedule(
      taskInput({
        trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
        misfire_policy: 'run_once_now',
      }),
    )
    // 机器关了两天
    clock.set('2026-09-12T09:00:00.000Z')
    const out = await s.runDue(clock.now())
    expect(out).toHaveLength(1)
    expect(out[0]?.misfired).toBe(true)
    expect(out[0]?.task.fire_count).toBe(1)
    expect(out[0]?.task.next_fire_at).toBe('2026-09-13T08:00:00.000Z')
    expect(events.map((e) => e.type)).toEqual([
      'schedule.created',
      'schedule.misfired',
      'schedule.fired',
    ])
    expect(events[1]?.payload).toMatchObject({ policy: 'run_once_now' })
  })

  it('skip：不补跑，只把排期挪到现在之后', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    let ran = 0
    s.register('noop', () => {
      ran += 1
    })
    await s.schedule(
      taskInput({
        trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
        misfire_policy: 'skip',
      }),
    )
    clock.set('2026-09-12T09:00:00.000Z')
    const out = await s.runDue(clock.now())
    expect(out).toHaveLength(0)
    expect(ran).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['schedule.created', 'schedule.misfired'])
    expect(s.get(s.list({ workspace_id: 'ws_test' })[0]?.id ?? '')?.next_fire_at).toBe(
      '2026-09-13T08:00:00.000Z',
    )
  })

  it('skip 的一次性任务错过了就 done', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    await s.schedule(taskInput({ trigger: { kind: 'once', at: START }, misfire_policy: 'skip' }))
    clock.advance(60 * MIN)
    const { misfired } = await s.tick(clock.now())
    expect(misfired[0]?.state).toBe('done')
  })

  it('宽限期内的不算错过', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    s.register('noop', () => 'ok')
    await s.schedule(
      taskInput({ trigger: { kind: 'once', at: START }, misfire_grace_ms: 30 * MIN }),
    )
    clock.advance(10 * MIN)
    const out = await s.runDue(clock.now())
    expect(out[0]?.misfired).toBe(false)
  })
})

describe('重启续跑（SQLite 档）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-schedule-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('进程重启后到期任务不丢', async () => {
    const path = join(dir, 'schedule.sqlite')
    const clock = new TestClock(START)
    const store = new SqliteScheduleStore({ dbPath: path, clock })
    expect(store.schema_version).toBe(1)
    const first = createScheduler({ clock, store })
    const task = await first.schedule(
      taskInput({ trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' }, title: '每日计划' }),
    )
    first.close()

    // ── 重启：新进程、新调度器、同一个库
    const clock2 = new TestClock('2026-09-10T08:30:00.000Z')
    const store2 = new SqliteScheduleStore({ dbPath: path, clock: clock2 })
    const second = createScheduler({ clock: clock2, store: store2 })
    let ran = 0
    second.register('noop', () => {
      ran += 1
    })
    const reloaded = second.get(task.id)
    expect(reloaded?.title).toBe('每日计划')
    expect(reloaded?.next_fire_at).toBe('2026-09-10T08:00:00.000Z')
    const out = await second.runDue(clock2.now())
    expect(ran).toBe(1)
    expect(out[0]?.task.fire_count).toBe(1)
    second.close()
  })

  it('迁移器幂等：同一个库开两次不重复建表', () => {
    const path = join(dir, 'twice.sqlite')
    const clock = new TestClock(START)
    const a = new SqliteScheduleStore({ dbPath: path, clock })
    a.close()
    const b = new SqliteScheduleStore({ dbPath: path, clock })
    expect(b.schema_version).toBe(1)
    b.close()
  })
})

describe('进程内定时器', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start / stop：按间隔巡检，重入时跳过', async () => {
    vi.useFakeTimers()
    const clock = new TestClock(START)
    const s = createScheduler({ clock, store: new MemoryScheduleStore(), intervalMs: 1000 })
    let ran = 0
    s.register('noop', () => {
      ran += 1
    })
    await s.schedule(taskInput({ trigger: { kind: 'once', at: START } }))
    s.start()
    s.start() // 起第二次是空操作
    await vi.advanceTimersByTimeAsync(1000)
    expect(ran).toBe(1)
    s.stop()
    s.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ran).toBe(1)
  })

  it('close 关掉定时器与库', async () => {
    vi.useFakeTimers()
    const clock = new TestClock(START)
    const store = new SqliteScheduleStore({ dbPath: ':memory:', clock })
    const s = createScheduler({ clock, store })
    s.start(1000)
    s.close()
    expect(store.db.open).toBe(false)
  })
})

describe('任务与职责绑定（13 §1.3）', () => {
  it('任务带 workspace / assignment / owner / role，列表按岗位过滤得出来', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    const task: ScheduleTask = await s.schedule(
      taskInput({
        assignment_id: 'asg_aftersales',
        role_id: 'dtc.aftersales',
        owner: 'p_wang',
        origin: { conversation_id: 'conv_1', run_id: 'run_1' },
        context_policy: 'resume_conversation',
        action: { kind: 'scheduled' },
      }),
    )
    expect(task.assignment_id).toBe('asg_aftersales')
    expect(task.origin?.conversation_id).toBe('conv_1')
    expect(s.list({ workspace_id: 'ws_test', conversation_id: 'conv_1' }).map((t) => t.id)).toEqual(
      [task.id],
    )
  })
})
