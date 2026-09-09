import { describe, expect, it } from 'vitest'
import {
  createWorkflowEngine,
  ScheduleError,
  type WorkflowDefinition,
  type WorkflowHandlers,
} from '../src/index.js'
import { recorder, TestClock } from './helpers.js'

const START = '2026-09-10T00:00:00.000Z'
const WS = { workspace_id: 'ws_test' }
const SUBJECT = { type: 'order', id: 'ord_1' } as const

const def = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id: 'test.flow',
  version: '1.0.0',
  name: '测试流程',
  role_id: 'dtc.aftersales',
  steps: [
    { id: 's1', kind: 'run', params: { what: 'a' } },
    { id: 's2', kind: 'run', params: { what: 'b' } },
  ],
  ...over,
})

const runAll = (calls: string[]): WorkflowHandlers => ({
  run: (ctx) => {
    calls.push(ctx.step.id)
    return { step: ctx.step.id }
  },
  action: (ctx) => {
    calls.push(`action:${ctx.step.id}`)
    return { applied: true }
  },
  approval: (ctx) => `apr_${ctx.step.id}`,
  humanTask: (ctx) => `todo_${ctx.step.id}`,
  branch: () => undefined,
})

describe('流程：跑完', () => {
  it('两步顺序跑完 → done，事件带 started / step.completed / done', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, eventSink: sink, handlers: runAll(calls) })
    const instance = await engine.start(def(), SUBJECT, WS)
    expect(calls).toEqual(['s1', 's2'])
    expect(instance.state).toBe('done')
    expect(instance.history.map((h) => h.step_id)).toEqual(['s1', 's2'])
    expect(instance.history.every((h) => h.outcome === 'ok')).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'workflow.started',
      'workflow.step.completed',
      'workflow.step.completed',
      'workflow.done',
    ])
  })

  it('注册过的定义可以按 id 起', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    engine.register(def())
    expect(engine.definition('test.flow')?.name).toBe('测试流程')
    const instance = await engine.start('test.flow', SUBJECT, WS)
    expect(instance.state).toBe('done')
    await expect(engine.start('没这个', SUBJECT, WS)).rejects.toThrow(ScheduleError)
  })

  it('没有步骤的定义起不了', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    await expect(engine.start(def({ steps: [] }), SUBJECT, WS)).rejects.toThrow(ScheduleError)
  })

  it('实例带定义快照：改了定义不影响已经在跑的实例', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const source = def({ steps: [{ id: 's1', kind: 'sleep', params: { days: 1 } }] })
    const instance = await engine.start(source, SUBJECT, WS)
    source.steps.push({ id: 's2', kind: 'run', params: {} })
    expect(instance.definition.steps).toHaveLength(1)
  })

  it('SLA 变成 due_at', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const instance = await engine.start(
      def({ steps: [{ id: 's1', kind: 'sleep', params: { days: 1 } }], sla: { total_days: 45 } }),
      SUBJECT,
      WS,
    )
    expect(instance.due_at).toBe('2026-10-25T00:00:00.000Z')
  })

  it('action 步骤走 action 处理器', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    await engine.start(def({ steps: [{ id: 's1', kind: 'action', params: {} }] }), SUBJECT, WS)
    expect(calls).toEqual(['action:s1'])
  })

  it('没装处理器 → not_implemented', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    const out = await engine.start(def(), SUBJECT, WS)
    expect(out.state).toBe('failed')
    expect(out.last_error).toContain('没有装')
  })

  it.each([
    ['approval', {}],
    ['human_task', {}],
    ['branch', {}],
  ])('%s 步骤没装处理器也 failed', async (kind, params) => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    const out = await engine.start(
      def({ steps: [{ id: 's1', kind: kind as 'approval', params }] }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('failed')
  })
})

