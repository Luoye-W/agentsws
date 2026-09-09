/**
 * 25 §6 一致性用例，逐条对照。每个 `it` 的名字就是规范里那一条。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createScheduler,
  createWorkflowEngine,
  decideScheduleApproval,
  SqliteScheduleStore,
  type WorkflowDefinition,
  type WorkflowHandlers,
} from '../src/index.js'
import { recorder, TestClock, taskInput } from './helpers.js'

const START = '2026-09-10T00:00:00.000Z'
const WS = { workspace_id: 'ws_test' }
const DAY = 24 * 3600_000

/** 25 §1 首批流程定义之一：邮件序列（Day0 / 2 / 5 / 8 / 12，任一回复即停）。 */
const EMAIL_SEQUENCE: WorkflowDefinition = {
  id: 'email.sequence',
  version: '1.0.0',
  name: '邮件序列',
  role_id: 'dtc.sales',
  stop_on: ['inbound.reply'],
  steps: [
    { id: 'day0', kind: 'run', params: { template: 'day0' } },
    { id: 'wait2', kind: 'sleep', params: { days: 2 } },
    { id: 'day2', kind: 'run', params: { template: 'day2' } },
    { id: 'wait5', kind: 'sleep', params: { days: 3 } },
    { id: 'day5', kind: 'run', params: { template: 'day5' } },
  ],
}

/** 25 §1 首批流程定义之一：红人合作。 */
const CREATOR_COLLAB: WorkflowDefinition = {
  id: 'creator.collab',
  version: '1.0.0',
  name: '红人合作',
  role_id: 'dtc.creator',
  sla: { total_days: 60 },
  steps: [
    { id: 'ship_sample', kind: 'run', params: {} },
    {
      id: 'await_delivery',
      kind: 'wait_event',
      params: { event: 'shipment.delivered', timeout_days: 10 },
    },
    { id: 'remind', kind: 'run', params: {} },
    {
      id: 'await_publish',
      kind: 'wait_event',
      params: { event: 'content.published', timeout_days: 21 },
    },
    { id: 'check_content', kind: 'run', params: {} },
    { id: 'settle', kind: 'action', params: {} },
    { id: 'wait_revisit', kind: 'sleep', params: { days: 15 } },
    { id: 'revisit', kind: 'run', params: {} },
  ],
  compensation: {
    ship_sample: { id: 'reship', kind: 'run', params: {} },
  },
}

const handlersRecording = (
  calls: { id: string; at: string }[],
  clock: TestClock,
): WorkflowHandlers => ({
  run: (ctx) => {
    calls.push({ id: ctx.step.id, at: clock.now() })
    return { step: ctx.step.id }
  },
  action: (ctx) => {
    calls.push({ id: ctx.step.id, at: clock.now() })
    return { applied: true }
  },
  humanTask: (ctx) => `todo_${ctx.step.id}`,
})

