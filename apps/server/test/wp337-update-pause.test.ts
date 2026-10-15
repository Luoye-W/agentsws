/**
 * WP337：点「重启并更新」时还有任务在做——暂停全部、落盘、新版开机接着做（只一次）。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 三类怎么数 | `classifyBusy` | 正在输出 = 在跑的运行；后台 = 系统巡检正在跑的；定时 = 人建 / 自动化正在跑或 15 分钟内到点的 |
 * | (b) 暂停 / 放开 | 真调度器（内存档）+ 替身运行 | 暂停：调度器拦住、运行停在安全点、落盘；放开：调度器照常、运行接着做、记录删掉 |
 * | (c) 开机接着做 | 同上，换一个「新进程」读同一个目录 | 只恢复一次；被打断的补一次；错过的 skip 补一次、run_once_now 交给调度器；没接上照实补一句 |
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import {
  createScheduler,
  MemoryScheduleStore,
  type Scheduler,
  type ScheduleStore,
} from '@agentsws/schedule'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyBusy,
  createUpdatePause,
  type LiveRun,
  RESUME_FAILED_TEXT,
  RESUME_TEXT,
  UPDATE_PAUSE_FILE,
} from '../src/update-pause.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wp337-pause-'))
  dirs.push(dir)
  return dir
}

const T0 = Date.parse('2026-10-15T10:00:00.000Z')
function mutableClock(start = T0) {
  let ms = start
  const clock: Clock = { now: () => new Date(ms).toISOString() }
  return { clock, advance: (d: number) => (ms += d), set: (v: number) => (ms = v) }
}

const BASE = {
  workspace_id: 'ws_1',
  owner: 'per_1',
  role_id: 'dtc.support',
  assignment_id: 'asg_1',
  created_by: 'user' as const,
}
const SYSTEM = new Set(['channels.mail_poll', 'backup.daily'])

const RUN: LiveRun = {
  workspace_id: 'ws_1',
  matter_id: 'mat_1',
  run_id: 'run_1',
  title: '回复客户 Anna 的退货',
  person_id: 'per_1',
  assignment_id: 'asg_1',
}

/** 一个「进程」：调度器 + 更新暂停，共用落盘目录与调度库。 */
function proc(input: {
  dir: string
  clock: Clock
  store: ScheduleStore
  runs?: LiveRun[]
  failResume?: Set<string>
}) {
  const live = [...(input.runs ?? [])]
  const paused: string[] = []
  const resumed: { run: LiveRun; brief: string; text: string }[] = []
  const notes: { matter_id: string; text: string }[] = []
  const fired: string[] = []
  let scheduler: Scheduler | undefined
  const pause = createUpdatePause({
    clock: input.clock,
    dbDir: input.dir,
    runs: () => live,
    pauseRun: async (r) => {
      paused.push(r.run_id)
      live.splice(live.indexOf(r), 1)
      return true
    },
    resumeRun: async (r, brief, text) => {
      if (input.failResume?.has(r.matter_id)) throw new Error('事项没了')
      resumed.push({ run: r, brief, text })
    },
    note: (r, text) => {
      notes.push({ matter_id: r.matter_id, text })
    },
    scheduler: () => scheduler,
    isBackground: (t) => t.handler !== undefined && SYSTEM.has(t.handler),
    settleMs: 0,
    sleep: async () => undefined,
  })
  scheduler = createScheduler({
    clock: input.clock,
    store: input.store,
    hold: () => pause.holding(),
  })
  for (const h of ['channels.mail_poll', 'backup.daily', 'automation.reminder', 'user.report'])
    scheduler.register(h, async (ctx) => {
      fired.push(ctx.task.id)
      return 'ok'
    })
  return { pause, scheduler, paused, resumed, notes, fired, live }
}

