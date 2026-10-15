/**
 * WP337（Luoye 10-15）：点「重启并更新」时还有任务在做——**暂停全部 → 重启 → 新版起来自动接着做**。
 *
 * 三类任务（桌面壳弹窗上的「还有 N 件在做」就是这三类加起来）：
 *
 * | 类 | 是什么 | 暂停 | 恢复 |
 * |---|---|---|---|
 * | 正在输出 | 岗位 AI 正在跑的运行（所有已装起来的品牌） | 在安全点停下（`runtime.pauseRun`）：已经说的话、取回的数据作为部分结果挂上，时间线记「因更新暂停」 | 新版起来后按同一个人、同一条分配「接着跑」（会话引用在，能从断点续）；事项没了 / 交接中就照实补一句、留「接着跑」给人点 |
 * | 后台作业 | 系统巡检（收信、对账、备份、每日计划……，`HANDLERS` 里那些）正在跑的 | 调度器 `hold`：到点也不动、不挪排期；正在跑的等它收尾（最多 10 秒） | 新进程本来就照常跑；没等到收尾的那几条清掉租约、补跑一次 |
 * | 定时任务 | 人建的定时与官方「自动化任务」正在跑或 15 分钟内要到点的 | 同上（`hold`） | `run_once_now` 的错过了由调度器补一次；`skip` 的在暂停期间错过的这里补一次 |
 *
 * 状态落盘 `<dataDir>/update-pause.json`；新版开机读到就**先删再做**——只恢复一次（中途再崩也不会恢复第二遍）。
 * 没重启成（自检没过、安装程序没起来、用户在等空闲时点了取消）走 `resume()`：在这个进程里原样放开、接着做。
 *
 * 不碰网络、不看系统时钟（时间经注入的 Clock）；运行与调度器都经 `deps` 注入，单测用替身跑满。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  UpdateBusyCounts,
  UpdateBusyItem,
  UpdateBusyKind,
  UpdateReadinessView,
  UpdateResumeSummary,
} from '@agentsws/api'
import type { Clock, Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'
import { DEFAULT_MISFIRE_GRACE_MS, type Scheduler, type ScheduleTask } from '@agentsws/schedule'

export const UPDATE_PAUSE_FILE = 'update-pause.json'
/** 定时任务「待触发」的窗口：这么久之内要到点的才算「在做」（远的重启几秒不影响它）。 */
export const SCHEDULED_SOON_MS = 15 * 60_000
/** 交给接着跑的那一次运行的话（与事项页「接着跑」同一段）。 */
export const RESUME_BRIEF =
  '接着上次没跑完的继续：已经查到的在上面，别重复取同样的数据，补齐剩下的再给结论。'
/** 时间线上「开始做了」那一行。 */
export const RESUME_TEXT = '更新好了，接着做'
/** 没接上时补的那一句。 */
export const RESUME_FAILED_TEXT = '更新前停下的这件事没能自动接着做，点「接着跑」继续'
/** 清单最多列几件（弹窗展开后看的）。 */
const MAX_ITEMS = 30

export type BusyKind = UpdateBusyKind
export type BusyItem = UpdateBusyItem
export type BusyCounts = UpdateBusyCounts
export type { UpdateReadinessView, UpdateResumeSummary }

/** 一次正在跑的运行（各品牌的运行时汇总上来）。 */
export interface LiveRun {
  workspace_id: WorkspaceId
  matter_id: string
  run_id: string
  title: string
  person_id: PersonId
  assignment_id: string
}

interface PauseRecord {
  version: 1
  reason: 'update'
  paused_at: Iso8601
  to?: string
  runs: LiveRun[]
  /** 暂停时还在跑、没等到收尾的调度器任务 id。 */
  interrupted: string[]
  counts: BusyCounts
}

export interface UpdatePauseDeps {
  clock: Clock
  /** 不给 = 内存档（不落盘，重启后无从恢复）。 */
  dbDir?: string
  runs(): LiveRun[]
  /** 在安全点停下这一次（`runtime.pauseRun`）。 */
  pauseRun(run: LiveRun): Promise<boolean>
  /** 接着做（起来就回；起不来就抛）。 */
  resumeRun(run: LiveRun, brief: string, text: string): Promise<void>
  /** 没接上：时间线补一句。 */
  note(run: LiveRun, text: string): Promise<void> | void
  scheduler(): Scheduler | undefined
  /** 这条是系统巡检（后台作业）；其余算定时 / 自动化任务。 */
  isBackground(task: ScheduleTask): boolean
  log?(message: string, fields?: Record<string, unknown>): void
  /** 等正在跑的后台 / 定时收尾最多多久（默认 10 秒）。 */
  settleMs?: number
  sleep?(ms: number): Promise<void>
}

