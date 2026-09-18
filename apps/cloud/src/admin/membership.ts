/**
 * 会员的续发（65 §7）。
 *
 * 开通时把 term 拆成 N 个 cycle 落库，**但只发已经到点的那几个**；剩下的由
 * WP110 的进程内定时顺带跑（`maintenance.ts` 每十分钟一次）。
 *
 * 幂等靠三道，缺一道都出过事：
 *
 * 1. `grant_key` 由 `(term_id, cycle 起始日)` 推导，**没有时间戳**；
 * 2. 发之前先看 `granted_at` 是不是空的；
 * 3. 真发的时候把 `grant_key` 当 `source_ref` 传给钱包——`wallet_lots` 上
 *    `(org_id, source_ref)` 有唯一索引，逻辑漏判一次库也会挡回来。
 *
 * KefuAgent 就是在第 1 道上栽的：key 里带了 `Date.now()`，定时任务每跑一次就
 * 重发一次，一个月白送出去十几万积分。
 */

import type { Clock, MembershipPlan } from '@agentsws/contracts'
import type { Wallet } from '@agentsws/metering'
import { addCalendarMonths, planById } from '@agentsws/metering'
import type { AdminStore } from './store.js'

export interface GrantRunResult {
  granted: number
  credits: number
  /** 发出去的那几笔（审计用）。 */
  lots: { org_id: string; term_id: string; grant_key: string; credits: number; lot_id: string }[]
}

/**
 * 把到点该发的 cycle 都发掉。
 *
 * 送的是 **`granted`** 那一类积分（到期清零，49 §3），到期日 = 这个 cycle 的
 * `ends_at`——**被 term 末尾封顶**。term 到 3 月 10 日结束，3 月那笔积分不该
 * 活到 4 月 1 日。
 */
export function runDueGrants(
  admin: AdminStore,
  wallet: Wallet | undefined,
  clock: Clock,
  options: { limit?: number; warn?: (line: string) => void } = {},
): GrantRunResult {
  const out: GrantRunResult = { granted: 0, credits: 0, lots: [] }
  if (wallet === undefined) return out
  const now = clock.now()
  admin.expireTerms(now)
  for (const cycle of admin.dueCycles(now, options.limit ?? 200)) {
    try {
      const lot = wallet.topup({
        org_id: cycle.org_id,
        credits: cycle.credits,
        kind: 'granted',
        expires_at: cycle.ends_at,
        // 第三道闸：同一个 grant_key 在同一个组织里只入一次账
        source_ref: cycle.grant_key,
      })
      admin.markCycleGranted(cycle.id, now, lot.id)
      admin.audit({
        action: 'membership.cycle_grant',
        actor_account_id: 'system',
        actor_role: 'system',
        target_kind: 'org',
        target_id: cycle.org_id,
        outcome: 'done',
        details: { term_id: cycle.term_id, cycle: cycle.index, credits: cycle.credits },
      })
      out.granted += 1
      out.credits += cycle.credits
      out.lots.push({
        org_id: cycle.org_id,
        term_id: cycle.term_id,
        grant_key: cycle.grant_key,
        credits: cycle.credits,
        lot_id: lot.id,
      })
    } catch (err) {
      /*
       * 一个 cycle 发失败不该让整轮停下来——后面那些人的会员积分与这一个无关。
       * 失败也记一条审计（`failed`），否则"为什么这个月没发"没人答得上来。
       */
      const warn = options.warn ?? ((line: string) => process.stderr.write(line))
      warn(`[membership] cycle ${cycle.id} 发失败：${String(err)}\n`)
      admin.audit({
        action: 'membership.cycle_grant',
        actor_account_id: 'system',
        actor_role: 'system',
        target_kind: 'org',
        target_id: cycle.org_id,
        outcome: 'failed',
        details: { term_id: cycle.term_id, cycle: cycle.index },
      })
    }
  }
  return out
}

/**
 * 这个组织现在的 anchor：有过 term 就沿用最早那个的（**调档不重新起算**），
 * 没有就用现在。
 *
 * 为什么沿用：从月付换成年付如果把所有 cycle 边界都推到今天，这个月就会发两次。
 */
export function anchorFor(admin: AdminStore, org_id: string, now: string): string {
  const terms = admin.terms({ org_id, limit: 500 })
  if (terms.length === 0) return now
  return terms.reduce((earliest, t) => (t.anchor_at < earliest ? t.anchor_at : earliest), now)
}

/** 档位；表里没有就抛一句人话（不猜一个默认档——那会静默地发错积分）。 */
export function planOrThrow(plan_id: string): MembershipPlan {
  const plan = planById(plan_id)
  if (plan === undefined) throw new Error(`没有「${plan_id}」这个会员档位`)
  return plan
}

/** 下一个 cycle 什么时候开始（抽屉里显示"下次发放"）。 */
export const nextCycleStart = (anchor_at: string, index: number): string =>
  addCalendarMonths(anchor_at, index)
