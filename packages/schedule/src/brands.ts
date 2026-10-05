/**
 * WP215（52 §4 收口）：**每个品牌一套后台，共用一个调度循环。**
 *
 * 调度器本来就跨工作区（任务上带着 `workspace_id`，`dueTasks` 一次把全部品牌到点的都拿出来）；
 * 缺的是"到点之后用谁的东西去做"。之前处理器只登记一份，闭包里装的是第一个品牌的
 * 工作模型、队列、岗位——第二个品牌的任务到点了，要么根本没建，要么用的是别人的东西。
 *
 * 这里给的是两件纯粹的东西（服务端与模拟回路共用，所以放在包里而不是应用里）：
 *
 * 1. **品牌路由**（{@link createBrandRouter}）：每个品牌拿一个"登记口"，在上面登记的处理器
 *    只在**这个品牌的任务**上跑。共享调度器上同一个名字只挂一个分发器，按任务自己的
 *    `workspace_id` 找处理器——找不到就失败并说清楚，**绝不退回别的品牌那一份**。
 * 2. **后台状态**（{@link brandBackgroundStatus}）：从一个品牌的任务清单算出切换器上那一格
 *    （在跑几条、最近一次什么时候、有没有出错）。
 */
import type { Iso8601, WorkspaceId } from '@agentsws/contracts'
import { ScheduleError } from './errors.js'
import type { Scheduler } from './scheduler.js'
import type { ScheduleHandler, ScheduleTask } from './types.js'

export interface BrandRouter {
  /**
   * 某个品牌的登记口。`register` 进来的处理器只在这个品牌的任务上跑；其余方法
   * （`schedule` / `update` / `list` …）原样转给共享调度器——所以现有的 `registerXxx(scheduler, deps)`
   * 一行不改，换一个登记口传进去就是"这个品牌的那一份"。
   */
  for(workspace_id: WorkspaceId): Scheduler
  /** 撤掉一个品牌的全部处理器（停用 / 删品牌）。之后它的任务到点会失败并说清楚为什么。 */
  drop(workspace_id: WorkspaceId): void
  /** 登记过处理器的品牌。 */
  brands(): WorkspaceId[]
  /** 这个品牌登记了哪些处理器名。 */
  handlersOf(workspace_id: WorkspaceId): string[]
}

export function createBrandRouter(scheduler: Scheduler): BrandRouter {
  /** 处理器名 → 品牌 → 处理器。 */
  const table = new Map<string, Map<WorkspaceId, ScheduleHandler>>()
  const facades = new Map<WorkspaceId, Scheduler>()

  const dispatcher =
    (name: string): ScheduleHandler =>
    (ctx) => {
      const ws = ctx.task.workspace_id
      const handler = table.get(name)?.get(ws)
      if (handler === undefined) {
        // 不退回别的品牌那一份：宁可这一次失败（列表上看得见），也不能用 A 的东西做 B 的事
        throw new ScheduleError('not_found', `品牌 ${ws} 的后台没有装配「${name}」`, {
          handler: name,
          workspace_id: ws,
        })
      }
      return handler(ctx)
    }

  const registerFor = (ws: WorkspaceId, name: string, handler: ScheduleHandler): void => {
    let byBrand = table.get(name)
    if (byBrand === undefined) {
      byBrand = new Map()
      table.set(name, byBrand)
      scheduler.register(name, dispatcher(name))
    }
    byBrand.set(ws, handler)
  }

  return {
    for(ws) {
      const known = facades.get(ws)
      if (known !== undefined) return known
      const facade = new Proxy(scheduler, {
        get(target, prop, receiver) {
          if (prop === 'register')
            return (name: string, handler: ScheduleHandler) => registerFor(ws, name, handler)
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      facades.set(ws, facade)
      return facade
    },
    drop(ws) {
      for (const byBrand of table.values()) byBrand.delete(ws)
      facades.delete(ws)
    },
    brands() {
      const out = new Set<WorkspaceId>()
      for (const byBrand of table.values()) for (const ws of byBrand.keys()) out.add(ws)
      return [...out]
    },
    handlersOf(ws) {
      return [...table.entries()].filter(([, m]) => m.has(ws)).map(([name]) => name)
    },
  }
}

/** 切换器上那一格（36 第四档：图标 + 数字，细节进 tooltip）。 */
export interface BrandBackgroundStatus {
  workspace_id: WorkspaceId
  /**
   * - `running`：照常在跑；
   * - `halted`：这个品牌（或全局）按了急停，到点也不跑；
   * - `stopped`：品牌停用了（`archived`），后台整套不跑。
   */
  state: 'running' | 'halted' | 'stopped'
  /** 在跑的定时任务条数（`active` / `running`；暂停的、等批的、跑完的不算）。 */
  scheduled: number
  /** 最近一次有任务跑起来是什么时候。 */
  last_run_at?: Iso8601
  /** 最近一条要跑的什么时候（停着的品牌照样给，好说"放开之后几点跑"）。 */
  next_run_at?: Iso8601
  /** 上一次跑失败、还没跑好的任务条数（红点）。 */
  errors: number
  /** 最近那条失败的一句话（标题 + 原因），给 tooltip 用。 */
  last_error?: { task_id: string; title: string; message: string; at?: Iso8601 }
}

const LIVE = new Set(['active', 'running'])
const ERRORED = new Set(['active', 'running', 'failed'])

/** 从一个品牌的任务清单算出后台状态。纯函数：给什么任务就算什么任务。 */
export function brandBackgroundStatus(
  tasks: readonly ScheduleTask[],
  input: {
    workspace_id: WorkspaceId
    halted: boolean
    stopped: boolean
    /** 不算进这个品牌的那几条（进程级的家务：幂等清理、备份……挂在第一个品牌名下） */
    exclude?: (task: ScheduleTask) => boolean
  },
): BrandBackgroundStatus {
  const mine = tasks.filter(
    (t) => t.workspace_id === input.workspace_id && input.exclude?.(t) !== true,
  )
  let last_run_at: Iso8601 | undefined
  let next_run_at: Iso8601 | undefined
  let errors = 0
  let last_error: BrandBackgroundStatus['last_error']
  for (const t of mine) {
    if (t.last_fire_at !== undefined && (last_run_at === undefined || t.last_fire_at > last_run_at))
      last_run_at = t.last_fire_at
    if (
      LIVE.has(t.state) &&
      t.next_fire_at !== undefined &&
      (next_run_at === undefined || t.next_fire_at < next_run_at)
    )
      next_run_at = t.next_fire_at
    if (t.last_error !== undefined && ERRORED.has(t.state)) {
      errors += 1
      const at = t.last_fire_at
      if (
        last_error === undefined ||
        (at !== undefined && (last_error.at === undefined || at > last_error.at))
      )
        last_error = {
          task_id: t.id,
          title: t.title ?? t.handler ?? t.id,
          message: t.last_error.length > 160 ? `${t.last_error.slice(0, 160)}…` : t.last_error,
          ...(at === undefined ? {} : { at }),
        }
    }
  }
  return {
    workspace_id: input.workspace_id,
    state: input.stopped ? 'stopped' : input.halted ? 'halted' : 'running',
    scheduled: mine.filter((t) => LIVE.has(t.state)).length,
    ...(last_run_at === undefined ? {} : { last_run_at }),
    ...(next_run_at === undefined ? {} : { next_run_at }),
    errors,
    ...(last_error === undefined ? {} : { last_error }),
  }
}