describe('流程：等', () => {
  it('sleep 不占进程，tick 到点才醒', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 's1', kind: 'run', params: {} },
          { id: 'wait', kind: 'sleep', params: { days: 5 } },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(started.state).toBe('waiting')
    expect(started.waiting).toEqual({ reason: 'sleep', wake_at: '2026-09-15T00:00:00.000Z' })
    clock.advance(4 * 24 * 3600_000)
    expect(await engine.tick(clock.now())).toHaveLength(0)
    clock.advance(24 * 3600_000)
    const [woken] = await engine.tick(clock.now())
    expect(woken?.state).toBe('done')
    expect(calls).toEqual(['s1', 's2'])
  })

  it.each([
    [{ ms: 1000 }, 1000],
    [{ days: 2 }, 2 * 24 * 3600_000],
    [{ until: '2026-09-11T00:00:00.000Z' }, 24 * 3600_000],
  ])('sleep 认 ms / days / until', async (params, delta) => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    const out = await engine.start(
      def({ steps: [{ id: 's1', kind: 'sleep', params }] }),
      SUBJECT,
      WS,
    )
    expect(out.waiting?.wake_at).toBe(new Date(Date.parse(START) + delta).toISOString())
  })

  it('sleep 参数不合法 → 实例 failed', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    expect(
      (await engine.start(def({ steps: [{ id: 's1', kind: 'sleep', params: {} }] }), SUBJECT, WS))
        .state,
    ).toBe('failed')
    expect(
      (
        await engine.start(
          def({ steps: [{ id: 's1', kind: 'sleep', params: { until: 'x' } }] }),
          SUBJECT,
          WS,
        )
      ).state,
    ).toBe('failed')
  })

  it('wait_event 等到信号才往下走；等错的信号不动', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 'wait', kind: 'wait_event', params: { event: 'shipment.delivered' } },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(started.state).toBe('waiting')
    expect((await engine.signal(started.id, { type: '别的' })).state).toBe('waiting')
    const done = await engine.signal(started.id, {
      type: 'shipment.delivered',
      payload: { tracking: 'SF1' },
    })
    expect(done.state).toBe('done')
    expect(done.history[0]?.result).toEqual({ tracking: 'SF1' })
    expect(calls).toEqual(['s2'])
  })

  it('wait_event 少了 event 参数 → failed', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    const out = await engine.start(
      def({ steps: [{ id: 'w', kind: 'wait_event', params: {} }] }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('failed')
  })

  it('approval 步骤挂在审批项上，批了才继续', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 'ask', kind: 'approval', params: {} },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(started.waiting).toEqual({ reason: 'approval', approval_id: 'apr_ask' })
    // 别人的审批项决定了不影响这一条
    expect(
      (
        await engine.signal(started.id, {
          type: 'approval.decided',
          payload: { approval_id: 'apr_other', action: 'approve' },
        })
      ).state,
    ).toBe('waiting')
    const done = await engine.signal(started.id, {
      type: 'approval.decided',
      payload: { approval_id: 'apr_ask', action: 'approve' },
    })
    expect(done.state).toBe('done')
    expect(calls).toEqual(['s2'])
  })

  it('审批被驳回 = 这一步失败，按 on_fail 走', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const started = await engine.start(
      def({
        steps: [
          { id: 'ask', kind: 'approval', params: {}, on_fail: 'skip' },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    const after = await engine.signal(started.id, {
      type: 'approval.decided',
      payload: { action: 'reject' },
    })
    expect(after.state).toBe('done')
    expect(after.history.find((h) => h.step_id === 'ask')?.outcome).toBe('failed')
  })

  it('human_task 步骤等人做完', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const started = await engine.start(
      def({ steps: [{ id: 'todo', kind: 'human_task', params: {} }] }),
      SUBJECT,
      WS,
    )
    expect(started.waiting?.human_task_id).toBe('todo_todo')
    expect(
      (
        await engine.signal(started.id, {
          type: 'human_task.done',
          payload: { human_task_id: '别的' },
        })
      ).state,
    ).toBe('waiting')
    expect((await engine.signal(started.id, { type: 'human_task.done', payload: {} })).state).toBe(
      'done',
    )
  })

  it('已经结束的实例收到信号不动', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const done = await engine.start(def(), SUBJECT, WS)
    expect((await engine.signal(done.id, { type: 'x' })).state).toBe('done')
  })

  it('不在等的实例收到信号不动', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const started = await engine.start(
      def({ steps: [{ id: 's1', kind: 'sleep', params: { days: 1 } }] }),
      SUBJECT,
      WS,
    )
    const paused = await engine.pause(started.id)
    expect(paused.state).toBe('paused')
    const back = await engine.resume(started.id)
    expect(back.state).toBe('waiting')
  })

  it('找不到实例 → not_found', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock })
    await expect(engine.signal('nope', { type: 'x' })).rejects.toThrow(ScheduleError)
    await expect(engine.cancel('nope')).rejects.toThrow(ScheduleError)
    expect(await engine.status('nope')).toBeUndefined()
  })

  it('暂停 / 恢复 / 取消', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, eventSink: sink, handlers: runAll(calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 'w', kind: 'wait_event', params: { event: 'e' } },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    await engine.pause(started.id)
    await expect(engine.resume(started.id)).resolves.toMatchObject({ state: 'waiting' })
    await expect(engine.resume(started.id)).rejects.toThrow(ScheduleError)
    const cancelled = await engine.cancel(started.id)
    expect(cancelled.state).toBe('cancelled')
    expect(events.map((e) => e.type)).toContain('workflow.cancelled')
    // 取消之后信号不再推动它
    expect((await engine.signal(started.id, { type: 'e' })).state).toBe('cancelled')
  })

  it('暂停一个没在等的实例，恢复后接着跑', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 's1', kind: 'sleep', params: { ms: 1 } },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    // 手工把它扳成「没在等的暂停」：先醒过来，再暂停
    clock.advance(10)
    await engine.tick(clock.now())
    const inst = await engine.status(started.id)
    expect(inst?.state).toBe('done')
  })
})

