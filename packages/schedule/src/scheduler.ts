/**
 * 调度器（契约 25 §3 §4）。
 *
 * 一句话：**它只管「什么时候」**。到点了喊一声登记过的处理器，别的都不认识——
 * 不认识每日计划，不认识 Shopify，不认识幂等表。所以七个消费者各自在
 * `apps/server/src/schedule.ts` 里登记一个名字，谁挂了都不影响别人。
 *
 * 三条纪律：
 * - **时间只经注入的 Clock**：真实进程里是系统时钟 + 一个 `setInterval`；
 *   模拟回路里是合成时钟，每推进一步调一次 `runDue`。没有一处 `Date.now()`。
 * - **重启续跑**：任务连同 `next_fire_at` 落盘；进程再起来时 `tick` 看见过期的，
 *   按 `misfire_policy` 补跑一次或跳过，并记 `schedule.misfired`（25 §6.6）。
 * - **同一任务不重入**：`lease` + 过期时间。上一次还在跑（租约没过）就跳过这一拍；
 *   进程被 kill 掉留下的 `running` 租约到点自动被下一拍接管。
 */
import type { Clock, Iso8601 } from '@agentsws/contracts'
import { MINUTE_MS, nextCronAfter } from './cron.js'
import { invalid, notFound, ScheduleError } from './errors.js'
import { counterRandom, type IdFactory, makeIdFactory } from './ids.js'
import { MemoryScheduleStore } from './store.js'
import {
  SCHEDULE_EVENTS,
  type ScheduleEventSink,
  type ScheduleFilter,
  type ScheduleFireContext,
  type ScheduleHandler,
  type ScheduleInput,
  type ScheduleStore,
  type ScheduleTask,
  type ScheduleTrigger,
} from './types.js'

/** 租约默认 5 分钟：一次触发跑不完 5 分钟的，本来也不该占着调度器。 */
export const DEFAULT_LEASE_MS = 5 * MINUTE_MS
/** 超过这条线才算「错过」（25 §4 精度分钟，留一拍的余量）。 */
export const DEFAULT_MISFIRE_GRACE_MS = 5 * MINUTE_MS
/** 真实进程里的巡检间隔。 */
export const DEFAULT_INTERVAL_MS = 30_000

export interface SchedulerOptions {
  clock: Clock
  /** id 用的随机源（seed 化）；不给就用包内的确定性计数器。 */
  random?: () => number
  /** 不给就是内存档。 */
  store?: ScheduleStore
  /** 事件出口（21 §1 那条日志）；不给就是不记。 */
  eventSink?: ScheduleEventSink
  leaseMs?: number
  misfireGraceMs?: number
  /** `start()` 起的巡检间隔，默认 30 秒。 */
  intervalMs?: number
  /** 租约持有者标识（进程 id / 世界 id）；同一库多进程时用得上。 */
  holder?: string
}

export interface TickResult {
  fired: ScheduleTask[]
  misfired: ScheduleTask[]
}

export interface FireOutcome {
  task: ScheduleTask
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  misfired: boolean
}

/** 一次触发的结果摘要写回 `last_result`；太长就截断（列表要能看）。 */
const MAX_RESULT = 200

