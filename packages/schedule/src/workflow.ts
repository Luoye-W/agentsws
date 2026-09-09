/**
 * 流程引擎最小实现（契约 25 §1 §2）。
 *
 * 25 §2 说默认实现是自托管 Inngest，替身是「内存引擎 + 合成时钟」。这里做的是**后者的
 * 落盘版**：状态机自己写，步骤结果与游标落 SQLite，重启后从断点接着跑（25 §6.2）。
 * 契约不暴露任何 Inngest 类型，所以将来换引擎只换这一个文件。
 *
 * 七种步骤：
 * - `run` / `action` —— 交给宿主（发 RunRequest / 执行器 apply），结果记进 history
 * - `approval` —— 宿主建一条 14 的审批项，返回 id；实例挂在它上面，决定后 `signal` 回来
 * - `human_task` —— 队列里一条待办，同上
 * - `sleep` —— 等一段时长，**不占进程**：只记 `wake_at`，`tick` 到点再醒
 * - `wait_event` —— 等一个事件，带超时；超时按 `on_fail` 走
 * - `branch` —— 宿主看上一步结果，返回下一步 id
 *
 * 失败：先按 `retry`（次数 + 指数退避）重试；重试用完按 `on_fail`
 * （`retry` = 认输、`skip` = 跳过、`compensate` = 倒着跑补偿步、`escalate` = 出一条待办给人）。
 */
