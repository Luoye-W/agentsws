/**
 * WP215（52 §4 收口）：**每个品牌一套后台，与「眼前切在哪个品牌」无关。**
 *
 * 一句话：调度循环只有一个（一台电脑一个进程），但每条任务到点之后用的是**它自己品牌**的
 * 工作区、连接、模型、凭据、岗位、卡片队列——那一步由 `@agentsws/schedule` 的品牌路由做；
 * 这个文件管的是路由之外的三件事：
 *
 * | 事 | 怎么做 |
 * |---|---|
 * | 哪些品牌在跑 | 组织下每个 `status` 不是 `archived` 的品牌工作区；停用（`archived`）= 整套不跑 |
 * | 急停 | 每个品牌各一个开关（只停它：到点的任务、对外发送、模型调用），全局急停（`/v1/halt`）照旧、压过一切 |
 * | 同时跑几件 | 全进程一个数（设置里改，1–4，默认 2）：同一品牌永远一件接一件，品牌之间最多 N 件同时跑 |
 *
 * 落盘：`<dbDir>/background.json`（并发数 + 每个品牌的急停）。没有数据目录就全内存。
 *
 * 进程级的家务（审批过期、幂等清理、备份、价目刷新、原始区保留期）挂在第一个品牌名下，但它们
 * 不属于任何一个品牌：品牌急停不停它们，状态里也不数它们（{@link PROCESS_HANDLERS}）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackgroundSettingsView, BrandBackgroundView } from '@agentsws/api'
import { BACKGROUND_CONCURRENCY_MAX, BACKGROUND_CONCURRENCY_MIN } from '@agentsws/api'
import type {
  Clock,
  EventEnvelope,
  Halt,
  HaltScope,
  PersonId,
  Workspace,
  WorkspaceId,
} from '@agentsws/contracts'
import { brandBackgroundStatus, type Scheduler, type ScheduleTask } from '@agentsws/schedule'
import { HANDLERS } from './schedule.js'

/** 落盘文件名（`dbDir` 下）。 */
export const BACKGROUND_FILE = 'background.json'
/** 「同时最多跑几件」默认值：两个品牌可以同时巡检，再多就排队。 */
export const DEFAULT_BACKGROUND_CONCURRENCY = 2

/**
 * 进程级的家务：挂在第一个品牌名下，但不属于任何品牌。品牌急停不停它们、状态里不数它们。
 * （审批过期要对**所有**品牌的卡生效；备份导的是整台机器的库。）
 */
export const PROCESS_HANDLERS: ReadonlySet<string> = new Set([
  HANDLERS.idempotencySweep,
  HANDLERS.approvalHousekeeping,
  HANDLERS.rawPrune,
  HANDLERS.backup,
  HANDLERS.pricingRefresh,
])

const HALT_SCOPES: readonly HaltScope[] = ['all', 'model', 'outbound', 'learning']

interface BrandHaltRow {
  on: boolean
  reason?: string
  by?: string
  at?: string
}

interface BackgroundFile {
  version: 1
  max_concurrent?: number
  halted?: Record<string, BrandHaltRow>
}

