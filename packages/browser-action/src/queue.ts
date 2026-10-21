/**
 * 排队（决策 558）：审批卡在哪儿都能批，批了排进这里，**等插件上线来领**。
 *
 * - 插件长轮询来领（{@link ActionQueue.claim}）：同一账户一次一件、每天限额都在领的那一刻判；
 * - 排队超过 24 小时还没被领走 → 作废（`expired`），由上层重出一张卡（{@link ActionQueue.sweep}）；
 * - 领走了却一直没回音（Chrome 被关了、插件崩了）→ 记成「没做成」交给人，**不自动重跑**：
 *   写操作做了一半，再跑一遍可能改两次；
 * - 用户随时能停（{@link ActionQueue.requestStop}）：还在排队的当场作废，正在跑的下一步之前停。
 *
 * 纯内存 + 快照（本机服务落 JSON），时钟注入，测试直接钉。
 */

import { checkPlanSteps } from './guard.js'
import type { Pace } from './pace.js'
import type { ActionJob, ActionJobStatus, ActionPlatform, ActionResult } from './types.js'
import { allowedZonesFor, type GuardedZoneSettings } from './zones.js'

/** 排队多久没人领就作废（决策 558）。 */
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000

/** 领走后多久没回音算「断了」。上传 + 平台出预览 + 人再确认一次，给足 45 分钟。 */
export const CLAIM_LEASE_MS = 45 * 60 * 1000

/**
 * WP432：「等你在插件里打开」的那几件留多久（7 天，与侧边栏留写的天数同一个数）。
 * 过了没打开就作废（照实说），不会自己开页面。
 */
export const HELD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * WP432（Luoye 10-20 反馈 9）：**Reddit 的写一律等人在插件侧边栏里点「打开这一条」才开页面**——
 * 批了只是批了，插件的定时领活永远领不到它（{@link ActionQueue.claim} 跳过），只有 {@link ActionQueue.open}
 * （人点的那一下）能把它交出去。这是公共模块里的一道底：本机服务忘了标也一样。
 */
export function needsHumanOpen(job: Pick<ActionJob, 'plan'>): boolean {
  return job.plan.platform === 'reddit' && job.plan.pace === 'write'
}

export interface JobProgress {
  step: number
  of: number
  label: string
}

export interface QueuedJob {
  job: ActionJob
  status: ActionJobStatus
  enqueued_at_ms: number
  claimed_at_ms?: number
  /** 最近一次回音（进度 / 截图 / 下载）。 */
  touched_at_ms?: number
  progress?: JobProgress
  stop_requested?: boolean
  /** WP432：等人在插件侧边栏里点「打开这一条」（定时领活领不到）。打开之后去掉。 */
  held?: boolean
  /** WP432：人点「打开这一条」的那一刻。 */
  opened_at_ms?: number
  /** 人在工坊卡上点了「确认提交」（横条上点的由插件自己知道）。 */
  confirmed?: boolean
  result?: ActionResult & { finished_at_ms: number }
}

export type QueueState = QueuedJob[]

/** 进队前的检查（本机服务调；都是「不进队 + 一句人话」，不抛）。 */
export function validateJob(
  job: ActionJob,
  options: { zones: GuardedZoneSettings },
): { ok: true; job: ActionJob } | { ok: false; why: string } {
  const plan = job.plan
  const steps = checkPlanSteps(plan.steps, plan.allow, plan.kind)
  if (!steps.ok) return { ok: false, why: `步骤表第 ${steps.index + 1} 步：${steps.why}` }
  if (plan.pace === 'write' && (job.approval_id === undefined || job.approval_id === ''))
    return { ok: false, why: '写操作必须带审批编号。' }
  if (plan.needs_sheet && job.sheet === undefined)
    return { ok: false, why: '这件事要上传表，但没带表。' }
  const zones = allowedZonesFor(plan.zones, options.zones, job.approval_level)
  if (!zones.ok) return { ok: false, why: zones.why }
  return { ok: true, job: { ...job, zones_allowed: zones.zones } }
}

const FINAL: readonly ActionJobStatus[] = [
  'done',
  'failed',
  'handover',
  'stopped',
  'rejected',
  'expired',
]

export function isFinal(status: ActionJobStatus): boolean {
  return FINAL.includes(status)
}

export class ActionQueue {
  private readonly jobs: QueuedJob[]
  private readonly pace: Pace
  private readonly paceFor: ((job: ActionJob) => Pace | undefined) | undefined
  private readonly ttlMs: number
  private readonly heldTtlMs: number
  private readonly leaseMs: number

