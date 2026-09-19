/**
 * 红人营销增值服务的订阅（67 §3，WP118）。
 *
 * 机制**照搬 WP115 的 term / cycle**（`plans.ts`），只是方向反过来：会员是每个
 * 自然月**发**积分，这个是每个自然月**扣** 30 积分。三条纪律一条不改：
 *
 * 1. **幂等键不含时间戳**。`kolsvc:<org>:<cycle 起始那一天>`——同一个 cycle 在任何
 *    一次定时任务里算出来都是同一串。KefuAgent 曾经用 `Date.now()` 当 key，定时
 *    任务每跑一次就发一次，白送了一整个月。反过来（扣钱）犯这个错更贵：用户一个
 *    月被扣了 N 次 30 积分。
 * 2. **日历月按 `Asia/Shanghai` 算**（复用 `addCalendarMonths` / `shanghaiDate`）。
 *    换个机房、容器里没设 TZ，「这个月第一天」就漂一天，两台机器算出两个 key。
 * 3. **日号超界收回来**：1 月 31 日开通，2 月那个 cycle 从 2 月 28 日起。
 *
 * 这个文件**纯函数、无 IO、无时钟**：`now` 由调用方传，钱包由调用方调。它只回答
 * 「现在该扣哪几个 cycle」和「扣成 / 扣不成之后订阅变成什么样」。
 */
import {
  KOL_SERVICE_CREDITS_PER_MONTH,
  KOL_SERVICE_GRACE_DAYS,
  type KolServiceStatus,
  type KolServiceSubscription,
} from '@agentsws/contracts'
import { addCalendarMonths, shanghaiDate } from './plans.js'

/**
 * 幂等键：`kolsvc:<org_id>:<cycle 起始那一天>`。
 *
 * **没有时间戳、没有随机数**。它同时被当作计量事件的 `request_id`，所以就算
 * 定时任务重跑十遍，同一个 cycle 也只在账上出现一次。
 */
export const kolChargeKeyOf = (org_id: string, cycle_start: string): string =>
  `kolsvc:${org_id}:${shanghaiDate(cycle_start)}`

/** 一次该扣的费。`granted` 为真表示被赠送月抵掉了——照样记一条，只是 0 积分。 */
export interface KolCycleCharge {
  cycle_start: string
  cycle_end: string
  charge_key: string
  /** 要扣多少积分。赠送月是 0。 */
  credits: number
  /** 是不是赠送月抵掉的。 */
  granted: boolean
}

/** 宽限到哪天：欠上的那一刻 + 30 天。 */
export const kolGraceUntil = (unpaid_since: string): string =>
  new Date(Date.parse(unpaid_since) + KOL_SERVICE_GRACE_DAYS * 86_400_000).toISOString()

/**
 * 现在**真实**的状态。
 *
 * 存下来的那个 `status` 可能已经旧了：宽限期是靠时间过期的，没有谁会在那一刻
 * 跑过来改一行库。所以读的时候一律经这里算一遍——`grace` 过了点就是 `suspended`。
 */
export function kolStatusAt(sub: KolServiceSubscription, now: string): KolServiceStatus {
  if (sub.status === 'grace') {
    const until = sub.grace_until
    if (until !== undefined && now >= until) return 'suspended'
    return 'grace'
  }
  if (sub.status === 'cancelling') {
    const end = sub.current_cycle_end
    // 当期用完了，取消才真的生效
    if (end !== undefined && now >= end) return 'none'
    return 'cancelling'
  }
  return sub.status
}

/**
 * 现在该扣哪几个 cycle。
 *
 * 从 `anchor_at` 起一个月一个月往后数，取**起始时间已到、还没扣过**的那些。
 * `charged` 是已经扣过的 key 集合（调用方从库里读）。
 *
 * 为什么要能一次回好几个：机器停了一周、定时任务没跑，回来要把落下的补上。
 * 一次只补一个的话，用户白用了三个月。
 *
 * 上限 `maxCycles` 是一道保险：anchor 被写坏成 2020 年的话，不该一次扣掉 60 个月。
 */
