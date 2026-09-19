/*
 * 按月订阅的增值服务：扣费引擎（67 §3）。
 *
 * 引擎是**通用的**（红人营销是第一个实例，客服增值服务 WP124 是第二个），所以
 * 这个文件不测任何红人特有的东西——它只测钱怎么扣。每一条都是在防一类**会让
 * 用户看到自己被多扣钱**的事故：
 *
 * - 同一个 cycle 扣两次（定时任务重跑、机器重启、两台机器同时跑）；
 * - 两个服务在同一个月算出同一个幂等键，于是只扣一次（白送一个服务）；
 * - 欠费之后重新充钱，旧账未结又立刻起一个新 cycle，一个月扣两次；
 * - 赠送月被重复用掉；
 * - 取消之后还在继续扣。
 */
import type { ServiceSubscription } from '@agentsws/contracts'
import { emptySubscription, KOL_SERVICE_ID, SUPPORT_SERVICE_ID } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  cancelSubscription,
  chargeKeyOf,
  dueCharges,
  graceUntil,
  grantSubscriptionMonths,
  startSubscription,
  subscriptionPaid,
  subscriptionStatusAt,
  subscriptionUnpaid,
} from '../src/subscription.js'

const T0 = '2026-01-31T04:00:00.000Z'
const KEY = `sub:${KOL_SERVICE_ID}:org_1`
const sub0 = (): ServiceSubscription => emptySubscription('org_1', KOL_SERVICE_ID, T0)
const keys = (charges: { charge_key: string }[]): string[] => charges.map((c) => c.charge_key)
/** 每次都要传的那两个：订阅本身 + 这个服务每月多少积分（引擎不认识价目表）。 */
const due = (args: {
  sub: ServiceSubscription
  now: string
  charged: Set<string>
  maxCycles?: number
}) => dueCharges({ credits_per_month: 30, ...args })

describe('幂等键', () => {
  it('只由 org 与 cycle 起始那一天决定——没有时间戳、没有随机数', () => {
    // 两个时刻在**上海的挂历上**是同一天（12:00 与 23:59），所以是同一串
    const a = chargeKeyOf(KOL_SERVICE_ID, 'org_1', '2026-02-28T04:00:00.000Z')
    const b = chargeKeyOf(KOL_SERVICE_ID, 'org_1', '2026-02-28T15:59:59.000Z')
    expect(a).toBe(b)
    expect(a).toBe(`${KEY}:2026-02-28`)
  })

  it('按 Asia/Shanghai 的挂历算，不看本机时区', () => {
    // UTC 是 2 月 27 日 20:00，上海已经是 2 月 28 日
    expect(chargeKeyOf(KOL_SERVICE_ID, 'org_1', '2026-02-27T20:00:00.000Z')).toBe(
      `${KEY}:2026-02-28`,
    )
  })
})

describe('该扣哪几个 cycle', () => {
  it('刚开通就该扣第一期 30 积分', () => {
    const sub = startSubscription(sub0(), T0)
    const charges = due({ sub, now: T0, charged: new Set() })
    expect(charges).toHaveLength(1)
    expect(charges[0]?.credits).toBe(30)
    expect(charges[0]?.cycle_start).toBe(T0)
  })

  it('已经扣过的那一期不再出现——定时任务重跑十遍也只扣一次', () => {
    const sub = startSubscription(sub0(), T0)
    const first = due({ sub, now: T0, charged: new Set() })
    const charged = new Set(keys(first))
    expect(due({ sub, now: T0, charged })).toEqual([])
    // 同一天再跑一次、再跑一次
    expect(due({ sub, now: '2026-01-31T23:00:00.000Z', charged })).toEqual([])
  })

  it('停机一阵子回来会把落下的几期一起补上（不是只补一期）', () => {
    const sub = startSubscription(sub0(), T0)
    const charges = due({ sub, now: '2026-04-05T00:00:00.000Z', charged: new Set() })
    // 1 月 31、2 月 28（日号收回来）、3 月 31 —— 4 月 5 号还没到 4 月的边界（4 月 30）
    expect(keys(charges)).toEqual([`${KEY}:2026-01-31`, `${KEY}:2026-02-28`, `${KEY}:2026-03-31`])
  })

  it('1 月 31 日开通，2 月那期从 2 月 28 日起（日号超界要收回来）', () => {
    const sub = startSubscription(sub0(), T0)
    const charges = due({ sub, now: '2026-03-01T00:00:00.000Z', charged: new Set() })
    expect(charges[1]?.cycle_start.slice(0, 10)).toBe('2026-02-28')
  })

  it('anchor 被写坏成很久以前也不会一次扣几十个月（上限兜底）', () => {
    const sub = { ...startSubscription(sub0(), '2020-01-01T00:00:00.000Z') }
    const charges = due({ sub, now: T0, charged: new Set(), maxCycles: 3 })
    expect(charges).toHaveLength(3)
  })

  it('没开通过的组织什么也不该扣', () => {
    expect(due({ sub: sub0(), now: T0, charged: new Set() })).toEqual([])
  })

  it('赠送月抵掉的那几期是 0 积分，且一个月只用一次', () => {
    const sub = grantSubscriptionMonths(startSubscription(sub0(), T0), 2, T0)
    const charges = due({ sub, now: '2026-04-05T00:00:00.000Z', charged: new Set() })
    expect(charges.map((c) => [c.credits, c.granted])).toEqual([
      [0, true],
      [0, true],
      [30, false],
    ])
  })
})