describe('流程：失败与补救', () => {
  const failing = (fails: number, calls: string[]): WorkflowHandlers => {
    let n = 0
    return {
      run: (ctx) => {
        calls.push(`${ctx.step.id}#${ctx.attempt}`)
        if (ctx.step.id === 'flaky') {
          n += 1
          if (n <= fails) throw new Error('抖了一下')
        }
        return 'ok'
      },
      humanTask: () => 'todo_escalated',
    }
  }

  it('重试：退避后再来，成功了照常往下', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: failing(2, calls) })
    const started = await engine.start(
      def({
        steps: [
          { id: 'flaky', kind: 'run', params: {}, retry: { max: 3, backoff_ms: 1000 } },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(started.state).toBe('waiting')
    expect(started.waiting).toEqual({ reason: 'retry', wake_at: '2026-09-10T00:00:01.000Z' })
    clock.advance(1000)
    const [second] = await engine.tick(clock.now())
    // 第二次还失败：退避翻倍
    expect(second?.waiting?.wake_at).toBe('2026-09-10T00:00:03.000Z')
    clock.advance(2000)
    const [third] = await engine.tick(clock.now())
    expect(third?.state).toBe('done')
    expect(calls).toEqual(['flaky#1', 'flaky#2', 'flaky#3', 's2#1'])
  })

  it('重试用完 → failed', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: failing(99, calls) })
    let cur = await engine.start(
      def({
        steps: [{ id: 'flaky', kind: 'run', params: {}, retry: { max: 1, backoff_ms: 1000 } }],
      }),
      SUBJECT,
      WS,
    )
    clock.advance(1000)
    const [after] = await engine.tick(clock.now())
    cur = after ?? cur
    expect(cur.state).toBe('failed')
    expect(cur.last_error).toBe('抖了一下')
  })

  it('默认退避是一分钟', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: failing(99, []) })
    const out = await engine.start(
      def({ steps: [{ id: 'flaky', kind: 'run', params: {}, retry: { max: 1 } as never }] }),
      SUBJECT,
      WS,
    )
    expect(out.waiting?.wake_at).toBe('2026-09-10T00:01:00.000Z')
  })

  it('on_fail = skip：跳过这一步接着跑', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: failing(99, calls) })
    const out = await engine.start(
      def({
        steps: [
          { id: 'flaky', kind: 'run', params: {}, on_fail: 'skip' },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('done')
    expect(calls).toEqual(['flaky#1', 's2#1'])
  })

  it('on_fail = skip 且是最后一步 → done', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: failing(99, []) })
    const out = await engine.start(
      def({ steps: [{ id: 'flaky', kind: 'run', params: {}, on_fail: 'skip' }] }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('done')
  })

  it('on_fail = compensate：把跑成功的步骤倒着补偿一遍', async () => {
    const clock = new TestClock(START)
    const { sink, events } = recorder()
    const calls: string[] = []
    const engine = createWorkflowEngine({
      clock,
      eventSink: sink,
      handlers: {
        run: (ctx) => {
          calls.push(ctx.step.id)
          if (ctx.step.id === 'boom') throw new Error('样品丢了')
          if (ctx.step.id === 'undo_ship_fail') throw new Error('撤不了')
          return 'ok'
        },
      },
    })
    const out = await engine.start(
      def({
        steps: [
          { id: 'ship', kind: 'run', params: {} },
          { id: 'notify', kind: 'run', params: {} },
          { id: 'boom', kind: 'run', params: {}, on_fail: 'compensate' },
        ],
        compensation: {
          ship: { id: 'undo_ship_fail', kind: 'run', params: {} },
          notify: { id: 'undo_notify', kind: 'run', params: {} },
        },
      }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('compensated')
    // 倒序：notify 先撤，再撤 ship；撤 ship 自己也失败了，记下来但不炸
    expect(calls).toEqual(['ship', 'notify', 'boom', 'undo_notify', 'undo_ship_fail'])
    expect(out.history.filter((h) => h.outcome === 'compensated').map((h) => h.step_id)).toEqual([
      'undo_notify',
    ])
    expect(events.map((e) => e.type)).toContain('workflow.compensated')
  })

  it('on_fail = escalate：出一条待办给人（没装 human_task 处理器就报 not_implemented）', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: failing(99, []) })
    const out = await engine.start(
      def({ steps: [{ id: 'flaky', kind: 'run', params: {}, on_fail: 'escalate' }] }),
      SUBJECT,
      WS,
    )
    expect(out.waiting).toEqual({ reason: 'human_task', human_task_id: 'todo_escalated' })

    const bare = createWorkflowEngine({
      clock,
      handlers: {
        run: () => {
          throw new Error('x')
        },
      },
    })
    await expect(
      bare.start(
        def({ steps: [{ id: 'flaky', kind: 'run', params: {}, on_fail: 'escalate' }] }),
        SUBJECT,
        WS,
      ),
    ).rejects.toThrow(ScheduleError)
  })
})

