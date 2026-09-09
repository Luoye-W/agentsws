/**
 * 契约形状进得来出得去：契约 `ScheduledTask`（`once` / `cron` / `after_event` + 五态）
 * 原样能建、能列、能触发；本包多出来的那几样（`interval` / `running` / `title` / `handler`）
 * 是**扩展**，不是替换。契约的差异写进交付报告。
 */
import type { ScheduledTask, WorkflowDef, WorkflowInstance } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createScheduler,
  createWorkflowEngine,
  type ScheduleTask,
  type WorkflowInstanceRecord,
} from '../src/index.js'
import { TestClock } from './helpers.js'

const START = '2026-09-10T00:00:00.000Z'

/** 契约那份 98 行里写的形状，逐字照抄一条。 */
const CONTRACT_TASK: Omit<ScheduledTask, 'id' | 'fire_count'> = {
  workspace_id: 'ws_test',
  owner: 'p_wang',
  role_id: 'dtc.aftersales',
  assignment_id: 'asg_1',
  origin: { conversation_id: 'conv_1', run_id: 'run_1', message_ref: 'msg_1' },
  trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
  action: { kind: 'scheduled' },
  context_policy: 'resume_conversation',
  state: 'active',
  created_by: 'agent',
  misfire_policy: 'run_once_now',
}

describe('契约一致性', () => {
  it('契约形状的 ScheduledTask 直接能建，回来的东西仍满足契约的必填字段', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    const task: ScheduleTask = await s.schedule({ ...CONTRACT_TASK, handler: 'noop' })
    // 契约必填字段一个不少
    for (const key of [
      'id',
      'workspace_id',
      'owner',
      'role_id',
      'assignment_id',
      'origin',
      'trigger',
      'action',
      'context_policy',
      'state',
      'created_by',
      'misfire_policy',
      'fire_count',
    ]) {
      expect(task).toHaveProperty(key)
    }
    // 契约五态之内
    expect(['pending', 'active', 'paused', 'done', 'failed']).toContain(task.state)
    expect(task.trigger.kind).toBe('cron')
  })

  it('契约的三种触发器都能建', async () => {
    const clock = new TestClock(START)
    const s = createScheduler({ clock })
    const once = await s.schedule({ ...CONTRACT_TASK, trigger: { kind: 'once', at: START } })
    const cron = await s.schedule({ ...CONTRACT_TASK })
    const evt = await s.schedule({
      ...CONTRACT_TASK,
      trigger: { kind: 'after_event', event: 'shipment.delivered' },
    })
    expect(once.next_fire_at).toBe(START)
    expect(cron.next_fire_at).toBe('2026-09-10T01:00:00.000Z')
    expect(evt.next_fire_at).toBeUndefined()
  })

  it('WorkflowDef / WorkflowInstance：契约形状的定义能直接跑，实例投影回契约类型', async () => {
    const clock = new TestClock(START)
    const contractDef: WorkflowDef = {
      id: 'contract.flow',
      version: '1.0.0',
      name: '契约里那份',
      role_id: 'dtc.aftersales',
      steps: [{ id: 's1', kind: 'run', params: {}, on_fail: 'skip' }],
    }
    const engine = createWorkflowEngine({ clock, handlers: { run: () => 'ok' } })
    const record: WorkflowInstanceRecord = await engine.start(
      contractDef,
      { type: 'order', id: 'o1' },
      { workspace_id: 'ws_test', conversation_id: 'conv_1' },
    )
    // 契约那份 = 本包这份去掉扩展字段
    const projected: WorkflowInstance = {
      id: record.id,
      def: record.def,
      workspace_id: record.workspace_id,
      role_id: record.role_id,
      subject: record.subject,
      state: record.state === 'cancelled' ? 'failed' : record.state,
      cursor: record.cursor,
      history: record.history.map((h) => ({ step_id: h.step_id, at: h.at, result: h.result })),
      started_at: record.started_at,
      ...(record.conversation_id === undefined ? {} : { conversation_id: record.conversation_id }),
    }
    expect(projected.state).toBe('done')
    expect(projected.history).toEqual([{ step_id: 's1', at: START, result: 'ok' }])
  })
})