  constructor(options: {
    pace: Pace
    /**
     * WP329：某类活改记在另一本账上（Reddit 的写活记在 WP328 巡查那一本：同一个号读写一次一件）。
     * 回 `undefined` 就用默认那一本。
     */
    paceFor?: (job: ActionJob) => Pace | undefined
    state?: QueueState
    ttlMs?: number
    heldTtlMs?: number
    leaseMs?: number
  }) {
    this.jobs = structuredClone(options.state ?? [])
    this.pace = options.pace
    this.paceFor = options.paceFor
    this.ttlMs = options.ttlMs ?? QUEUE_TTL_MS
    this.heldTtlMs = options.heldTtlMs ?? HELD_TTL_MS
    this.leaseMs = options.leaseMs ?? CLAIM_LEASE_MS
  }

  private paceOf(job: ActionJob): Pace {
    return this.paceFor?.(job) ?? this.pace
  }

  /**
   * 进队。同一个 id 不进两次（审批执行器重放时不会排出两件）。
   * WP432：`hold` = 等人在插件里点开（Reddit 的写不管给没给都是）。
   */
  enqueue(job: ActionJob, nowMs: number, options?: { hold?: boolean }): QueuedJob {
    const hit = this.jobs.find((j) => j.job.id === job.id)
    if (hit !== undefined) return hit
    const held = options?.hold === true || needsHumanOpen(job)
    const row: QueuedJob = {
      job,
      status: 'queued',
      enqueued_at_ms: nowMs,
      ...(held ? { held: true } : {}),
    }
    this.jobs.push(row)
    return row
  }

  /**
   * WP432：人在插件侧边栏里点了「打开这一条」——只有这一下能把等人的那件交出去（占住账户、记一次数）。
   * 不是等人的、已经开过的、限速领不走的回一句人话。
   */
  open(id: string, nowMs: number): QueuedJob | { why: string } {
    this.sweep(nowMs)
    const row = this.get(id)
    if (row === undefined) return { why: '找不到这一条。' }
    if (row.status !== 'queued')
      return {
        why: isFinal(row.status) ? '这一条已经结束了。' : '这一条已经打开了，在那个标签页里。',
      }
    if (row.held !== true && !needsHumanOpen(row.job)) return { why: '这一条不用在插件里打开。' }
    const v = this.paceOf(row.job).begin(row.job.account, row.job.plan.pace, row.job.id, nowMs)
    if (!v.ok) return { why: v.why }
    delete row.held
    row.status = 'running'
    row.opened_at_ms = nowMs
    row.claimed_at_ms = nowMs
    row.touched_at_ms = nowMs
    return row
  }

  /**
   * 到点清理：排队超时的作废、领走后断了音讯的记失败。回这一轮变了的那几件
   * （上层拿 `expired` 的去重出卡，拿 `failed` 的去告诉人）。
   */
  sweep(nowMs: number): QueuedJob[] {
    const changed: QueuedJob[] = []
    for (const row of this.jobs) {
      if (row.status === 'queued' && (row.held === true || needsHumanOpen(row.job))) {
        if (nowMs - row.enqueued_at_ms < this.heldTtlMs) continue
        row.status = 'expired'
        row.result = {
          outcome: 'failed',
          message: '等你在插件里打开，7 天没打开，这一条作废了（没发）。',
          step: 0,
          reads: {},
          finished_at_ms: nowMs,
        }
        changed.push(row)
        continue
      }
      if (row.status === 'queued' && nowMs - row.enqueued_at_ms >= this.ttlMs) {
        row.status = 'expired'
        row.result = {
          outcome: 'failed',
          message: '排了 24 小时没等到插件（电脑或 Chrome 没开），这张卡作废了，会重出一张。',
          step: 0,
          reads: {},
          finished_at_ms: nowMs,
        }
        changed.push(row)
        continue
      }
      if (row.status === 'running' || row.status === 'waiting_confirm') {
        const last = row.touched_at_ms ?? row.claimed_at_ms ?? row.enqueued_at_ms
        if (nowMs - last >= this.leaseMs) {
          row.status = 'failed'
          row.result = {
            outcome: 'failed',
            message:
              '插件那边断了（Chrome 被关了或插件重启了），没做完。去后台看一眼停在哪一步，不会自动重做。',
            step: row.progress?.step ?? 0,
            reads: {},
            finished_at_ms: nowMs,
          }
          this.paceOf(row.job).end(row.job.account, row.job.id)
          changed.push(row)
        }
      }
    }
    return changed
  }