export interface UpdatePause {
  /** 调度器的 `hold`：暂停着就谁都别触发。 */
  holding(): boolean
  readiness(): UpdateReadinessView
  pause(input?: { to?: string }): Promise<{ paused: BusyCounts }>
  /** 没重启成：在这个进程里放开、接着做。 */
  resume(): Promise<UpdateResumeSummary>
  /**
   * 开机：读回上一版落的记录（读到就删）。在调度器起来之前调；返回的 `finish` 在调度器起来之后调。
   * 没有记录回 `undefined`。
   */
  boot(): { finish(): Promise<UpdateResumeSummary> } | undefined
}

/** 调度器里所有任务（跨品牌）。 */
function allTasks(scheduler: Scheduler | undefined): ScheduleTask[] {
  if (scheduler === undefined) return []
  const out: ScheduleTask[] = []
  for (const ws of scheduler.store.workspaces()) out.push(...scheduler.list({ workspace_id: ws }))
  return out
}

/** 正在跑（租约没过）。 */
export function runningNow(task: ScheduleTask, nowMs: number): boolean {
  if (task.state !== 'running') return false
  const until = task.lease?.until
  return until === undefined || Date.parse(until) > nowMs
}

/** 待触发：照常排着、`windowMs` 之内（含已过点）要到点。 */
export function dueSoon(task: ScheduleTask, nowMs: number, windowMs = SCHEDULED_SOON_MS): boolean {
  if (task.state !== 'active' || task.next_fire_at === undefined) return false
  return Date.parse(task.next_fire_at) - nowMs <= windowMs
}

/** 三类各有哪些（清单按「正在输出 → 定时 → 后台」排）。 */
export function classifyBusy(input: {
  runs: readonly LiveRun[]
  tasks: readonly ScheduleTask[]
  nowMs: number
  isBackground: (task: ScheduleTask) => boolean
}): { counts: BusyCounts; items: BusyItem[] } {
  const output: BusyItem[] = input.runs.map((r) => ({ kind: 'output', title: r.title }))
  const scheduled: BusyItem[] = []
  const background: BusyItem[] = []
  for (const t of input.tasks) {
    const title = t.title ?? t.handler ?? t.id
    if (input.isBackground(t)) {
      if (runningNow(t, input.nowMs)) background.push({ kind: 'background', title })
    } else if (runningNow(t, input.nowMs) || dueSoon(t, input.nowMs))
      scheduled.push({ kind: 'scheduled', title })
  }
  return {
    counts: { output: output.length, background: background.length, scheduled: scheduled.length },
    items: [...output, ...scheduled, ...background].slice(0, MAX_ITEMS),
  }
}

function readRecord(file: string): PauseRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PauseRecord>
    if (raw.version !== 1 || typeof raw.paused_at !== 'string') return undefined
    return {
      version: 1,
      reason: 'update',
      paused_at: raw.paused_at,
      ...(typeof raw.to === 'string' ? { to: raw.to } : {}),
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      interrupted: Array.isArray(raw.interrupted) ? raw.interrupted : [],
      counts: raw.counts ?? { output: 0, background: 0, scheduled: 0 },
    }
  } catch {
    return undefined
  }
}