import type { Clock, Iso8601, ObjectRef, RoleId, WorkspaceId } from '@agentsws/contracts'
import { invalid, notFound, ScheduleError } from './errors.js'
import { counterRandom, type IdFactory, makeIdFactory } from './ids.js'
import { MemoryScheduleStore } from './store.js'
import {
  type ScheduleEventSink,
  type ScheduleStore,
  WORKFLOW_EVENTS,
  type WorkflowDefinition,
  type WorkflowFilter,
  type WorkflowHandlers,
  type WorkflowInstanceRecord,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowStepRecord,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** 重试默认退避 1 分钟起步、每次翻倍。 */
export const DEFAULT_BACKOFF_MS = 60_000

export interface SleepParams {
  ms?: number
  days?: number
  until?: Iso8601
}

export interface WaitEventParams {
  event: string
  timeout_ms?: number
  timeout_days?: number
}

export interface WorkflowEngineOptions {
  clock: Clock
  random?: () => number
  store?: ScheduleStore
  eventSink?: ScheduleEventSink
  handlers?: WorkflowHandlers
}

export interface WorkflowSignal {
  type: string
  payload?: unknown
}

export interface WorkflowEngine {
  readonly store: ScheduleStore
  register(def: WorkflowDefinition): void
  definition(id: string): WorkflowDefinition | undefined
  setHandlers(handlers: WorkflowHandlers): void
  start(
    def: WorkflowDefinition | string,
    subject: ObjectRef,
    ctx: { workspace_id: WorkspaceId; conversation_id?: string; role_id?: RoleId },
  ): Promise<WorkflowInstanceRecord>
  signal(instance_id: string, event: WorkflowSignal): Promise<WorkflowInstanceRecord>
  /** 广播：不知道是哪个实例在等（客户回信来了）时用。 */
  broadcast(event: WorkflowSignal): Promise<WorkflowInstanceRecord[]>
  /** 到点该醒的实例（`sleep` / 重试 / 超时）；模拟回路每推进一步调一次。 */
  tick(now: Iso8601): Promise<WorkflowInstanceRecord[]>
  status(instance_id: string): Promise<WorkflowInstanceRecord | undefined>
  list(filter: WorkflowFilter): WorkflowInstanceRecord[]
  pause(instance_id: string): Promise<WorkflowInstanceRecord>
  resume(instance_id: string): Promise<WorkflowInstanceRecord>
  cancel(instance_id: string): Promise<WorkflowInstanceRecord>
}

function sleepUntil(params: unknown, nowMs: number): number {
  const p = (params ?? {}) as SleepParams
  if (p.until !== undefined) {
    const at = Date.parse(p.until)
    if (!Number.isFinite(at)) throw invalid(`sleep 的 until 不是 ISO-8601：${p.until}`)
    return at
  }
  if (p.days !== undefined) return nowMs + p.days * DAY_MS
  if (p.ms !== undefined) return nowMs + p.ms
  throw invalid('sleep 步骤要给 ms / days / until 其中之一')
}

function waitSpec(params: unknown, nowMs: number): { event: string; timeout_at?: number } {
  const p = (params ?? {}) as WaitEventParams
  if (typeof p.event !== 'string' || p.event === '') {
    throw invalid('wait_event 步骤要给 event')
  }
  const ms = p.timeout_ms ?? (p.timeout_days === undefined ? undefined : p.timeout_days * DAY_MS)
  return ms === undefined ? { event: p.event } : { event: p.event, timeout_at: nowMs + ms }
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const clock = options.clock
  const store: ScheduleStore = options.store ?? new MemoryScheduleStore()
  const newId: IdFactory = makeIdFactory(options.random ?? counterRandom(7), () => clock.now())
  const defs = new Map<string, WorkflowDefinition>()
  let handlers: WorkflowHandlers = options.handlers ?? {}

  const emit = (
    type: string,
    instance: WorkflowInstanceRecord,
    payload: Record<string, unknown> = {},
  ): void => {
    options.eventSink?.({
      type,
      workspace_id: instance.workspace_id,
      at: clock.now(),
      subject: { type: 'workflow_instance', id: instance.id },
      payload: {
        instance_id: instance.id,
        def: instance.def.id,
        version: instance.def.version,
        state: instance.state,
        cursor: instance.cursor,
        ...payload,
      },
    })
  }

  const save = (instance: WorkflowInstanceRecord): WorkflowInstanceRecord => {
    const next: WorkflowInstanceRecord = { ...instance, updated_at: clock.now() }
    store.putInstance(next)
    return next
  }

  const load = (id: string): WorkflowInstanceRecord => {
    const found = store.getInstance(id)
    if (found === undefined) throw notFound('流程实例', id)
    return found
  }

  const stepAt = (instance: WorkflowInstanceRecord, step_id: string): WorkflowStep | undefined =>
    instance.definition.steps.find((s) => s.id === step_id)

  const nextStepId = (instance: WorkflowInstanceRecord, step_id: string): string | undefined => {
    const idx = instance.definition.steps.findIndex((s) => s.id === step_id)
    return instance.definition.steps[idx + 1]?.id
  }

  /** 这一步是第几次试（还没试过就是第 1 次）。 */
  const attemptOf = (instance: WorkflowInstanceRecord, step_id: string): number =>
    (instance.attempts[step_id] ?? 0) + 1

  const record = (
    instance: WorkflowInstanceRecord,
    step_id: string,
    outcome: WorkflowStepRecord['outcome'],
    result: unknown,
    attempt = attemptOf(instance, step_id),
  ): WorkflowInstanceRecord => ({
    ...instance,
    history: [...instance.history, { step_id, at: clock.now(), result, outcome, attempt }],
  })

  const ctxFor = (instance: WorkflowInstanceRecord, step: WorkflowStep): WorkflowStepContext => ({
    instance,
    step,
    at: clock.now(),
    attempt: attemptOf(instance, step.id),
    // 每步幂等键在重试之间保持不变：宿主据此认出「这一步我已经做过了」
    idempotency_key: `wf_${instance.id}_${step.id}`,
  })

  /** 补偿：把已经跑成功的步骤倒着跑一遍它们的补偿步（25 §1 重寄 / 撤回）。 */
  const compensate = async (instance: WorkflowInstanceRecord): Promise<WorkflowInstanceRecord> => {
    let cur = instance
    const done = [...cur.history].filter((h) => h.outcome === 'ok').reverse()
    for (const h of done) {
      const step = cur.definition.compensation?.[h.step_id]
      if (step === undefined) continue
      try {
        const result = await runHandlerFor(cur, step)
        cur = record(cur, step.id, 'compensated', result)
      } catch (err) {
        cur = record(cur, step.id, 'failed', { message: String(err) })
      }
    }
    const out = save({ ...cur, state: 'compensated', waiting: undefined })
    emit(WORKFLOW_EVENTS.compensated, out)
    return out
  }

  const runHandlerFor = async (
    instance: WorkflowInstanceRecord,
    step: WorkflowStep,
  ): Promise<unknown> => {
    const fn = step.kind === 'action' ? handlers.action : handlers.run
    if (fn === undefined) {
      throw new ScheduleError('not_implemented', `没有装 ${step.kind} 步骤的处理器`, {
        step: step.id,
      })
    }
    return fn(ctxFor(instance, step))
  }

  /** 一步失败了怎么办：先重试，重试完按 `on_fail`。 */
  const onFailure = async (
    instance: WorkflowInstanceRecord,
    step: WorkflowStep,
    error: unknown,
  ): Promise<WorkflowInstanceRecord> => {
    const e = error as { code?: string; message?: string }
    const message = e?.message ?? String(error)
    const attempt = (instance.attempts[step.id] ?? 0) + 1
    let cur: WorkflowInstanceRecord = {
      ...instance,
      attempts: { ...instance.attempts, [step.id]: attempt },
      last_error: message,
    }
    emit(WORKFLOW_EVENTS.stepFailed, cur, { step_id: step.id, attempt, message })
    const max = step.retry?.max ?? 0
    if (attempt <= max) {
      const base = step.retry?.backoff_ms ?? DEFAULT_BACKOFF_MS
      const wake = Date.parse(clock.now()) + base * 2 ** (attempt - 1)
      const waiting = save({
        ...cur,
        state: 'waiting',
        waiting: { reason: 'retry', wake_at: new Date(wake).toISOString() },
      })
      emit(WORKFLOW_EVENTS.waiting, waiting, { step_id: step.id, reason: 'retry', attempt })
      return waiting
    }
    cur = record(cur, step.id, 'failed', { message }, attempt)
    switch (step.on_fail ?? 'retry') {
      case 'skip': {
        const next = nextStepId(cur, step.id)
        return advance(save({ ...cur, cursor: next ?? step.id, state: 'running' }))
      }
      case 'compensate':
        return compensate(cur)
      case 'escalate': {
        if (handlers.humanTask === undefined) {
          throw new ScheduleError('not_implemented', '没有装 human_task 处理器，升级不了', {
            step: step.id,
          })
        }
        const human_task_id = await handlers.humanTask(ctxFor(cur, step))
        const waiting = save({
          ...cur,
          state: 'waiting',
          waiting: { reason: 'human_task', human_task_id },
        })
        emit(WORKFLOW_EVENTS.waiting, waiting, {
          step_id: step.id,
          reason: 'human_task',
          human_task_id,
        })
        return waiting
      }
      default: {
        const failed = save({ ...cur, state: 'failed', waiting: undefined })
        emit(WORKFLOW_EVENTS.failed, failed, { step_id: step.id, message })
        return failed
      }
    }
  }

  /** 从当前游标一路往下跑，直到要等（sleep / 事件 / 人）或者跑完。 */
  const advance = async (instance: WorkflowInstanceRecord): Promise<WorkflowInstanceRecord> => {
    let cur = instance
    for (;;) {
      if (cur.state !== 'running') return cur
      const step = stepAt(cur, cur.cursor)
      if (step === undefined) {
        const done = save({ ...cur, state: 'done', waiting: undefined })
        emit(WORKFLOW_EVENTS.done, done)
        return done
      }
      const nowMs = Date.parse(clock.now())
      try {
        switch (step.kind) {
          case 'sleep': {
            const wake = sleepUntil(step.params, nowMs)
            const waiting = save({
              ...cur,
              state: 'waiting',
              waiting: { reason: 'sleep', wake_at: new Date(wake).toISOString() },
            })
            emit(WORKFLOW_EVENTS.waiting, waiting, {
              step_id: step.id,
              reason: 'sleep',
              wake_at: waiting.waiting?.wake_at,
            })
            return waiting
          }
          case 'wait_event': {
            const spec = waitSpec(step.params, nowMs)
            const waiting = save({
              ...cur,
              state: 'waiting',
              waiting: {
                reason: 'event',
                event: spec.event,
                ...(spec.timeout_at === undefined
                  ? {}
                  : { timeout_at: new Date(spec.timeout_at).toISOString() }),
              },
            })
            emit(WORKFLOW_EVENTS.waiting, waiting, {
              step_id: step.id,
              reason: 'event',
              event: spec.event,
            })
            return waiting
          }
          case 'approval': {
            if (handlers.approval === undefined) {
              throw new ScheduleError('not_implemented', '没有装 approval 步骤的处理器', {
                step: step.id,
              })
            }
            const approval_id = await handlers.approval(ctxFor(cur, step))
            const waiting = save({
              ...cur,
              state: 'waiting',
              waiting: { reason: 'approval', approval_id },
            })
            emit(WORKFLOW_EVENTS.waiting, waiting, {
              step_id: step.id,
              reason: 'approval',
              approval_id,
            })
            return waiting
          }
          case 'human_task': {
            if (handlers.humanTask === undefined) {
              throw new ScheduleError('not_implemented', '没有装 human_task 步骤的处理器', {
                step: step.id,
              })
            }
            const human_task_id = await handlers.humanTask(ctxFor(cur, step))
            const waiting = save({
              ...cur,
              state: 'waiting',
              waiting: { reason: 'human_task', human_task_id },
            })
            emit(WORKFLOW_EVENTS.waiting, waiting, {
              step_id: step.id,
              reason: 'human_task',
              human_task_id,
            })
            return waiting
          }
          case 'branch': {
            if (handlers.branch === undefined) {
              throw new ScheduleError('not_implemented', '没有装 branch 步骤的处理器', {
                step: step.id,
              })
            }
            const target = await handlers.branch(ctxFor(cur, step))
            if (target !== undefined && stepAt(cur, target) === undefined) {
              throw invalid(`branch 指向了不存在的步骤：${target}`, { step: step.id, target })
            }
            cur = record(cur, step.id, 'ok', { branch: target })
            emit(WORKFLOW_EVENTS.stepCompleted, cur, { step_id: step.id, branch: target })
            cur = save({ ...cur, cursor: target ?? nextStepId(cur, step.id) ?? '' })
            break
          }
          default: {
            const result = await runHandlerFor(cur, step)
            cur = record(cur, step.id, 'ok', result)
            emit(WORKFLOW_EVENTS.stepCompleted, cur, { step_id: step.id })
            cur = save({ ...cur, cursor: nextStepId(cur, step.id) ?? '' })
            break
          }
        }
      } catch (err) {
        return onFailure(cur, step, err)
      }
    }
  }

  /** 收到的信号把实例从「等」里放出来，接着往下跑。 */
  const resumeWith = async (
    instance: WorkflowInstanceRecord,
    result: unknown,
  ): Promise<WorkflowInstanceRecord> => {
    const step = stepAt(instance, instance.cursor)
    if (step === undefined) return instance
    const done = record(instance, step.id, 'ok', result)
    emit(WORKFLOW_EVENTS.stepCompleted, done, { step_id: step.id })
    return advance(
      save({
        ...done,
        state: 'running',
        waiting: undefined,
        cursor: nextStepId(done, step.id) ?? '',
      }),
    )
  }

  const stopped = (instance: WorkflowInstanceRecord, event: string): WorkflowInstanceRecord => {
    const out = save({
      ...record(instance, instance.cursor, 'skipped', { stopped_by: event }),
      state: 'done',
      waiting: undefined,
    })
    emit(WORKFLOW_EVENTS.done, out, { stopped_by: event })
    return out
  }

  const applySignal = async (
    instance: WorkflowInstanceRecord,
    event: WorkflowSignal,
  ): Promise<WorkflowInstanceRecord> => {
    if (
      instance.state === 'done' ||
      instance.state === 'failed' ||
      instance.state === 'cancelled'
    ) {
      return instance
    }
    // 25 §1 邮件序列「任一回复即停」：停在哪一步都算
    if (instance.definition.stop_on?.includes(event.type) === true) {
      return stopped(instance, event.type)
    }
    const w = instance.waiting
    if (w === undefined) return instance
    if (w.reason === 'event' && w.event === event.type) {
      return resumeWith(instance, event.payload)
    }
    if (w.reason === 'approval' && event.type === 'approval.decided') {
      const payload = (event.payload ?? {}) as { approval_id?: string; action?: string }
      if (payload.approval_id !== undefined && payload.approval_id !== w.approval_id) {
        return instance
      }
      if (payload.action === 'reject') {
        const step = stepAt(instance, instance.cursor)
        if (step === undefined) return instance
        return onFailure({ ...instance, state: 'running' }, step, {
          code: 'not_approved',
          message: '审批被驳回',
        })
      }
      return resumeWith(instance, event.payload)
    }
    if (w.reason === 'human_task' && event.type === 'human_task.done') {
      const payload = (event.payload ?? {}) as { human_task_id?: string }
      if (payload.human_task_id !== undefined && payload.human_task_id !== w.human_task_id) {
        return instance
      }
      return resumeWith(instance, event.payload)
    }
    return instance
  }

  return {
    store,

    register(def) {
      defs.set(def.id, def)
    },

    definition: (id) => defs.get(id),

    setHandlers(next) {
      handlers = next
    },

    async start(def, subject, ctx) {
      const definition = typeof def === 'string' ? defs.get(def) : def
      if (definition === undefined) {
        throw notFound('流程定义', typeof def === 'string' ? def : '(未注册)')
      }
      const first = definition.steps[0]
      if (first === undefined) throw invalid(`流程定义没有步骤：${definition.id}`)
      const now = clock.now()
      const instance: WorkflowInstanceRecord = {
        id: newId('wf'),
        def: { id: definition.id, version: definition.version },
        workspace_id: ctx.workspace_id,
        role_id: ctx.role_id ?? definition.role_id,
        subject,
        state: 'running',
        cursor: first.id,
        history: [],
        started_at: now,
        updated_at: now,
        attempts: {},
        // 定义快照：改了定义也不影响已经在跑的实例
        definition: structuredClone(definition),
        ...(ctx.conversation_id === undefined ? {} : { conversation_id: ctx.conversation_id }),
        ...(definition.sla === undefined
          ? {}
          : {
              due_at: new Date(Date.parse(now) + definition.sla.total_days * DAY_MS).toISOString(),
            }),
      }
      store.putInstance(instance)
      emit(WORKFLOW_EVENTS.started, instance, { subject })
      return advance(instance)
    },

    async signal(instance_id, event) {
      return applySignal(load(instance_id), event)
    },

    async broadcast(event) {
      const out: WorkflowInstanceRecord[] = []
      for (const instance of store.waitingInstances()) {
        const before = instance.state
        const after = await applySignal(instance, event)
        if (after.state !== before || after.updated_at !== instance.updated_at) out.push(after)
      }
      return out
    },

    async tick(now) {
      const woken: WorkflowInstanceRecord[] = []
      for (const instance of store.wakeableInstances(now)) {
        const w = instance.waiting
        if (w === undefined) continue
        if (w.reason === 'sleep' || w.reason === 'retry') {
          // sleep 睡醒了：这一步算跑完；重试醒了：同一步再来一次
          const next =
            w.reason === 'sleep'
              ? await resumeWith(instance, { slept_until: now })
              : await advance(save({ ...instance, state: 'running', waiting: undefined }))
          woken.push(next)
          continue
        }
        // wait_event 超时：按 on_fail 走（25 §6.3 → escalate 出 human_task）
        const step = stepAt(instance, instance.cursor)
        if (step === undefined) continue
        woken.push(
          await onFailure({ ...instance, state: 'running', waiting: undefined }, step, {
            code: 'timeout',
            message: `等 ${String(w.event)} 超时`,
          }),
        )
      }
      return woken
    },

    async status(instance_id) {
      return store.getInstance(instance_id)
    },

    list: (filter) => store.listInstances(filter),

    async pause(instance_id) {
      const instance = load(instance_id)
      return save({ ...instance, state: 'paused' })
    },

    async resume(instance_id) {
      const instance = load(instance_id)
      if (instance.state !== 'paused') {
        throw new ScheduleError('conflict', `这个流程实例不是暂停中：${instance_id}`, {
          state: instance.state,
        })
      }
      // 暂停前在等什么就接着等什么；不在等就接着跑
      const back: WorkflowInstanceRecord = {
        ...instance,
        state: instance.waiting === undefined ? 'running' : 'waiting',
      }
      return instance.waiting === undefined ? advance(save(back)) : save(back)
    },

    async cancel(instance_id) {
      const instance = load(instance_id)
      const out = save({ ...instance, state: 'cancelled', waiting: undefined })
      emit(WORKFLOW_EVENTS.cancelled, out)
      return out
    },
  }
}