describe('WP337 (a) 三类怎么数', () => {
  it('后台只数正在跑的；定时数正在跑或 15 分钟内到点的；正在输出 = 在跑的运行', async () => {
    const { clock } = mutableClock()
    const s = createScheduler({ clock })
    const soon = await s.schedule({
      ...BASE,
      title: '每天出周报',
      handler: 'user.report',
      misfire_policy: 'run_once_now',
      trigger: { kind: 'once', at: new Date(T0 + 10 * 60_000).toISOString() },
    })
    await s.schedule({
      ...BASE,
      title: '下周再说',
      handler: 'user.report',
      misfire_policy: 'run_once_now',
      trigger: { kind: 'once', at: new Date(T0 + 3 * 3600_000).toISOString() },
    })
    await s.schedule({
      ...BASE,
      title: '收信',
      handler: 'channels.mail_poll',
      misfire_policy: 'skip',
      trigger: { kind: 'interval', every_ms: 120_000 },
    })
    const tasks = s.list({ workspace_id: 'ws_1' })
    const quiet = classifyBusy({
      runs: [RUN],
      tasks,
      nowMs: T0,
      isBackground: (t) => t.handler === 'channels.mail_poll',
    })
    expect(quiet.counts).toEqual({ output: 1, background: 0, scheduled: 1 })
    expect(quiet.items).toEqual([
      { kind: 'output', title: '回复客户 Anna 的退货' },
      { kind: 'scheduled', title: '每天出周报' },
    ])
    // 收信正在跑：算后台
    const mail = tasks.find((t) => t.title === '收信')
    if (mail === undefined) throw new Error('没建出来')
    const busy = classifyBusy({
      runs: [],
      tasks: tasks.map((t) =>
        t.id === mail.id
          ? {
              ...t,
              state: 'running' as const,
              lease: { holder: 'x', until: new Date(T0 + 60_000).toISOString() },
            }
          : t,
      ),
      nowMs: T0,
      isBackground: (t) => t.handler === 'channels.mail_poll',
    })
    expect(busy.counts).toEqual({ output: 0, background: 1, scheduled: 1 })
    expect(soon.title).toBe('每天出周报')
  })
})

describe('WP337 (b) 暂停 / 放开（没重启成）', () => {
  it('暂停：调度器拦住、运行停在安全点、落盘；放开：照常触发、运行接着做、记录删掉', async () => {
    const dir = tempDir()
    const c = mutableClock()
    const store = new MemoryScheduleStore()
    const p = proc({ dir, clock: c.clock, store, runs: [RUN] })
    const due = await p.scheduler.schedule({
      ...BASE,
      title: '到点提醒',
      handler: 'automation.reminder',
      misfire_policy: 'run_once_now',
      trigger: { kind: 'once', at: new Date(T0 + 60_000).toISOString() },
    })
    expect(p.pause.readiness()).toMatchObject({
      idle: false,
      paused: false,
      counts: { output: 1, background: 0, scheduled: 1 },
    })
    const out = await p.pause.pause({ to: '0.2.2' })
    expect(out.paused).toEqual({ output: 1, background: 0, scheduled: 1 })
    expect(p.paused).toEqual(['run_1'])
    expect(p.pause.readiness()).toMatchObject({ idle: true, paused: true })
    const file = join(dir, UPDATE_PAUSE_FILE)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { runs: LiveRun[]; to: string }
    expect(saved.runs.map((r) => r.matter_id)).toEqual(['mat_1'])
    expect(saved.to).toBe('0.2.2')
    // 暂停着：到点了也不触发、不挪排期
    c.advance(2 * 60_000)
    await p.scheduler.runDue(c.clock.now())
    expect(p.fired).toEqual([])
    expect(p.scheduler.get(due.id)?.next_fire_at).toBe(new Date(T0 + 60_000).toISOString())
    // 没重启成：放开
    const back = await p.pause.resume()
    expect(back).toMatchObject({ runs: 1, failed: 0 })
    expect(p.resumed.map((r) => [r.run.matter_id, r.text])).toEqual([['mat_1', RESUME_TEXT]])
    expect(existsSync(file)).toBe(false)
    await p.scheduler.runDue(c.clock.now())
    expect(p.fired).toEqual([due.id])
    expect(p.pause.readiness().paused).toBe(false)
  })

  it('等空闲时又来一件：再暂停一次只补新的那件（同一件不记两遍）', async () => {
    const dir = tempDir()
    const c = mutableClock()
    const p = proc({ dir, clock: c.clock, store: new MemoryScheduleStore(), runs: [RUN] })
    await p.pause.pause()
    p.live.push({ ...RUN, run_id: 'run_2', matter_id: 'mat_2', title: '第二件' })
    await p.pause.pause()
    const saved = JSON.parse(readFileSync(join(dir, UPDATE_PAUSE_FILE), 'utf8')) as {
      runs: LiveRun[]
    }
    expect(saved.runs.map((r) => r.run_id)).toEqual(['run_1', 'run_2'])
  })
})

