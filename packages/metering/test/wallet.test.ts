/**
 * 钱包的五条纪律，一条一个用例（49 §3 M4 + M6）。
 *
 * 之所以是这五条：它们各自对应一次"如果反过来做，用户会在哪一天骂人"——
 * 先扣永不过期的 → 送的那些到期清零；过期 lot 还能用 → 账面上有钱实际没有；
 * 结算不退差额 → 每次都按最坏情况收；并发不拦 → 两笔同时越线余额变负；
 * 计量事件混进正文 → 49 M6 直接破功。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeteringEvent } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteWalletStore } from '../src/sqlite-store.js'
import {
  assertMeteringEvent,
  MemoryWalletStore,
  Wallet,
  WalletError,
  type WalletEvent,
  type WalletStore,
} from '../src/wallet.js'

const T0 = '2026-09-15T00:00:00.000Z'

/** 一个可推进的假时钟 + 一个数着走的 id 源（这两样是钱包唯一的外部依赖）。 */
function harness(store: WalletStore = new MemoryWalletStore(), threshold = 50) {
  let at = T0
  let n = 0
  const events: WalletEvent[] = []
  const wallet = new Wallet({
    store,
    now: () => at,
    newId: (prefix) => `${prefix}_${++n}`,
    lowBalanceThreshold: threshold,
    onEvent: (e) => events.push(e),
  })
  return {
    wallet,
    store,
    events,
    tick(next: string) {
      at = next
    },
  }
}

const call = (over: Partial<Parameters<Wallet['reserve']>[0]> = {}) => ({
  org_id: 'org_1',
  workspace_id: 'ws_1',
  capability: 'data.kol.lookup',
  unit: 'call',
  quantity: 1,
  credits: 10,
  request_id: 'req_1',
  ...over,
})

describe('Wallet', () => {
  it('先扣有期限的，再扣永不过期的', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    h.wallet.topup({
      org_id: 'org_1',
      credits: 30,
      kind: 'granted',
      expires_at: '2026-10-01T00:00:00.000Z',
    })

    const r = h.wallet.reserve(call({ credits: 20 }))
    h.wallet.settle(r, { quantity: 1, credits: 20 })

    const b = h.wallet.balance('org_1')
    // 20 全从"送的"里扣：送的 30 → 10，买的 100 一分没动
    expect(b.granted).toBe(10)
    expect(b.purchased).toBe(100)
  })

  it('有期限的不够时溢出到永不过期的那一份', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    h.wallet.topup({
      org_id: 'org_1',
      credits: 30,
      kind: 'granted',
      expires_at: '2026-10-01T00:00:00.000Z',
    })
    const r = h.wallet.reserve(call({ credits: 50 }))
    h.wallet.settle(r, { quantity: 1, credits: 50 })
    const b = h.wallet.balance('org_1')
    expect(b.granted).toBe(0)
    expect(b.purchased).toBe(80)
  })

  it('过期的 lot 不算余额、也扣不到', () => {
    const h = harness()
    h.wallet.topup({
      org_id: 'org_1',
      credits: 30,
      kind: 'granted',
      expires_at: '2026-09-20T00:00:00.000Z',
    })
    h.wallet.topup({ org_id: 'org_1', credits: 40, kind: 'purchased' })
    expect(h.wallet.balance('org_1').granted).toBe(30)

    h.tick('2026-09-21T00:00:00.000Z')
    const b = h.wallet.balance('org_1')
    // 到点即清零，不是"还挂在那儿等对账"
    expect(b.granted).toBe(0)
    expect(b.available).toBe(40)
    expect(b.expiring).toEqual([])

    const r = h.wallet.reserve(call({ credits: 40 }))
    h.wallet.settle(r, { quantity: 1, credits: 40 })
    expect(h.wallet.balance('org_1').purchased).toBe(0)
  })

  it('预扣 → 结算：差额当场释放', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })

    const r = h.wallet.reserve(call({ credits: 40 }))
    // 预扣期间这 40 占住了：可用只剩 60
    expect(h.wallet.balance('org_1').reserved).toBe(40)
    expect(h.wallet.balance('org_1').available).toBe(60)

    h.wallet.settle(r, { quantity: 1, credits: 12 })
    const b = h.wallet.balance('org_1')
    expect(b.reserved).toBe(0)
    expect(b.purchased).toBe(88)
    expect(b.available).toBe(88)
  })

  it('调用失败：整笔释放，不计花费、不记计量事件', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const r = h.wallet.reserve(call({ credits: 40 }))
    h.wallet.release(r)
    expect(h.wallet.balance('org_1').available).toBe(100)
    expect(h.wallet.usage({ org_id: 'org_1', group: 'capability' }).rows).toEqual([])
  })

  it('并发两笔预扣越线：只拒后一笔，不冻结', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })

    const first = h.wallet.reserve(call({ credits: 70, request_id: 'req_a' }))
    expect(() => h.wallet.reserve(call({ credits: 70, request_id: 'req_b' }))).toThrow(WalletError)

    // 第一笔结算之后差额回来，同样的第二笔就过了——这就是"不冻结"的意思
    h.wallet.settle(first, { quantity: 1, credits: 10 })
    const second = h.wallet.reserve(call({ credits: 70, request_id: 'req_b' }))
    expect(second.credits).toBe(70)
  })

  it('余额不足的错误是人话，带够不够的两个数', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 5, kind: 'purchased' })
    try {
      h.wallet.reserve(call({ credits: 10 }))
      expect.unreachable('应该抛 insufficient_credits')
    } catch (err) {
      const e = err as WalletError
      expect(e.code).toBe('insufficient_credits')
      expect(e.message).toContain('积分不够了')
      expect(e.details).toMatchObject({ required: 10, available: 5 })
    }
  })

  it('余额低于阈值出一个事件，而且只出一次', () => {
    const h = harness(new MemoryWalletStore(), 50)
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })

    const a = h.wallet.reserve(call({ credits: 60 }))
    h.wallet.settle(a, { quantity: 1, credits: 60 })
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: 'wallet.low_balance', org_id: 'org_1' })

    const b = h.wallet.reserve(call({ credits: 5 }))
    h.wallet.settle(b, { quantity: 1, credits: 5 })
    // 还在阈值以下，但不再刷屏
    expect(h.events).toHaveLength(1)

    // 充回来再掉下去才会再报
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const c = h.wallet.reserve(call({ credits: 110 }))
    h.wallet.settle(c, { quantity: 1, credits: 110 })
    expect(h.events).toHaveLength(2)
  })

  it('充值幂等：同一个支付订单号只入一次账', () => {
    const h = harness()
    const first = h.wallet.topup({
      org_id: 'org_1',
      credits: 100,
      kind: 'purchased',
      source_ref: 'cs_test_1',
    })
    const again = h.wallet.topup({
      org_id: 'org_1',
      credits: 100,
      kind: 'purchased',
      source_ref: 'cs_test_1',
    })
    expect(again.id).toBe(first.id)
    expect(h.wallet.balance('org_1').purchased).toBe(100)
  })

  it('用量按能力 / 工作区 / 天各聚合一次', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 1000, kind: 'purchased' })
    const spend = (over: Parameters<typeof call>[0], credits: number) => {
      const r = h.wallet.reserve(call({ ...over, credits }))
      h.wallet.settle(r, { quantity: 1, credits })
    }
    spend({ capability: 'ai.chat', workspace_id: 'ws_1' }, 10)
    spend({ capability: 'ai.chat', workspace_id: 'ws_2' }, 20)
    h.tick('2026-09-16T00:00:00.000Z')
    spend({ capability: 'crawl.page', workspace_id: 'ws_1' }, 5)

    const byCapability = h.wallet.usage({ org_id: 'org_1', group: 'capability' })
    expect(byCapability.rows.map((r) => [r.key, r.credits])).toEqual([
      ['ai.chat', 30],
      ['crawl.page', 5],
    ])
    expect(byCapability.total_credits).toBe(35)

    expect(h.wallet.usage({ org_id: 'org_1', group: 'workspace' }).rows.map((r) => r.key)).toEqual([
      'ws_2',
      'ws_1',
    ])

    expect(h.wallet.usage({ org_id: 'org_1', group: 'day' }).rows.map((r) => r.key)).toEqual([
      '2026-09-15',
      '2026-09-16',
    ])

    // 成员只看自己工作区
    const mine = h.wallet.usage({ org_id: 'org_1', group: 'capability', workspace_id: 'ws_1' })
    expect(mine.total_credits).toBe(15)
  })
})