describe('扣成 / 扣不成之后', () => {
  it('扣成了：当期推进、赠送月减一、欠费那两格清掉', () => {
    let sub = grantSubscriptionMonths(startSubscription(sub0(), T0), 1, T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    expect(charge).toBeDefined()
    if (charge === undefined) return
    sub = subscriptionPaid(sub, charge, T0)
    expect(sub.status).toBe('active')
    expect(sub.granted_months).toBe(0)
    expect(sub.last_charged_cycle_start).toBe(T0)
    expect(sub.unpaid_since).toBeUndefined()
    expect(sub.grace_until).toBeUndefined()
  })

  it('余额不够：进宽限 30 天，**一条数据都不动**', () => {
    let sub = startSubscription(sub0(), T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    if (charge === undefined) throw new Error('该有一期')
    sub = subscriptionUnpaid(sub, charge, T0)
    expect(sub.status).toBe('grace')
    expect(sub.unpaid_since).toBe(T0)
    expect(sub.grace_until).toBe(graceUntil(T0))
    // 订阅记录里没有任何「删」的动作可以表达——数据面根本不在这个类型里
    expect(Object.keys(sub)).not.toContain('deleted')
  })

  it('宽限里每天跑一次定时任务，不会把宽限期一直往后推', () => {
    let sub = startSubscription(sub0(), T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    if (charge === undefined) throw new Error('该有一期')
    sub = subscriptionUnpaid(sub, charge, T0)
    const until = sub.grace_until
    sub = subscriptionUnpaid(sub, charge, '2026-02-10T00:00:00.000Z')
    expect(sub.grace_until).toBe(until)
  })

  it('宽限期过了就是 suspended（读的时候算，不靠谁来改库）', () => {
    let sub = startSubscription(sub0(), T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    if (charge === undefined) throw new Error('该有一期')
    sub = subscriptionUnpaid(sub, charge, T0)
    expect(subscriptionStatusAt(sub, '2026-02-15T00:00:00.000Z')).toBe('grace')
    expect(subscriptionStatusAt(sub, '2026-03-15T00:00:00.000Z')).toBe('suspended')
  })

  it('欠费之后充上钱回来：沿用旧 anchor，这个月不会被扣两次', () => {
    let sub = startSubscription(sub0(), T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    if (charge === undefined) throw new Error('该有一期')
    sub = subscriptionUnpaid(sub, charge, T0)
    const back = startSubscription(sub, '2026-02-10T00:00:00.000Z')
    expect(back.anchor_at).toBe(T0)
    // 1 月那一期还没结，回来之后要扣的还是它，不是一个新起的 cycle
    expect(keys(due({ sub: back, now: '2026-02-10T00:00:00.000Z', charged: new Set() }))[0]).toBe(
      `${KEY}:2026-01-31`,
    )
  })
})

describe('取消', () => {
  it('当期用完为止：不立刻断、不退款', () => {
    let sub = startSubscription(sub0(), T0)
    const charge = due({ sub, now: T0, charged: new Set() })[0]
    if (charge === undefined) throw new Error('该有一期')
    sub = subscriptionPaid(sub, charge, T0)
    sub = cancelSubscription(sub, '2026-02-05T00:00:00.000Z')
    expect(sub.status).toBe('cancelling')
    // 当期还在，照样能同步
    expect(subscriptionStatusAt(sub, '2026-02-10T00:00:00.000Z')).toBe('cancelling')
    // 当期过完，真的结束
    expect(subscriptionStatusAt(sub, '2026-03-10T00:00:00.000Z')).toBe('none')
  })

  it('取消之后不再产生新的 cycle——当期的末尾就是界线', () => {
    let sub = startSubscription(sub0(), T0)
    const first = due({ sub, now: T0, charged: new Set() })
    if (first[0] === undefined) throw new Error('该有一期')
    sub = subscriptionPaid(sub, first[0], T0)
    sub = cancelSubscription(sub, T0)
    const later = due({
      sub,
      now: '2026-05-01T00:00:00.000Z',
      charged: new Set(keys(first)),
    })
    expect(later).toEqual([])
  })

  it('没开通过的组织点取消，什么也不发生', () => {
    expect(cancelSubscription(sub0(), T0).status).toBe('none')
  })
})
