/**
 * 节奏（决策 555）：**只限速，不伪装**。
 *
 * - 同一个广告账户同一时间只做一件事；
 * - 每个账户每天写 ≤ 20 次（docs/57 投放岗的「每天最多 20 次变更」）、读报表 ≤ 2 次；
 * - 两步之间隔一个**固定**的时长（{@link STEP_GAP_MS}）。
 *
 * 这里**故意没有**随机数：不加抖动去「装得像人」、不改浏览器标识、不绕验证码。
 * 慢、少、不并发是限速；藏自动化痕迹是伪装，后者会撞上两家「规避系统」的条款（docs/101 §4）。
 * 测试钉住：同样的输入永远得出同样的等待时长。
 */

import type { ActionAccount, ActionPace } from './types.js'

export interface PaceLimits {
  writes_per_day: number
  reads_per_day: number
}

export const DEFAULT_PACE_LIMITS: PaceLimits = { writes_per_day: 20, reads_per_day: 2 }

/** 两步之间的固定间隔（毫秒）。固定，不随机。 */
export const STEP_GAP_MS = 1_500

/** 账户的键：`google_ads:1234567890`（客户 id 里的横杠去掉，免得同一个号记成两本账）。 */
export function accountKey(account: Pick<ActionAccount, 'platform' | 'id'>): string {
  return `${account.platform}:${account.id.replace(/[\s-]/gu, '').replace(/^act_/iu, '')}`
}

/** 本地日期（`2026-10-14`）。按这台电脑的时区算「一天」——用户说的「今天」就是这个。 */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

interface AccountLedger {
  day: string
  writes: number
  reads: number
  /** 正在做的那一件（没有就是空）。 */
  busy?: string
}

/** 落盘用的形状（本机服务存 JSON，插件存 `chrome.storage.local`）。 */
export type PaceState = Record<string, AccountLedger>

export type PaceVerdict = { ok: true } | { ok: false; why: string; reason: 'busy' | 'daily_cap' }

export class Pace {
  private readonly state: PaceState
  private readonly limits: PaceLimits
  private readonly dayOf: (ms: number) => string

  constructor(options?: {
    state?: PaceState
    limits?: PaceLimits
    /** 测试注入（默认按本机时区）。 */
    dayOf?: (ms: number) => string
  }) {
    this.state = structuredClone(options?.state ?? {})
    this.limits = options?.limits ?? DEFAULT_PACE_LIMITS
    this.dayOf = options?.dayOf ?? localDay
  }

  private ledger(key: string, nowMs: number): AccountLedger {
    const day = this.dayOf(nowMs)
    const hit = this.state[key]
    if (hit !== undefined && hit.day === day) return hit
    // 跨天：计数清零，但「正在做」的那一件不因为过了零点就忘掉
    const fresh: AccountLedger = {
      day,
      writes: 0,
      reads: 0,
      ...(hit?.busy === undefined ? {} : { busy: hit.busy }),
    }
    this.state[key] = fresh
    return fresh
  }

  /** 现在能不能开始这件。 */
  check(account: ActionAccount, pace: ActionPace, nowMs: number): PaceVerdict {
    const l = this.ledger(accountKey(account), nowMs)
    if (l.busy !== undefined)
      return { ok: false, reason: 'busy', why: '这个广告账户上一件还没做完，一次只做一件。' }
    if (pace === 'write' && l.writes >= this.limits.writes_per_day)
      return {
        ok: false,
        reason: 'daily_cap',
        why: `这个广告账户今天已经改了 ${l.writes} 次，到上限了，明天再做。`,
      }
    if (pace === 'read' && l.reads >= this.limits.reads_per_day)
      return {
        ok: false,
        reason: 'daily_cap',
        why: `这个广告账户今天已经读了 ${l.reads} 次报表，到上限了。`,
      }
    return { ok: true }
  }

  /**
   * 开始这件：占住账户、记一次数。**开始就记**，不等做完——
   * 做了一半被停下的写操作，也已经在后台里动过了。
   */
  begin(account: ActionAccount, pace: ActionPace, jobId: string, nowMs: number): PaceVerdict {
    const v = this.check(account, pace, nowMs)
    if (!v.ok) return v
    const l = this.ledger(accountKey(account), nowMs)
    l.busy = jobId
    if (pace === 'write') l.writes += 1
    else l.reads += 1
    return { ok: true }
  }

  /** 做完（不管结局）：放开账户。只放自己占的那一件。 */
  end(account: ActionAccount, jobId: string): void {
    const l = this.state[accountKey(account)]
    if (l !== undefined && l.busy === jobId) delete l.busy
  }

  /** 今天还剩几次。 */
  left(account: ActionAccount, nowMs: number): { writes: number; reads: number } {
    const l = this.ledger(accountKey(account), nowMs)
    return {
      writes: Math.max(0, this.limits.writes_per_day - l.writes),
      reads: Math.max(0, this.limits.reads_per_day - l.reads),
    }
  }

  snapshot(): PaceState {
    return structuredClone(this.state)
  }
}
