/**
 * WP181：`rule` 触发器——官方「自动化任务」的时间规则。本包不认识它的内容，
 * 第一次与下一次都交给注入的解析器；没注入就拒建（不猜时间）。
 */
import { describe, expect, it } from 'vitest'
import {
  createScheduler,
  firstFireAt,
  nextFireAfter,
  type RuleResolver,
  ScheduleError,
  SqliteScheduleStore,
} from '../src/index.js'
import { recorder, TestClock, taskInput } from './helpers.js'

const START = '2026-09-10T00:00:00.000Z'
const HOUR = 3_600_000

/** 测试用的解析器：每整点一次（第一次 = 下一个整点）。 */
const hourly: RuleResolver = {
  first: (_rule, nowMs) => new Date((Math.floor(nowMs / HOUR) + 1) * HOUR).toISOString(),
  next: (_rule, afterMs) => new Date((Math.floor(afterMs / HOUR) + 1) * HOUR).toISOString(),
}

describe('rule 触发器', () => {
  const rule = { kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' }

  it('没接解析器：算不出时间就拒（纯函数与调度器两处）', async () => {
    const now = Date.parse(START)
    expect(() => firstFireAt({ kind: 'rule', rule }, now)).toThrow(ScheduleError)
    expect(() => nextFireAfter({ kind: 'rule', rule }, now)).toThrow(ScheduleError)
    const s = createScheduler({ clock: new TestClock(START) })
    await expect(s.schedule(taskInput({ trigger: { kind: 'rule', rule } }))).rejects.toThrow(
      /规则解析器/,
    )
  })

  it('接了解析器：第一次、触发后的下一次都照它算，规则原样落盘', async () => {
    const clock = new TestClock(START)
    const store = new SqliteScheduleStore({ dbPath: ':memory:', clock })
    const { sink, events } = recorder()
    const s = createScheduler({ clock, store, eventSink: sink, rules: hourly })
    s.register('noop', () => 'ok')
    const task = await s.schedule(taskInput({ handler: 'noop', trigger: { kind: 'rule', rule } }))
    expect(task.next_fire_at).toBe('2026-09-10T01:00:00.000Z')
    expect(store.getTask(task.id)?.trigger).toEqual({ kind: 'rule', rule })

    clock.set('2026-09-10T01:00:00.000Z')
    const [out] = await s.runDue(clock.now())
    expect(out?.ok).toBe(true)
    expect(out?.task.next_fire_at).toBe('2026-09-10T02:00:00.000Z')
    expect(out?.task.state).toBe('active')
    expect(events.map((e) => e.type)).toContain('schedule.fired')
  })

  it('改规则：按新规则重算第一次', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock, rules: hourly })
    const task = await s.schedule(
      taskInput({ trigger: { kind: 'once', at: '2026-09-12T00:00:00.000Z' } }),
    )
    clock.advance(30 * 60_000)
    const updated = await s.update(task.id, { trigger: { kind: 'rule', rule } })
    expect(updated.next_fire_at).toBe('2026-09-10T01:00:00.000Z')
  })
})