describe('WP337 (c) 新版开机接着做', () => {
  it('只恢复一次；运行接着做；被打断的补一次；错过的 skip 补一次、run_once_now 交给调度器', async () => {
    const dir = tempDir()
    const c = mutableClock()
    const store = new MemoryScheduleStore()
    const old = proc({ dir, clock: c.clock, store, runs: [RUN] })
    const backup = await old.scheduler.schedule({
      ...BASE,
      title: '每天备份',
      handler: 'backup.daily',
      misfire_policy: 'skip',
      trigger: { kind: 'once', at: new Date(T0 + 60_000).toISOString() },
    })
    const remind = await old.scheduler.schedule({
      ...BASE,
      title: '到点提醒',
      handler: 'automation.reminder',
      misfire_policy: 'run_once_now',
      trigger: { kind: 'once', at: new Date(T0 + 90_000).toISOString() },
    })
    const mail = await old.scheduler.schedule({
      ...BASE,
      title: '收信',
      handler: 'channels.mail_poll',
      misfire_policy: 'skip',
      trigger: { kind: 'interval', every_ms: 3600_000 },
    })
    // 收信正在跑、没等到收尾（上一版的租约还在）
    const m = store.getTask(mail.id)
    if (m === undefined) throw new Error('没建出来')
    store.putTask({
      ...m,
      state: 'running',
      lease: { holder: 'scheduler', until: new Date(T0 + 5 * 60_000).toISOString() },
    })
    await old.pause.pause({ to: '0.2.2' })
    // 新版 10 分钟后才起来（Mac 上人自己装）
    c.advance(10 * 60_000)
    const neu = proc({ dir, clock: c.clock, store })
    const boot = neu.pause.boot()
    expect(boot).toBeDefined()
    expect(existsSync(join(dir, UPDATE_PAUSE_FILE))).toBe(false)
    const summary = await boot?.finish()
    expect(summary).toMatchObject({ runs: 1, failed: 0, reran: 1, caught_up: 2 })
    expect(neu.resumed.map((r) => r.run.matter_id)).toEqual(['mat_1'])
    await new Promise((r) => setTimeout(r, 0))
    // 被打断的收信补一次、错过的备份（skip）补一次；提醒（run_once_now）等调度器第一拍
    expect(neu.fired.sort()).toEqual([backup.id, mail.id].sort())
    await neu.scheduler.runDue(c.clock.now())
    expect(neu.fired).toContain(remind.id)
    expect(neu.fired.filter((id) => id === backup.id)).toHaveLength(1)
    expect(neu.pause.readiness().last_resume).toMatchObject({ runs: 1 })
    // 再开一次机：没有记录了，不会再恢复一遍
    expect(proc({ dir, clock: c.clock, store }).pause.boot()).toBeUndefined()
  })

  it('事项没了：照实补一句，不算接上', async () => {
    const dir = tempDir()
    const c = mutableClock()
    const store = new MemoryScheduleStore()
    await proc({ dir, clock: c.clock, store, runs: [RUN] }).pause.pause()
    const neu = proc({ dir, clock: c.clock, store, failResume: new Set(['mat_1']) })
    const summary = await neu.pause.boot()?.finish()
    expect(summary).toMatchObject({ runs: 0, failed: 1 })
    expect(neu.notes).toEqual([{ matter_id: 'mat_1', text: RESUME_FAILED_TEXT }])
  })

  it('记录坏了：跳过、删掉，不挡开机', async () => {
    const dir = tempDir()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, UPDATE_PAUSE_FILE), '{坏的')
    const c = mutableClock()
    expect(proc({ dir, clock: c.clock, store: new MemoryScheduleStore() }).pause.boot()).toBe(
      undefined,
    )
    expect(existsSync(join(dir, UPDATE_PAUSE_FILE))).toBe(false)
  })
})