describe('计量事件的字段白名单（49 M6）', () => {
  const good: MeteringEvent = {
    capability: 'ai.chat',
    unit: '1k_tokens',
    quantity: 1.2,
    credits: 0.5,
    at: T0,
    org_id: 'org_1',
    workspace_id: 'ws_1',
    request_id: 'req_1',
  }

  it('八个字段的那条过', () => {
    expect(assertMeteringEvent({ ...good })).toEqual(good)
  })

  it('多一个字段就抛——正文永远进不来', () => {
    // 典型事故：从上游响应里 spread 一把过来
    const leaked = { ...good, prompt: '客户的订单号是 12345' } as unknown as MeteringEvent
    expect(() => assertMeteringEvent(leaked)).toThrow(/prompt/)
  })

  it('缺字段也抛', () => {
    const { org_id: _dropped, ...rest } = good
    expect(() => assertMeteringEvent(rest as MeteringEvent)).toThrow(/org_id/)
  })

  it('钱包记下来的每一条都通过白名单', () => {
    const h = harness()
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const r = h.wallet.reserve(call({ credits: 10 }))
    const event = h.wallet.settle(r, { quantity: 3, credits: 7 })
    expect(Object.keys(event).sort()).toEqual([
      'at',
      'capability',
      'credits',
      'org_id',
      'quantity',
      'request_id',
      'unit',
      'workspace_id',
    ])
  })
})

describe('sqlite 档与内存档同一套语义', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('落盘之后余额、扣费顺序、幂等、用量都一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wallet-'))
    dirs.push(dir)
    const store = createSqliteWalletStore({
      dbPath: join(dir, 'wallet.sqlite'),
      now: () => T0,
    })
    const h = harness(store)
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased', source_ref: 'cs_1' })
    h.wallet.topup({
      org_id: 'org_1',
      credits: 30,
      kind: 'granted',
      expires_at: '2026-10-01T00:00:00.000Z',
    })
    h.wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased', source_ref: 'cs_1' })

    const r = h.wallet.reserve(call({ credits: 50 }))
    expect(h.wallet.balance('org_1').reserved).toBe(50)
    h.wallet.settle(r, { quantity: 2, credits: 40 })

    const b = h.wallet.balance('org_1')
    expect(b.granted).toBe(0)
    expect(b.purchased).toBe(90)
    expect(b.reserved).toBe(0)
    expect(h.wallet.usage({ org_id: 'org_1', group: 'capability' }).total_credits).toBe(40)

    // 崩在 reserve 与 settle 之间留下的孤儿：扫掉，否则积分永远被占住
    h.wallet.reserve(call({ credits: 10, request_id: 'req_orphan' }))
    expect(store.sweepReservations('2026-09-16T00:00:00.000Z')).toBe(1)
    expect(h.wallet.balance('org_1').reserved).toBe(0)
    store.close()
  })
})