export function dueKolCharges(args: {
  sub: KolServiceSubscription
  now: string
  charged: ReadonlySet<string>
  maxCycles?: number
}): KolCycleCharge[] {
  const { sub, now, charged } = args
  const anchor = sub.anchor_at
  if (anchor === undefined) return []
  if (sub.status === 'none') return []
  const limit = args.maxCycles ?? 24
  const nowMs = Date.parse(now)
  // 取消了就不再产生新的 cycle：当期用完为止
  const cancelling = sub.cancel_at_period_end
  let granted = sub.granted_months
  const out: KolCycleCharge[] = []
  for (let i = 0; i < limit + 1; i++) {
    const cycle_start = addCalendarMonths(anchor, i)
    if (Date.parse(cycle_start) > nowMs) break
    const cycle_end = addCalendarMonths(anchor, i + 1)
    const charge_key = kolChargeKeyOf(sub.org_id, cycle_start)
    if (charged.has(charge_key)) {
      // 已经扣过的那些也要把赠送月算掉，否则赠送会被重复用
      continue
    }
    if (cancelling && out.length > 0) break
    const useGrant = granted > 0
    if (useGrant) granted -= 1
    out.push({
      cycle_start,
      cycle_end,
      charge_key,
      credits: useGrant ? 0 : KOL_SERVICE_CREDITS_PER_MONTH,
      granted: useGrant,
    })
    if (out.length >= limit) break
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 状态迁移（纯函数：进去一个订阅，出来一个新的）                          */
/* ------------------------------------------------------------------ */

/**
 * 开通（或者欠费之后重新充上钱回来）。
 *
 * **anchor 的取法是这里唯一要想清楚的事**：
 *
 * - 从来没开通过 / 已经彻底结束（`none`）→ 用现在当新 anchor；
 * - 只是欠着（`grace` / `suspended`）→ **沿用旧 anchor**。不然这个月会被扣两次：
 *   旧 anchor 那个 cycle 的账还没结，新 anchor 又立刻产生一个新 cycle。
 * - 点过取消但当期还没完（`cancelling`）→ 也沿用旧 anchor，只是把取消撤掉。
 */
export function startKolSubscription(
  sub: KolServiceSubscription,
  now: string,
): KolServiceSubscription {
  const live = kolStatusAt(sub, now)
  const anchor = live === 'none' ? now : (sub.anchor_at ?? now)
  const next: KolServiceSubscription = {
    ...sub,
    status: 'active',
    started_at: sub.started_at ?? now,
    anchor_at: anchor,
    cancel_at_period_end: false,
    updated_at: now,
  }
  // 欠费那两格清掉：钱充上了，宽限就不存在了
  delete next.unpaid_since
  delete next.grace_until
  return next
}

/**
 * 取消：**当期用完为止**，不立刻断、不退款、不删数据。
 *
 * 为什么不立刻断：用户这个月的 30 积分已经扣了。立刻断等于我们收了钱不给服务。
 */
export function cancelKolSubscription(
  sub: KolServiceSubscription,
  now: string,
): KolServiceSubscription {
  const live = kolStatusAt(sub, now)
  // 还没开通过就没有「取消」这回事
  if (live === 'none') return { ...sub, status: 'none', updated_at: now }
  return { ...sub, status: 'cancelling', cancel_at_period_end: true, updated_at: now }
}

/** 运营后台赠送 N 个月。赠送的那些 cycle 照常走流程，只是 0 积分。 */
export function grantKolMonths(
  sub: KolServiceSubscription,
  months: number,
  now: string,
): KolServiceSubscription {
  if (!Number.isInteger(months) || months < 1) throw new Error('赠送月数要是 1 以上的整数')
  const base = kolStatusAt(sub, now) === 'active' ? sub : startKolSubscription(sub, now)
  return { ...base, granted_months: base.granted_months + months, updated_at: now }
}

/**
 * 扣费成功之后的订阅。
 *
 * 赠送月用掉一个；`current_cycle_*` 推到这一期；欠费那两格清掉（这一期的账结了，
 * 之前欠的那一期也已经由它自己的 charge 结掉了）。
 */
export function kolChargePaid(
  sub: KolServiceSubscription,
  charge: KolCycleCharge,
  now: string,
): KolServiceSubscription {
  const next: KolServiceSubscription = {
    ...sub,
    status: sub.cancel_at_period_end ? 'cancelling' : 'active',
    started_at: sub.started_at ?? charge.cycle_start,
    current_cycle_start: charge.cycle_start,
    current_cycle_end: charge.cycle_end,
    granted_months: charge.granted ? Math.max(0, sub.granted_months - 1) : sub.granted_months,
    last_charge_at: now,
    last_charged_cycle_start: charge.cycle_start,
    updated_at: now,
  }
  delete next.unpaid_since
  delete next.grace_until
  return next
}

/**
 * 余额不够，这一期扣不上。
 *
 * **不删任何数据、不退订**：进 `grace`，宽限 30 天，同步暂停。已经在宽限里的
 * 不刷新 `unpaid_since`——不然每天跑一次定时任务就等于永远宽限。
 */
export function kolChargeUnpaid(
  sub: KolServiceSubscription,
  charge: KolCycleCharge,
  now: string,
): KolServiceSubscription {
  const unpaid_since = sub.unpaid_since ?? now
  return {
    ...sub,
    status: 'grace',
    started_at: sub.started_at ?? charge.cycle_start,
    current_cycle_start: charge.cycle_start,
    current_cycle_end: charge.cycle_end,
    unpaid_since,
    grace_until: kolGraceUntil(unpaid_since),
    updated_at: now,
  }
}