type AppendEvent = (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void

export interface BrandBackgroundOptions {
  clock: Clock
  /** 这个进程第一次启动时建出来的那个品牌（进程级家务挂在它名下）。 */
  bootstrap: WorkspaceId
  /** 全局急停（内核那一份；`/v1/halt` 改的就是它）。 */
  globalHalt: Halt
  /** 组织下现在有哪些品牌工作区（同步：每一拍都要问）。 */
  brands(): Workspace[]
  /** 调度器（惰性：装配时它可能还没起来）。 */
  scheduler(): Scheduler | undefined
  appendEvent: AppendEvent
  /** 给了就落盘 `background.json`。 */
  dbDir?: string
}

export interface BrandBackground {
  /** 这是不是这家公司的一个品牌（不认识的工作区一律不替它跑任何东西）。 */
  isBrand(workspace_id: WorkspaceId): boolean
  /** 现在该在跑的品牌（停用的不算）。 */
  activeBrands(): WorkspaceId[]
  /** 停用了（`archived`）：整套后台不跑。 */
  stopped(workspace_id: WorkspaceId): boolean
  /** 这个品牌自己的急停开着没有（不含全局）。 */
  brandHalted(workspace_id: WorkspaceId): boolean
  /** 这条任务现在先别触发（给调度器的 `hold`）。 */
  hold(task: ScheduleTask): boolean
  /** 这个品牌的急停视图：全局急停 **或** 品牌急停（品牌急停 = 这个品牌的全部档位）。 */
  haltOf(workspace_id: WorkspaceId): Halt
  setHalted(workspace_id: WorkspaceId, on: boolean, by: PersonId, reason?: string): void
  /** 全进程同时最多跑几件。 */
  maxConcurrent(): number
  setMaxConcurrent(n: number, by: PersonId, workspace_id: WorkspaceId): number
  /** 切换器与品牌一览那一格。 */
  status(workspace_id: WorkspaceId): BrandBackgroundView
  /**
   * 记下一件正在后台做的装配（分配一变就即时建 / 停定时那一步是异步的）。
   * `settled()` 等它们都做完——测试与 demo 要"分配完立刻看得到任务"。
   */
  track(work: Promise<unknown>): void
  settled(): Promise<void>
  /** 设置页那一张（`names` / `current` 由调用方按人给）。 */
  settings(
    rows: { workspace_id: WorkspaceId; name: string; current: boolean }[],
  ): BackgroundSettingsView
}

const clampConcurrency = (n: number): number =>
  Math.min(BACKGROUND_CONCURRENCY_MAX, Math.max(BACKGROUND_CONCURRENCY_MIN, Math.floor(n)))

export function createBrandBackground(options: BrandBackgroundOptions): BrandBackground {
  const file = options.dbDir === undefined ? undefined : join(options.dbDir, BACKGROUND_FILE)
  let state: BackgroundFile = { version: 1, halted: {} }
  if (file !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as BackgroundFile
      state = {
        version: 1,
        ...(parsed.max_concurrent === undefined ? {} : { max_concurrent: parsed.max_concurrent }),
        halted: parsed.halted ?? {},
      }
    } catch {
      // 第一次跑或文件坏了：从默认开始（没有一个品牌是停着的——宁可照常跑也不悄悄停）
    }
  }
  const flush = (): void => {
    if (file === undefined || options.dbDir === undefined) return
    mkdirSync(options.dbDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const workspaceOf = (ws: WorkspaceId): Workspace | undefined =>
    options.brands().find((w) => w.id === ws)
  const isBrand = (ws: WorkspaceId): boolean =>
    ws === options.bootstrap || workspaceOf(ws) !== undefined
  const stopped = (ws: WorkspaceId): boolean => workspaceOf(ws)?.status === 'archived'
  const brandHalted = (ws: WorkspaceId): boolean => state.halted?.[ws]?.on === true
  const globalAll = (): boolean => options.globalHalt.isHalted('all')

  const haltOf = (ws: WorkspaceId): Halt => ({
    isHalted: (scope) => options.globalHalt.isHalted(scope) || brandHalted(ws),
    // 模块里没有谁会自己按急停；真按了也只能是全局那一份（品牌那一份走 `setHalted`）
    set: (scope, on, reason) => options.globalHalt.set(scope, on, reason),
    state: () => {
      const global = options.globalHalt.state()
      if (!brandHalted(ws)) return global
      const reason = state.halted?.[ws]?.reason ?? '这个品牌的后台按了急停'
      const out = {} as Record<HaltScope, { on: boolean; reason?: string }>
      for (const scope of HALT_SCOPES)
        out[scope] = global[scope].on ? global[scope] : { on: true, reason }
      return out
    },
  })

  const status = (ws: WorkspaceId): BrandBackgroundView => {
    const tasks = options.scheduler()?.list({ workspace_id: ws }) ?? []
    const view = brandBackgroundStatus(tasks, {
      workspace_id: ws,
      halted: brandHalted(ws) || globalAll(),
      stopped: stopped(ws),
      exclude: (t) => t.handler !== undefined && PROCESS_HANDLERS.has(t.handler),
    })
    return { ...view, halted: brandHalted(ws), global_halted: globalAll() }
  }

  const pending = new Set<Promise<unknown>>()

  return {
    track(work) {
      const p = work
        .catch(() => undefined)
        .finally(() => {
          pending.delete(p)
        })
      pending.add(p)
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending])
    },
    isBrand,
    activeBrands: () => {
      const ids = new Set<WorkspaceId>([options.bootstrap])
      for (const w of options.brands()) ids.add(w.id)
      return [...ids].filter((ws) => !stopped(ws))
    },
    stopped,
    brandHalted,
    hold(task) {
      // 进程级家务不属于哪个品牌：品牌急停不停它们（全局急停由它们各自的档位管，老行为不动）
      if (task.handler !== undefined && PROCESS_HANDLERS.has(task.handler)) return false
      const ws = task.workspace_id
      if (!isBrand(ws)) return false
      return stopped(ws) || brandHalted(ws) || globalAll()
    },
    haltOf,
    setHalted(ws, on, by, reason) {
      const before = brandHalted(ws)
      const rows = { ...(state.halted ?? {}) }
      if (on)
        rows[ws] = {
          on: true,
          by,
          at: options.clock.now(),
          ...(reason === undefined ? {} : { reason }),
        }
      else delete rows[ws]
      state = { ...state, halted: rows }
      flush()
      if (before === on) return
      // 21 §1：谁在什么时候停了 / 放开了哪个品牌——事件记在**那个品牌**名下
      options.appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type: 'halt.changed',
        actor: { kind: 'person', id: by },
        correlation: { trace_id: `tr_bg_halt_${ws}` },
        payload: {
          scope: 'all',
          on,
          brand: ws,
          ...(reason === undefined ? {} : { reason }),
        },
      })
    },
    maxConcurrent: () => clampConcurrency(state.max_concurrent ?? DEFAULT_BACKGROUND_CONCURRENCY),
    setMaxConcurrent(n, by, ws) {
      const next = clampConcurrency(n)
      const before = clampConcurrency(state.max_concurrent ?? DEFAULT_BACKGROUND_CONCURRENCY)
      state = { ...state, max_concurrent: next }
      flush()
      if (before !== next)
        options.appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type: 'background.concurrency_changed',
          actor: { kind: 'person', id: by },
          correlation: { trace_id: 'tr_bg_concurrency' },
          payload: { from: before, to: next },
        })
      return next
    },
    status,
    settings(rows) {
      return {
        max_concurrent: clampConcurrency(state.max_concurrent ?? DEFAULT_BACKGROUND_CONCURRENCY),
        limits: { min: BACKGROUND_CONCURRENCY_MIN, max: BACKGROUND_CONCURRENCY_MAX },
        global_halted: globalAll(),
        brands: rows.map((r) => ({ ...status(r.workspace_id), name: r.name, current: r.current })),
        runs_on: 'this_device',
      }
    },
  }
}
