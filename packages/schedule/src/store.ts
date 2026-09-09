/**
 * 内存档（测试、模拟回路、没给数据目录的一次性进程）。
 * 与 SQLite 档共用一份一致性套件（`test/store-conformance.ts`）。
 */
import type {
  ScheduleFilter,
  ScheduleStore,
  ScheduleTask,
  WorkflowFilter,
  WorkflowInstanceRecord,
} from './types.js'

/** 存进去与拿出来都拷贝一份：调用方改了自己手里那份，不该改到库里。 */
const clone = <T>(v: T): T => structuredClone(v)

export function matchTask(task: ScheduleTask, filter: ScheduleFilter): boolean {
  if (task.workspace_id !== filter.workspace_id) return false
  if (filter.owner !== undefined && task.owner !== filter.owner) return false
  if (filter.role_id !== undefined && task.role_id !== filter.role_id) return false
  if (filter.assignment_id !== undefined && task.assignment_id !== filter.assignment_id)
    return false
  if (
    filter.conversation_id !== undefined &&
    task.origin?.conversation_id !== filter.conversation_id
  ) {
    return false
  }
  if (filter.handler !== undefined && task.handler !== filter.handler) return false
  if (filter.state !== undefined && !filter.state.includes(task.state)) return false
  return true
}

export function matchInstance(instance: WorkflowInstanceRecord, filter: WorkflowFilter): boolean {
  if (instance.workspace_id !== filter.workspace_id) return false
  if (filter.def_id !== undefined && instance.def.id !== filter.def_id) return false
  if (filter.state !== undefined && !filter.state.includes(instance.state)) return false
  if (filter.conversation_id !== undefined && instance.conversation_id !== filter.conversation_id) {
    return false
  }
  if (filter.subject !== undefined) {
    if (
      instance.subject.type !== filter.subject.type ||
      instance.subject.id !== filter.subject.id
    ) {
      return false
    }
  }
  return true
}

/** id 是 ulid 风格的前缀 id，字典序即建立顺序 —— 列表按它排，重启前后一个样。 */
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** 调度循环看得见的三态；`done` / `failed` / `paused` / `cancelled` 不再排队。 */
export const RUNNABLE_STATES: readonly ScheduleTask['state'][] = ['pending', 'active', 'running']

export function isDue(task: ScheduleTask, before: string): boolean {
  if (!RUNNABLE_STATES.includes(task.state)) return false
  if (task.next_fire_at === undefined) return false
  return Date.parse(task.next_fire_at) <= Date.parse(before)
}

/** 该醒了：`sleep` / 重试退避到点，或 `wait_event` 超时。 */
export function isWakeable(instance: WorkflowInstanceRecord, before: string): boolean {
  if (instance.state !== 'waiting') return false
  const w = instance.waiting
  if (w === undefined) return false
  const at = w.wake_at ?? w.timeout_at
  if (at === undefined) return false
  return Date.parse(at) <= Date.parse(before)
}

/** 先到先跑；同一时刻按 id（重放两次顺序一样）。 */
const byDue = (a: ScheduleTask, b: ScheduleTask): number => {
  const d = Date.parse(a.next_fire_at ?? '') - Date.parse(b.next_fire_at ?? '')
  return d === 0 ? byId(a, b) : d
}

export class MemoryScheduleStore implements ScheduleStore {
  private readonly tasks = new Map<string, ScheduleTask>()
  private readonly instances = new Map<string, WorkflowInstanceRecord>()

  putTask(task: ScheduleTask): void {
    this.tasks.set(task.id, clone(task))
  }

  getTask(id: string): ScheduleTask | undefined {
    const found = this.tasks.get(id)
    return found === undefined ? undefined : clone(found)
  }

  listTasks(filter: ScheduleFilter): ScheduleTask[] {
    return [...this.tasks.values()]
      .filter((t) => matchTask(t, filter))
      .sort(byId)
      .map((t) => clone(t))
  }

  dueTasks(before: string): ScheduleTask[] {
    return [...this.tasks.values()]
      .filter((t) => isDue(t, before))
      .sort(byDue)
      .map((t) => clone(t))
  }

  workspaces(): string[] {
    return [...new Set([...this.tasks.values()].map((t) => t.workspace_id))].sort()
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
  }

  putInstance(instance: WorkflowInstanceRecord): void {
    this.instances.set(instance.id, clone(instance))
  }

  getInstance(id: string): WorkflowInstanceRecord | undefined {
    const found = this.instances.get(id)
    return found === undefined ? undefined : clone(found)
  }

  listInstances(filter: WorkflowFilter): WorkflowInstanceRecord[] {
    return [...this.instances.values()]
      .filter((i) => matchInstance(i, filter))
      .sort(byId)
      .map((i) => clone(i))
  }

  wakeableInstances(before: string): WorkflowInstanceRecord[] {
    return [...this.instances.values()]
      .filter((i) => isWakeable(i, before))
      .sort(byId)
      .map((i) => clone(i))
  }

  waitingInstances(): WorkflowInstanceRecord[] {
    return [...this.instances.values()]
      .filter((i) => i.state === 'waiting' || i.state === 'running')
      .sort(byId)
      .map((i) => clone(i))
  }
}