describe('25 §6 一致性用例', () => {
  it('① 邮件序列第 3 天客户回信 → 实例 waiting→done，后续步骤不再发', async () => {
    const clock = new TestClock(START)
    const calls: { id: string; at: string }[] = []
    const engine = createWorkflowEngine({ clock, handlers: handlersRecording(calls, clock) })
    let instance = await engine.start(EMAIL_SEQUENCE, { type: 'thread', id: 'thr_1' }, WS)
    // Day0 发出去了，然后睡两天
    expect(calls.map((c) => c.id)).toEqual(['day0'])
    expect(instance.state).toBe('waiting')

    clock.advance(2 * DAY)
    await engine.tick(clock.now())
    expect(calls.map((c) => c.id)).toEqual(['day0', 'day2'])

    // 第 3 天客户回信
    clock.advance(DAY)
    const [after] = await engine.broadcast({ type: 'inbound.reply', payload: { from: 'anna' } })
    instance = after ?? instance
    expect(instance.state).toBe('done')

    // 再怎么推时间，day5 都不会发出去
    clock.advance(10 * DAY)
    await engine.tick(clock.now())
    expect(calls.map((c) => c.id)).toEqual(['day0', 'day2'])
  })

  describe('② 进程重启后 sleep 5 天的实例按原时间继续', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agentsws-wf-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('重启后 wake_at 不变，到点接着跑', async () => {
      const path = join(dir, 'schedule.sqlite')
      const clock = new TestClock(START)
      const store = new SqliteScheduleStore({ dbPath: path, clock })
      const calls: { id: string; at: string }[] = []
      const first = createWorkflowEngine({
        clock,
        store,
        handlers: handlersRecording(calls, clock),
      })
      const def: WorkflowDefinition = {
        id: 'sleepy',
        version: '1',
        name: '睡五天',
        role_id: 'r',
        steps: [
          { id: 'before', kind: 'run', params: {} },
          { id: 'nap', kind: 'sleep', params: { days: 5 } },
          { id: 'after', kind: 'run', params: {} },
        ],
      }
      const started = await first.start(def, { type: 'order', id: 'o1' }, WS)
      expect(started.waiting?.wake_at).toBe('2026-09-15T00:00:00.000Z')
      store.close()

      // ── 重启：新引擎、新库句柄、同一个文件
      const clock2 = new TestClock('2026-09-14T00:00:00.000Z')
      const store2 = new SqliteScheduleStore({ dbPath: path, clock: clock2 })
      const calls2: { id: string; at: string }[] = []
      const second = createWorkflowEngine({
        clock: clock2,
        store: store2,
        handlers: handlersRecording(calls2, clock2),
      })
      const reloaded = await second.status(started.id)
      expect(reloaded?.state).toBe('waiting')
      // 原时间：不因为重启提前也不推迟
      expect(reloaded?.waiting?.wake_at).toBe('2026-09-15T00:00:00.000Z')
      expect(await second.tick(clock2.now())).toHaveLength(0)
      clock2.advance(DAY)
      const [woken] = await second.tick(clock2.now())
      expect(woken?.state).toBe('done')
      expect(calls2.map((c) => c.id)).toEqual(['after'])
      store2.close()
    })
  })

  it('③ wait_event 超时 → 走 on_fail=escalate 生成 human_task', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const calls: { id: string; at: string }[] = []
    const engine = createWorkflowEngine({
      clock,
      eventSink: sink,
      handlers: handlersRecording(calls, clock),
    })
    const def: WorkflowDefinition = {
      id: 'creator.ship',
      version: '1',
      name: '寄样等签收',
      role_id: 'r',
      steps: [
        { id: 'ship', kind: 'run', params: {} },
        {
          id: 'await_delivery',
          kind: 'wait_event',
          params: { event: 'shipment.delivered', timeout_days: 10 },
          on_fail: 'escalate',
        },
        { id: 'remind', kind: 'run', params: {} },
      ],
    }
    const started = await engine.start(def, { type: 'creator', id: 'cr_1' }, WS)
    expect(started.waiting?.timeout_at).toBe('2026-09-20T00:00:00.000Z')

    clock.advance(9 * DAY)
    expect(await engine.tick(clock.now())).toHaveLength(0)
    clock.advance(2 * DAY)
    const [escalated] = await engine.tick(clock.now())
    expect(escalated?.state).toBe('waiting')
    expect(escalated?.waiting).toEqual({
      reason: 'human_task',
      human_task_id: 'todo_await_delivery',
    })
    expect(escalated?.last_error).toContain('超时')
    expect(events.map((e) => e.type)).toContain('workflow.step.failed')

    // 人做完那条待办，流程接着往下
    const done = await engine.signal(started.id, { type: 'human_task.done' })
    expect(done.state).toBe('done')
    expect(calls.map((c) => c.id)).toEqual(['ship', 'remind'])
  })

  describe('④ Agent 建定时：只读直接 active + 对话卡；会发的走审批项', () => {
    it('「每天 9 点发日报」（只读）→ 直接 active', async () => {
      const decision = decideScheduleApproval({ created_by: 'agent', effect: 'read_only' })
      expect(decision).toMatchObject({ needs_approval: false, state: 'active' })

      const clock = new TestClock(START)
      const { sink, events } = recorder()
      const s = createScheduler({ clock, eventSink: sink })
      const task = await s.schedule(
        taskInput({
          created_by: 'agent',
          state: decision.state,
          title: '每天 9 点发日报',
          trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
          origin: { conversation_id: 'conv_1', run_id: 'run_1' },
        }),
      )
      expect(task.state).toBe('active')
      expect(task.approval).toBeUndefined()
      // 对话卡：事件带 conversation 与标题，宿主据此出卡
      expect(events[0]?.payload).toMatchObject({ title: '每天 9 点发日报', created_by: 'agent' })
    })

    it('「每周一给客户发跟进」（会发）→ pending，挂审批项', async () => {
      const decision = decideScheduleApproval({ created_by: 'agent', effect: 'sends' })
      expect(decision).toMatchObject({ needs_approval: true, state: 'pending' })

      const clock = new TestClock(START)
      const s = createScheduler({ clock })
      const task = await s.schedule(
        taskInput({
          created_by: 'agent',
          state: decision.state,
          approval: 'apr_1',
          title: '每周一给客户发跟进',
          trigger: { kind: 'cron', expr: '0 9 * * 1', tz: 'Asia/Shanghai' },
        }),
      )
      expect(task.state).toBe('pending')
      expect(task.approval).toBe('apr_1')
    })

    it('会写的也走审批；人给自己岗位建的直接生效，给别人建的走审批（25 §5）', () => {
      expect(decideScheduleApproval({ created_by: 'agent', effect: 'writes' })).toMatchObject({
        needs_approval: true,
      })
      expect(decideScheduleApproval({ created_by: 'user', effect: 'sends' })).toMatchObject({
        needs_approval: false,
        state: 'active',
      })
      expect(
        decideScheduleApproval({ created_by: 'user', effect: 'sends', own_assignment: false }),
      ).toMatchObject({ needs_approval: true, state: 'pending' })
    })
  })

  it('⑤ 合成时钟快进 30 天 → 红人流程全部步骤按序发生，事件时间戳单调', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const calls: { id: string; at: string }[] = []
    const engine = createWorkflowEngine({
      clock,
      eventSink: sink,
      handlers: handlersRecording(calls, clock),
    })
    const instance = await engine.start(CREATOR_COLLAB, { type: 'creator', id: 'cr_1' }, WS)
    expect(instance.due_at).toBe('2026-11-09T00:00:00.000Z')

    // 30 天，一天一拍；第 2 天签收、第 12 天发布
    for (let day = 1; day <= 30; day += 1) {
      clock.advance(DAY)
      if (day === 2) await engine.broadcast({ type: 'shipment.delivered' })
      if (day === 12) await engine.broadcast({ type: 'content.published' })
      await engine.tick(clock.now())
    }

    const final = await engine.status(instance.id)
    expect(final?.state).toBe('done')
    expect(calls.map((c) => c.id)).toEqual([
      'ship_sample',
      'remind',
      'check_content',
      'settle',
      'revisit',
    ])
    // 事件时间戳单调不减（26 §6 / 25 §6.5）
    const times = events.map((e) => Date.parse(e.at))
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] ?? 0).toBeGreaterThanOrEqual(times[i - 1] ?? 0)
    }
    // 步骤记录也按序
    expect(final?.history.map((h) => h.step_id)).toEqual([
      'ship_sample',
      'await_delivery',
      'remind',
      'await_publish',
      'check_content',
      'settle',
      'wait_revisit',
      'revisit',
    ])
  })

  it('⑥ 关机错过触发 → 开机后立即补跑一次并记 misfired', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const s = createScheduler({ clock, eventSink: sink })
    let ran = 0
    s.register('daily_plan', () => {
      ran += 1
    })
    await s.schedule(
      taskInput({
        handler: 'daily_plan',
        title: '每日计划',
        trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
        misfire_policy: 'run_once_now',
      }),
    )
    // 机器关了三天再开
    clock.set('2026-09-13T10:00:00.000Z')
    const out = await s.runDue(clock.now())
    expect(ran).toBe(1) // 补跑「一次」，不是三次
    expect(out[0]?.misfired).toBe(true)
    const misfiredEvent = events.find((e) => e.type === 'schedule.misfired')
    expect(misfiredEvent?.payload).toMatchObject({
      policy: 'run_once_now',
      missed_at: '2026-09-10T08:00:00.000Z',
    })
    expect(out[0]?.task.next_fire_at).toBe('2026-09-14T08:00:00.000Z')
  })

  it('⑦ 对话归档提示含其定时任务数', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    const conv = 'conv_anna'
    await s.schedule(taskInput({ origin: { conversation_id: conv }, title: '追踪退款到账' }))
    await s.schedule(taskInput({ origin: { conversation_id: conv }, title: '三天后回访' }))
    const other = await s.schedule(taskInput({ origin: { conversation_id: 'conv_别的' } }))

    const live = s.list({
      workspace_id: 'ws_test',
      conversation_id: conv,
      state: ['pending', 'active', 'paused', 'running'],
    })
    expect(live).toHaveLength(2)
    expect(live.map((t) => t.title)).toEqual(['追踪退款到账', '三天后回访'])

    // 「一并停掉」= 逐条 cancel；停完这条对话就没有活着的定时了
    for (const task of live) await s.cancel(task.id)
    expect(
      s.list({
        workspace_id: 'ws_test',
        conversation_id: conv,
        state: ['pending', 'active', 'paused', 'running'],
      }),
    ).toHaveLength(0)
    // 别的对话的定时任务没受影响
    expect(s.get(other.id)?.state).toBe('active')
  })
})
