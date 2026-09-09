/**
 * 存储的契约一致性套件：内存档与 SQLite 档各跑一遍，逐字一致（照 `@agentsws/txn` 的做法）。
 */
import { describe, expect, it } from 'vitest'
import type { ScheduleStore, ScheduleTask, WorkflowInstanceRecord } from '../src/index.js'

const task = (over: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id: 'sched_a',
  workspace_id: 'ws1',
  owner: 'p1',
  role_id: 'r1',
  assignment_id: 'asg1',
  trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
  state: 'active',
  created_by: 'user',
  misfire_policy: 'run_once_now',
  fire_count: 0,
  created_at: '2026-09-10T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
  next_fire_at: '2026-09-10T08:00:00.000Z',
  handler: 'h1',
  ...over,
})

const instance = (over: Partial<WorkflowInstanceRecord> = {}): WorkflowInstanceRecord => ({
  id: 'wf_a',
  def: { id: 'creator.collab', version: '1' },
  workspace_id: 'ws1',
  role_id: 'r1',
  subject: { type: 'creator', id: 'c1' },
  state: 'running',
  cursor: 's1',
  history: [],
  started_at: '2026-09-10T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
  attempts: {},
  definition: {
    id: 'creator.collab',
    version: '1',
    name: '红人合作',
    role_id: 'r1',
    steps: [{ id: 's1', kind: 'run', params: {} }],
  },
  ...over,
})

export function runStoreConformance(name: string, make: () => ScheduleStore): void {
  describe(`ScheduleStore 一致性 · ${name}`, () => {
    it('存 → 取 → 改 → 删', () => {
      const store = make()
      store.putTask(task())
      expect(store.getTask('sched_a')?.state).toBe('active')
      store.putTask(task({ state: 'paused' }))
      expect(store.getTask('sched_a')?.state).toBe('paused')
      expect(store.listTasks({ workspace_id: 'ws1' })).toHaveLength(1)
      store.deleteTask('sched_a')
      expect(store.getTask('sched_a')).toBeUndefined()
      expect(store.getTask('nope')).toBeUndefined()
      store.close?.()
    })

    it('按工作区隔离：别的工作区的任务看不见', () => {
      const store = make()
      store.putTask(task({ id: 'sched_a', workspace_id: 'ws1' }))
      store.putTask(task({ id: 'sched_b', workspace_id: 'ws2' }))
      expect(store.listTasks({ workspace_id: 'ws1' }).map((t) => t.id)).toEqual(['sched_a'])
      expect(store.workspaces()).toEqual(['ws1', 'ws2'])
      store.close?.()
    })

    it('过滤：owner / role / assignment / conversation / handler / state', () => {
      const store = make()
      store.putTask(
        task({
          id: 'sched_a',
          owner: 'p1',
          role_id: 'r1',
          assignment_id: 'asg1',
          handler: 'h1',
          origin: { conversation_id: 'conv1' },
        }),
      )
      store.putTask(
        task({
          id: 'sched_b',
          owner: 'p2',
          role_id: 'r2',
          assignment_id: 'asg2',
          handler: 'h2',
          state: 'paused',
          origin: { conversation_id: 'conv2' },
        }),
      )
      const ws = { workspace_id: 'ws1' } as const
      expect(store.listTasks({ ...ws, owner: 'p2' }).map((t) => t.id)).toEqual(['sched_b'])
      expect(store.listTasks({ ...ws, role_id: 'r1' }).map((t) => t.id)).toEqual(['sched_a'])
      expect(store.listTasks({ ...ws, assignment_id: 'asg2' }).map((t) => t.id)).toEqual([
        'sched_b',
      ])
      expect(store.listTasks({ ...ws, conversation_id: 'conv1' }).map((t) => t.id)).toEqual([
        'sched_a',
      ])
      expect(store.listTasks({ ...ws, handler: 'h2' }).map((t) => t.id)).toEqual(['sched_b'])
      expect(store.listTasks({ ...ws, state: ['paused'] }).map((t) => t.id)).toEqual(['sched_b'])
      store.close?.()
    })

    it('dueTasks：跨工作区、按时间排、只回排队中的三态', () => {
      const store = make()
      store.putTask(
        task({ id: 'sched_b', workspace_id: 'ws2', next_fire_at: '2026-09-10T07:00:00.000Z' }),
      )
      store.putTask(task({ id: 'sched_a', next_fire_at: '2026-09-10T08:00:00.000Z' }))
      store.putTask(
        task({ id: 'sched_c', state: 'paused', next_fire_at: '2026-09-10T06:00:00.000Z' }),
      )
      store.putTask(task({ id: 'sched_d', next_fire_at: undefined }))
      expect(store.dueTasks('2026-09-10T09:00:00.000Z').map((t) => t.id)).toEqual([
        'sched_b',
        'sched_a',
      ])
      expect(store.dueTasks('2026-09-10T07:30:00.000Z').map((t) => t.id)).toEqual(['sched_b'])
      store.close?.()
    })

    it('流程实例：存取、按定义 / 状态 / subject / 会话过滤', () => {
      const store = make()
      store.putInstance(instance())
      store.putInstance(
        instance({
          id: 'wf_b',
          state: 'waiting',
          subject: { type: 'order', id: 'o1' },
          conversation_id: 'conv1',
          waiting: { reason: 'sleep', wake_at: '2026-09-15T00:00:00.000Z' },
        }),
      )
      expect(store.getInstance('wf_a')?.cursor).toBe('s1')
      expect(store.getInstance('nope')).toBeUndefined()
      const ws = { workspace_id: 'ws1' } as const
      expect(store.listInstances(ws)).toHaveLength(2)
      expect(store.listInstances({ ...ws, state: ['waiting'] }).map((i) => i.id)).toEqual(['wf_b'])
      expect(store.listInstances({ ...ws, def_id: 'nope' })).toHaveLength(0)
      expect(
        store.listInstances({ ...ws, subject: { type: 'order', id: 'o1' } }).map((i) => i.id),
      ).toEqual(['wf_b'])
      expect(store.listInstances({ ...ws, conversation_id: 'conv1' }).map((i) => i.id)).toEqual([
        'wf_b',
      ])
      expect(store.listInstances({ workspace_id: 'ws9' })).toHaveLength(0)
      store.close?.()
    })

    it('wakeableInstances / waitingInstances', () => {
      const store = make()
      store.putInstance(
        instance({
          id: 'wf_sleep',
          state: 'waiting',
          waiting: { reason: 'sleep', wake_at: '2026-09-15T00:00:00.000Z' },
        }),
      )
      store.putInstance(
        instance({
          id: 'wf_event',
          state: 'waiting',
          waiting: { reason: 'event', event: 'inbound.reply' },
        }),
      )
      store.putInstance(instance({ id: 'wf_run' }))
      expect(store.wakeableInstances('2026-09-14T00:00:00.000Z')).toHaveLength(0)
      expect(store.wakeableInstances('2026-09-15T00:00:01.000Z').map((i) => i.id)).toEqual([
        'wf_sleep',
      ])
      expect(store.waitingInstances().map((i) => i.id)).toEqual(['wf_event', 'wf_run', 'wf_sleep'])
      store.close?.()
    })

    it('拿出来的是副本：改了手里的不影响库里的', () => {
      const store = make()
      store.putTask(task())
      const got = store.getTask('sched_a')
      expect(got).toBeDefined()
      if (got !== undefined) got.state = 'cancelled'
      expect(store.getTask('sched_a')?.state).toBe('active')
      store.close?.()
    })
  })
}