export function createUpdatePause(deps: UpdatePauseDeps): UpdatePause {
  const file = deps.dbDir === undefined ? undefined : join(deps.dbDir, UPDATE_PAUSE_FILE)
  const log = (message: string, fields?: Record<string, unknown>): void =>
    deps.log?.(message, fields)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()))
  const nowMs = (): number => Date.parse(deps.clock.now())
  let holding = false
  /** 这个进程里暂停着的那一份（`resume()` 用）。 */
  let record: PauseRecord | undefined
  let lastResume: UpdateResumeSummary | undefined

  const flush = (): void => {
    if (file === undefined || deps.dbDir === undefined || record === undefined) return
    try {
      mkdirSync(deps.dbDir, { recursive: true })
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (err) {
      log('更新暂停记录写不进去（重启后只能靠人点「接着跑」）', { error: String(err) })
    }
  }
  const drop = (): void => {
    if (file === undefined) return
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch (err) {
      log('更新暂停记录删不掉', { error: String(err) })
    }
  }

  const snapshot = (): { counts: BusyCounts; items: BusyItem[] } =>
    classifyBusy({
      runs: deps.runs(),
      tasks: allTasks(deps.scheduler()),
      nowMs: nowMs(),
      isBackground: deps.isBackground,
    })

  /** 接着做一件：起不来就照实补一句（「接着跑」按钮照旧在）。 */
  const resumeOne = async (run: LiveRun): Promise<boolean> => {
    try {
      await deps.resumeRun(run, RESUME_BRIEF, RESUME_TEXT)
      return true
    } catch (err) {
      log('更新前停下的运行没能接着做', { matter_id: run.matter_id, error: String(err) })
      try {
        await deps.note(run, RESUME_FAILED_TEXT)
      } catch {
        // 事项都没了：没处可写
      }
      return false
    }
  }

  const resumeRuns = async (runs: readonly LiveRun[]): Promise<{ ok: number; failed: number }> => {
    let ok = 0
    let failed = 0
    // 同一件事只接一次（同一事项好几次在跑时接最近那一次就够了）
    const seen = new Set<string>()
    for (const run of [...runs].reverse()) {
      if (seen.has(run.matter_id)) continue
      seen.add(run.matter_id)
      if (await resumeOne(run)) ok += 1
      else failed += 1
    }
    return { ok, failed }
  }

  return {
    holding: () => holding,

    readiness() {
      const { counts, items } = snapshot()
      return {
        idle: counts.output === 0,
        paused: holding,
        counts,
        items,
        ...(lastResume === undefined ? {} : { last_resume: lastResume }),
      }
    },

    async pause(input = {}) {
      const before = snapshot().counts
      // 先拦住调度器：从这一刻起到点的一条都不触发（不挪排期）
      holding = true
      const runs = [...deps.runs()]
      await Promise.all(
        runs.map((r) =>
          deps.pauseRun(r).catch((err: unknown) => {
            log('暂停运行没成', { run_id: r.run_id, error: String(err) })
            return false
          }),
        ),
      )
      // 正在跑的后台 / 定时等它收尾（最多 settleMs）
      const limit = deps.settleMs ?? 10_000
      let still = allTasks(deps.scheduler()).filter((t) => runningNow(t, nowMs()))
      for (let waited = 0; still.length > 0 && waited < limit; waited += 250) {
        await sleep(250)
        still = allTasks(deps.scheduler()).filter((t) => runningNow(t, nowMs()))
      }
      const known = new Set((record?.runs ?? []).map((r) => r.run_id))
      record = {
        version: 1,
        reason: 'update',
        paused_at: record?.paused_at ?? deps.clock.now(),
        ...(input.to === undefined ? {} : { to: input.to }),
        runs: [...(record?.runs ?? []), ...runs.filter((r) => !known.has(r.run_id))],
        interrupted: [...new Set([...(record?.interrupted ?? []), ...still.map((t) => t.id)])],
        counts: before,
      }
      flush()
      log('因更新暂停全部', { ...before, interrupted: still.length })
      return { paused: before }
    },

    async resume() {
      holding = false
      const held = record
      record = undefined
      drop()
      const runs = await resumeRuns(held?.runs ?? [])
      lastResume = {
        at: deps.clock.now(),
        runs: runs.ok,
        failed: runs.failed,
        reran: 0,
        caught_up: 0,
      }
      log('没重启，暂停的放开了', { ...lastResume })
      return lastResume
    },

    boot() {
      if (file === undefined || !existsSync(file)) return undefined
      const held = readRecord(file)
      // 先删再做：这一份只恢复一次（下面哪一步崩了，下次开机也不会再来一遍）
      drop()
      if (held === undefined) {
        log('更新暂停记录读不懂，跳过')
        return undefined
      }
      // 调度器起来之前算好：哪些在暂停期间错过了（起来后第一拍会把 skip 的挪到下一次）
      const scheduler = deps.scheduler()
      const now = nowMs()
      const from = Date.parse(held.paused_at)
      const interrupted = new Set(held.interrupted)
      const missed = allTasks(scheduler).filter((t) => {
        if (t.state !== 'active' || t.next_fire_at === undefined || interrupted.has(t.id))
          return false
        const at = Date.parse(t.next_fire_at)
        return at >= from && now - at > (t.misfire_grace_ms ?? DEFAULT_MISFIRE_GRACE_MS)
      })
      return {
        async finish() {
          let reran = 0
          let caughtUp = 0
          const kick = (id: string, why: string): void => {
            void scheduler?.runNow(id).catch((err: unknown) => {
              log('补跑没成', { task_id: id, why, error: String(err) })
            })
          }
          for (const id of interrupted) {
            const t = scheduler?.get(id)
            if (t === undefined || t.state === 'cancelled' || t.state === 'paused') continue
            // 上一版没等到收尾留下的租约：清掉、补跑一次
            if (t.state === 'running')
              scheduler?.store.putTask({ ...t, state: 'active', lease: undefined })
            kick(id, 'interrupted')
            reran += 1
          }
          for (const t of missed) {
            // run_once_now 的由调度器第一拍补一次；skip 的这里补
            if (t.misfire_policy === 'skip') kick(t.id, 'missed')
            caughtUp += 1
          }
          const runs = await resumeRuns(held.runs)
          lastResume = {
            at: deps.clock.now(),
            runs: runs.ok,
            failed: runs.failed,
            reran,
            caught_up: caughtUp,
          }
          log('更新好了，暂停的接着做', { ...lastResume, from: held.paused_at })
          return lastResume
        },
      }
    },
  }
}