  /**
   * 插件来领：按进队先后，挑第一件「平台对得上、账户空着、今天还有额度」的。
   * 领走那一刻就占住账户、记一次数（{@link Pace.begin}）。
   */
  claim(platforms: readonly ActionPlatform[], nowMs: number): QueuedJob | undefined {
    this.sweep(nowMs)
    for (const row of this.jobs) {
      if (row.status !== 'queued') continue
      // WP432：等人点开的那几件，定时领活永远领不到（Reddit 的写再加一道底）
      if (row.held === true || needsHumanOpen(row.job)) continue
      if (!platforms.includes(row.job.plan.platform)) continue
      const v = this.paceOf(row.job).begin(row.job.account, row.job.plan.pace, row.job.id, nowMs)
      if (!v.ok) continue
      row.status = 'running'
      row.claimed_at_ms = nowMs
      row.touched_at_ms = nowMs
      return row
    }
    return undefined
  }

  /** 排着的里面，因为限速暂时领不走的那几件（工作台上如实说「在等」）。 */
  waiting(nowMs: number): { id: string; why: string }[] {
    const out: { id: string; why: string }[] = []
    for (const row of this.jobs) {
      if (row.status !== 'queued' || row.held === true || needsHumanOpen(row.job)) continue
      const v = this.paceOf(row.job).check(row.job.account, row.job.plan.pace, nowMs)
      if (!v.ok) out.push({ id: row.job.id, why: v.why })
    }
    return out
  }

  /** 插件报进度。回「要不要停」「人在工坊里确认了没有」。 */
  progress(
    id: string,
    progress: JobProgress & { waiting_confirm?: boolean },
    nowMs: number,
  ): { stop: boolean; confirmed: boolean } | undefined {
    const row = this.get(id)
    if (row === undefined || isFinal(row.status)) return undefined
    row.progress = { step: progress.step, of: progress.of, label: progress.label }
    row.touched_at_ms = nowMs
    if (progress.waiting_confirm === true) row.status = 'waiting_confirm'
    else if (row.status === 'waiting_confirm') row.status = 'running'
    return { stop: row.stop_requested === true, confirmed: row.confirmed === true }
  }

  /** 截图 / 下载这类回音也算活着。 */
  touch(id: string, nowMs: number): void {
    const row = this.get(id)
    if (row !== undefined) row.touched_at_ms = nowMs
  }

  /** 工坊卡上点了「确认提交」。只有在等确认的那一件认。 */
  confirm(id: string): boolean {
    const row = this.get(id)
    if (row === undefined || (row.status !== 'waiting_confirm' && row.status !== 'running'))
      return false
    row.confirmed = true
    return true
  }

  /** 停。排着的当场作废；正在跑的标一下，插件下一步之前看到就停。 */
  requestStop(id: string, nowMs: number): QueuedJob | undefined {
    const row = this.get(id)
    if (row === undefined || isFinal(row.status)) return row
    if (row.status === 'queued') {
      row.status = 'stopped'
      row.result = {
        outcome: 'stopped',
        message: '还没开始就停了。',
        step: 0,
        reads: {},
        finished_at_ms: nowMs,
      }
      return row
    }
    row.stop_requested = true
    return row
  }

  /** 插件回结局。放开账户。 */
  finish(id: string, result: ActionResult, nowMs: number): QueuedJob | undefined {
    const row = this.get(id)
    if (row === undefined || isFinal(row.status)) return row
    row.status = result.outcome
    row.result = { ...result, finished_at_ms: nowMs }
    this.paceOf(row.job).end(row.job.account, row.job.id)
    return row
  }

  get(id: string): QueuedJob | undefined {
    return this.jobs.find((j) => j.job.id === id)
  }

  list(): readonly QueuedJob[] {
    return this.jobs
  }

  /** 完结超过 `keepMs` 的从队列里摘掉（账本里另有记录；这里只是排队）。 */
  prune(nowMs: number, keepMs: number): number {
    const before = this.jobs.length
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const row = this.jobs[i]
      if (row?.result !== undefined && nowMs - row.result.finished_at_ms > keepMs)
        this.jobs.splice(i, 1)
    }
    return before - this.jobs.length
  }

  snapshot(): QueueState {
    return structuredClone(this.jobs)
  }
}