function summarize(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return undefined
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…` : text
}

const iso = (ms: number): Iso8601 => new Date(ms).toISOString()

/** 严格晚于 `afterMs` 的下一次触发；一次性 / 等事件的没有下一次。 */
export function nextFireAfter(trigger: ScheduleTrigger, afterMs: number): Iso8601 | undefined {
  switch (trigger.kind) {
    case 'once':
      return undefined
    case 'interval': {
      if (!Number.isInteger(trigger.every_ms) || trigger.every_ms < MINUTE_MS) {
        throw invalid(`interval 的 every_ms 必须是 ≥ 1 分钟的整数毫秒：${trigger.every_ms}`)
      }
      return iso(afterMs + trigger.every_ms)
    }
    case 'cron':
      return iso(nextCronAfter(trigger.expr, afterMs, trigger.tz))
    default:
      return undefined
  }
}

/** 第一次触发的时刻（`schedule()` 与「改时间」都用它）。 */
export function firstFireAt(trigger: ScheduleTrigger, nowMs: number): Iso8601 | undefined {
  switch (trigger.kind) {
    case 'once': {
      const at = Date.parse(trigger.at)
      if (!Number.isFinite(at)) throw invalid(`once 的 at 不是 ISO-8601：${trigger.at}`)
      return iso(at)
    }
    case 'interval': {
      const from = trigger.from === undefined ? undefined : Date.parse(trigger.from)
      if (from !== undefined && !Number.isFinite(from)) {
        throw invalid(`interval 的 from 不是 ISO-8601：${String(trigger.from)}`)
      }
      return from === undefined ? nextFireAfter(trigger, nowMs) : iso(from)
    }
    case 'cron':
      return iso(nextCronAfter(trigger.expr, nowMs, trigger.tz))
    default:
      // after_event：等信号，不排队
      return undefined
  }
}

export interface Scheduler {
  readonly store: ScheduleStore
  /** 登记处理器；同名后来者覆盖（23 §2 叠加解析）。 */
  register(name: string, handler: ScheduleHandler): void
  handlers(): string[]
  schedule(input: ScheduleInput): Promise<ScheduleTask>
  get(id: string): ScheduleTask | undefined
  list(filter: ScheduleFilter): ScheduleTask[]
  /** 改时间 / 改标题 / 改参数（25 §3「暂停 / 改时间 / 删除」）。 */
  update(
    id: string,
    patch: {
      trigger?: ScheduleTrigger
      title?: string
      params?: Record<string, unknown>
      misfire_policy?: ScheduleTask['misfire_policy']
    },
  ): Promise<ScheduleTask>
  pause(id: string): Promise<ScheduleTask>
  resume(id: string): Promise<ScheduleTask>
  cancel(id: string): Promise<ScheduleTask>
  /** 真删（归档对话时「一并停掉」用 cancel，删库才用它）。 */
  remove(id: string): void
  /** 只推进状态、不跑处理器；模拟回路与测试要看这一层。 */
  tick(now: Iso8601): Promise<TickResult>
  /** tick + 跑处理器；一个消费者炸了不影响别的（各自 try/catch）。 */
  runDue(now: Iso8601): Promise<FireOutcome[]>
  /** 立即运行一次（不动 `next_fire_at` 的排期）。 */
  runNow(id: string): Promise<FireOutcome>
  /** `after_event` 触发器：收到信号就跑。 */
  signal(event: string, payload?: Record<string, unknown>): Promise<FireOutcome[]>
  /** 真实进程：起一个 `setInterval`（`unref`，不拦着进程退出）。 */
  start(intervalMs?: number): void
  stop(): void
  close(): void
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const clock = options.clock
  const store: ScheduleStore = options.store ?? new MemoryScheduleStore()
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const graceMs = options.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS
  const holder = options.holder ?? 'scheduler'
  const newId: IdFactory = makeIdFactory(options.random ?? counterRandom(), () => clock.now())
  const handlers = new Map<string, ScheduleHandler>()

  const emit = (type: string, task: ScheduleTask, payload: Record<string, unknown> = {}): void => {
    options.eventSink?.({
      type,
      workspace_id: task.workspace_id,
      at: clock.now(),
      subject: { type: 'scheduled_task', id: task.id },
      payload: {
        task_id: task.id,
        handler: task.handler,
        trigger: task.trigger.kind,
        state: task.state,
        ...payload,
      },
    })
  }

  const load = (id: string): ScheduleTask => {
    const task = store.getTask(id)
    if (task === undefined) throw notFound('定时任务', id)
    return task
  }

  const save = (task: ScheduleTask): ScheduleTask => {
    const next: ScheduleTask = { ...task, updated_at: clock.now() }
    store.putTask(next)
    return next
  }

  const graceOf = (task: ScheduleTask): number => task.misfire_grace_ms ?? graceMs

  /** 到点了但已经过了宽限 = 关机错过（25 §3）。 */
  const isMisfire = (task: ScheduleTask, nowMs: number): boolean => {
    if (task.next_fire_at === undefined) return false
    return nowMs - Date.parse(task.next_fire_at) > graceOf(task)
  }

  /** 触发之后排下一次；一次性的排完就 `done`。 */
  const advance = (task: ScheduleTask, nowMs: number): ScheduleTask => {
    const next = nextFireAfter(task.trigger, nowMs)
    return next === undefined
      ? { ...task, next_fire_at: undefined }
      : { ...task, next_fire_at: next }
  }

  /** 跳过错过的那几次：把排期挪到 `now` 之后的第一个点。 */
  const skipTo = (task: ScheduleTask, nowMs: number): ScheduleTask => {
    const next = nextFireAfter(task.trigger, nowMs)
    return next === undefined
      ? { ...task, next_fire_at: undefined, state: 'done' as const }
      : { ...task, next_fire_at: next }
  }

  const contextOf = (task: ScheduleTask, at: Iso8601, misfired: boolean): ScheduleFireContext => ({
    task,
    at,
    fire_count: task.fire_count,
    idempotency_key: `sched_${task.id}_${task.fire_count}`,
    misfired,
  })

  /** 标记这一次触发：计数 + 租约 + 下一次排期。 */
  const markFiring = (task: ScheduleTask, now: Iso8601, misfired: boolean): ScheduleTask => {
    const nowMs = Date.parse(now)
    const fired: ScheduleTask = {
      ...advance(task, nowMs),
      state: 'running',
      fire_count: task.fire_count + 1,
      last_fire_at: now,
      lease: { holder, until: iso(nowMs + leaseMs) },
    }
    const saved = save(fired)
    emit(SCHEDULE_EVENTS.fired, saved, {
      fire_count: saved.fire_count,
      idempotency_key: `sched_${saved.id}_${saved.fire_count}`,
      misfired,
      next_fire_at: saved.next_fire_at,
    })
    return saved
  }

  /**
   * 处理器跑的时候可能自己改了这条任务（令牌刷新就会把下一次挪到「到期前一小时」），
   * 所以结算前重新读一遍库，别拿触发那一刻的快照把人家的改动盖掉。
   */
  const latestOf = (task: ScheduleTask): ScheduleTask => store.getTask(task.id) ?? task

  /** 跑完一次：租约放掉，周期任务回 `active`，一次性任务 `done`。 */
  const settle = (fired: ScheduleTask, result: unknown): ScheduleTask => {
    const task = latestOf(fired)
    const done = task.next_fire_at === undefined
    const summary = summarize(result)
    return save({
      ...task,
      state: done ? 'done' : 'active',
      ...(summary === undefined ? {} : { last_result: summary }),
      lease: undefined,
      last_error: undefined,
    })
  }

  /** 一次失败不改排期：周期任务下一次照跑（25「消费者失败不影响别的任务」）。 */
  const settleFailed = (fired: ScheduleTask, error: unknown): ScheduleTask => {
    const task = latestOf(fired)
    const e = error as { code?: string; message?: string }
    const message = e?.message ?? String(error)
    const done = task.next_fire_at === undefined
    const next = save({
      ...task,
      state: done ? 'failed' : 'active',
      last_error: message,
      last_result: `failed: ${summarize(message) ?? ''}`,
      lease: undefined,
    })
    emit(SCHEDULE_EVENTS.failed, next, {
      fire_count: next.fire_count,
      code: e?.code ?? 'internal',
      message,
    })
    return next
  }

  const dispatch = async (
    task: ScheduleTask,
    at: Iso8601,
    misfired: boolean,
  ): Promise<FireOutcome> => {
    const handler = task.handler === undefined ? undefined : handlers.get(task.handler)
    if (handler === undefined) {
      const err = new ScheduleError(
        'not_implemented',
        `没有登记这个处理器：${String(task.handler)}`,
        { handler: task.handler },
      )
      return {
        task: settleFailed(task, err),
        ok: false,
        error: { code: err.code, message: err.message },
        misfired,
      }
    }
    try {
      const result = await handler(contextOf(task, at, misfired))
      return { task: settle(task, result), ok: true, result, misfired }
    } catch (err) {
      const e = err as { code?: string; message?: string }
      return {
        task: settleFailed(task, err),
        ok: false,
        error: { code: e?.code ?? 'internal', message: e?.message ?? String(err) },
        misfired,
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  const tick = async (now: Iso8601): Promise<TickResult> => {
    const nowMs = Date.parse(now)
    if (!Number.isFinite(nowMs)) throw invalid(`tick 的 now 不是 ISO-8601：${now}`)
    const fired: ScheduleTask[] = []
    const misfired: ScheduleTask[] = []
    for (const candidate of store.dueTasks(now)) {
      // 上一次还在跑且租约没过 → 这一拍跳过（同一任务不重入）
      if (candidate.state === 'running') {
        const until = candidate.lease?.until
        if (until !== undefined && Date.parse(until) > nowMs) continue
      }
      const missed = isMisfire(candidate, nowMs)
      if (missed && candidate.misfire_policy === 'skip') {
        const skipped = save(skipTo(candidate, nowMs))
        misfired.push(skipped)
        emit(SCHEDULE_EVENTS.misfired, skipped, {
          policy: 'skip',
          missed_at: candidate.next_fire_at,
          next_fire_at: skipped.next_fire_at,
        })
        continue
      }
      if (missed) {
        emit(SCHEDULE_EVENTS.misfired, candidate, {
          policy: 'run_once_now',
          missed_at: candidate.next_fire_at,
        })
      }
      const task = markFiring(candidate, now, missed)
      fired.push(task)
      if (missed) misfired.push(task)
    }
    return { fired, misfired }
  }

  return {
    store,

    register(name, handler) {
      handlers.set(name, handler)
    },

    handlers: () => [...handlers.keys()],

    async schedule(input) {
      const now = clock.now()
      const nowMs = Date.parse(now)
      const next = firstFireAt(input.trigger, nowMs)
      const task: ScheduleTask = {
        ...input,
        id: input.id ?? newId('sched'),
        state: input.state ?? 'active',
        fire_count: input.fire_count ?? 0,
        created_at: now,
        updated_at: now,
        ...(next === undefined ? {} : { next_fire_at: next }),
      }
      if (store.getTask(task.id) !== undefined) {
        throw new ScheduleError('conflict', `定时任务 id 已存在：${task.id}`, { id: task.id })
      }
      store.putTask(task)
      emit(SCHEDULE_EVENTS.created, task, {
        next_fire_at: task.next_fire_at,
        created_by: task.created_by,
        title: task.title,
      })
      return task
    },

    get: (id) => store.getTask(id),
    list: (filter) => store.listTasks(filter),

    async update(id, patch) {
      const task = load(id)
      if (task.state === 'cancelled' || task.state === 'done') {
        throw new ScheduleError('conflict', `已结束的定时任务改不了：${id}`, { state: task.state })
      }
      const trigger = patch.trigger ?? task.trigger
      const nowMs = Date.parse(clock.now())
      const next = patch.trigger === undefined ? task.next_fire_at : firstFireAt(trigger, nowMs)
      const updated = save({
        ...task,
        trigger,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.params === undefined ? {} : { params: patch.params }),
        ...(patch.misfire_policy === undefined ? {} : { misfire_policy: patch.misfire_policy }),
        next_fire_at: next,
      })
      emit(SCHEDULE_EVENTS.updated, updated, { next_fire_at: updated.next_fire_at })
      return updated
    },

    async pause(id) {
      const task = load(id)
      if (task.state === 'cancelled' || task.state === 'done') {
        throw new ScheduleError('conflict', `已结束的定时任务停不了：${id}`, { state: task.state })
      }
      const paused = save({ ...task, state: 'paused', lease: undefined })
      emit(SCHEDULE_EVENTS.paused, paused)
      return paused
    },

    async resume(id) {
      const task = load(id)
      if (task.state !== 'paused') {
        throw new ScheduleError('conflict', `这条定时任务不是暂停中：${id}`, { state: task.state })
      }
      const nowMs = Date.parse(clock.now())
      // 暂停期间错过的那几次不补：人自己按了暂停，不是机器关机
      const next =
        task.next_fire_at !== undefined && Date.parse(task.next_fire_at) > nowMs
          ? task.next_fire_at
          : nextFireAfter(task.trigger, nowMs)
      const resumed = save({ ...task, state: 'active', next_fire_at: next })
      emit(SCHEDULE_EVENTS.resumed, resumed, { next_fire_at: resumed.next_fire_at })
      return resumed
    },

    async cancel(id) {
      const task = load(id)
      const cancelled = save({
        ...task,
        state: 'cancelled',
        next_fire_at: undefined,
        lease: undefined,
      })
      emit(SCHEDULE_EVENTS.deleted, cancelled)
      return cancelled
    },

    remove(id) {
      store.deleteTask(id)
    },

    tick,

    async runDue(now) {
      const { fired, misfired } = await tick(now)
      const missed = new Set(misfired.map((t) => t.id))
      const out: FireOutcome[] = []
      for (const task of fired) out.push(await dispatch(task, now, missed.has(task.id)))
      return out
    },

    async runNow(id) {
      const task = load(id)
      if (task.state === 'cancelled') {
        throw new ScheduleError('conflict', `已取消的定时任务跑不了：${id}`, { id })
      }
      const now = clock.now()
      const nowMs = Date.parse(now)
      if (task.state === 'running' && task.lease !== undefined) {
        if (Date.parse(task.lease.until) > nowMs) {
          throw new ScheduleError('conflict', `这条定时任务正在跑：${id}`, { id })
        }
      }
      // 立即运行不动排期：手动跑一次之后，原来的 next_fire_at 该什么时候还是什么时候
      const keep = task.next_fire_at
      const firing = markFiring(task, now, false)
      const outcome = await dispatch(firing, now, false)
      return {
        ...outcome,
        task: save({
          ...outcome.task,
          next_fire_at: keep,
          state: keep === undefined ? outcome.task.state : 'active',
        }),
      }
    },

    async signal(event, payload) {
      const out: FireOutcome[] = []
      const now = clock.now()
      // 信号是系统级的（「签收了」「付款了」），跨工作区找一遍
      for (const task of collectAfterEvent(store, event)) {
        const firing = markFiring(
          { ...task, params: { ...(task.params ?? {}), ...(payload ?? {}) } },
          now,
          false,
        )
        out.push(await dispatch(firing, now, false))
      }
      return out
    },

    start(intervalMs) {
      if (timer !== undefined) return
      const every = intervalMs ?? options.intervalMs ?? DEFAULT_INTERVAL_MS
      timer = setInterval(() => {
        if (running) return
        running = true
        void (async () => {
          try {
            await this.runDue(clock.now())
          } finally {
            running = false
          }
        })()
      }, every)
      timer.unref?.()
    },

    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },

    close() {
      this.stop()
      store.close?.()
    },
  }
}

/**
 * `after_event` 任务没有 `next_fire_at`（它不排队），所以 `dueTasks` 看不见它们；
 * 信号来了要另外找一遍。存储接口不为它单开一条查询——这类任务本来就少。
 */
function collectAfterEvent(store: ScheduleStore, event: string): ScheduleTask[] {
  const out: ScheduleTask[] = []
  for (const workspace_id of store.workspaces()) {
    for (const task of store.listTasks({ workspace_id })) {
      if (task.trigger.kind !== 'after_event') continue
      if (task.trigger.event !== event) continue
      if (task.state !== 'active' && task.state !== 'pending') continue
      out.push(task)
    }
  }
  return out
}