describe('流程：分支与广播', () => {
  it('branch 按上一步结果选下一步', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({
      clock,
      handlers: {
        run: (ctx) => {
          calls.push(ctx.step.id)
          return 'ok'
        },
        branch: () => 'big',
      },
    })
    const out = await engine.start(
      def({
        steps: [
          { id: 'check', kind: 'branch', params: {} },
          { id: 'small', kind: 'run', params: {} },
          { id: 'big', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('done')
    expect(calls).toEqual(['big'])
  })

  it('branch 返回 undefined 就顺序往下', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock, handlers: runAll(calls) })
    const out = await engine.start(
      def({
        steps: [
          { id: 'check', kind: 'branch', params: {} },
          { id: 's2', kind: 'run', params: {} },
        ],
      }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('done')
    expect(calls).toEqual(['s2'])
  })

  it('branch 指到不存在的步骤 → failed', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({
      clock,
      handlers: { branch: () => '不存在' },
    })
    const out = await engine.start(
      def({ steps: [{ id: 'check', kind: 'branch', params: {} }] }),
      SUBJECT,
      WS,
    )
    expect(out.state).toBe('failed')
  })

  it('broadcast 只推动在等这个事件的实例', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    const waiting = await engine.start(
      def({ steps: [{ id: 'w', kind: 'wait_event', params: { event: 'e' } }] }),
      SUBJECT,
      WS,
    )
    const other = await engine.start(
      def({ id: 'other', steps: [{ id: 'w', kind: 'wait_event', params: { event: 'f' } }] }),
      SUBJECT,
      WS,
    )
    const moved = await engine.broadcast({ type: 'e' })
    expect(moved.map((i) => i.id)).toEqual([waiting.id])
    expect((await engine.status(other.id))?.state).toBe('waiting')
  })

  it('setHandlers 之后换一套处理器', async () => {
    const clock = new TestClock(START)
    const calls: string[] = []
    const engine = createWorkflowEngine({ clock })
    engine.setHandlers(runAll(calls))
    await engine.start(def(), SUBJECT, WS)
    expect(calls).toEqual(['s1', 's2'])
  })

  it('list 按工作区与定义过滤', async () => {
    const clock = new TestClock(START)
    const engine = createWorkflowEngine({ clock, handlers: runAll([]) })
    await engine.start(def(), SUBJECT, WS)
    expect(engine.list({ workspace_id: 'ws_test', def_id: 'test.flow' })).toHaveLength(1)
    expect(engine.list({ workspace_id: 'ws_other' })).toHaveLength(0)
  })
})
