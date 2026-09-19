/*
 * 红人营销增值服务：订阅闸门 + 双向同步（67 §3，WP118）。
 *
 * 派工单点名要钉住的四条全在这里：
 *
 * 1. 同一个 cycle 不重复扣费；
 * 2. 余额不足**不删数据**；
 * 3. 同步冲突**不丢数据**；
 * 4. 未订阅的 org 调同步接口回 402 **人话**。
 *
 * 钱包是**替身**（不联网、不花钱）：一个能记下被扣了几次、并且可以调成"没钱"的
 * 小对象。真钱包那一侧由 `packages/metering` 自己的测试覆盖。
 */
import type { KolSyncObject } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { KolCloudService } from '../src/service.js'
import { KolCloudStore } from '../src/store.js'
import { KolCloudError, type SqliteLike, type SubscriptionWallet } from '../src/types.js'

/* ------------------------------------------------------------------ */
/* 一个够用的内存 SQL 替身（这个包只用 sqlite 的很小一角）              */
/* ------------------------------------------------------------------ */

/** better-sqlite3 是原生模块、装它只为跑几条 SQL 不值当，所以用一个内存替身。 */
function memoryDb(): SqliteLike {
  const meta = new Map<string, string>()
  const objects = new Map<string, Record<string, unknown>>()
  const conflicts = new Map<string, Record<string, unknown>>()
  const subs = new Map<string, { service_id: string; json: string; last_sync_at: string | null }>()
  const charges = new Map<string, { charge_key: string; json: string; at: string }>()
  const audit: Record<string, unknown>[] = []

  const run = (sql: string, args: unknown[]): unknown => {
    if (sql.includes('INSERT INTO kol_cloud_meta')) {
      meta.set(String(args[0]), String(args[1]))
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_objects')) {
      const [kind, id, version, updated_at, writer, deleted, body, seq] = args
      objects.set(`${String(kind)}|${String(id)}`, {
        kind,
        id,
        version,
        updated_at,
        writer,
        deleted,
        body,
        seq,
      })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_conflicts')) {
      const [id, kind, object_id, winner, loser, at] = args
      const key = String(id)
      if (!conflicts.has(key))
        conflicts.set(key, { id, kind, object_id, winner, loser, at, resolved_at: null })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_subscription')) {
      const service_id = String(args[0])
      const prev = subs.get(service_id)
      subs.set(service_id, {
        service_id,
        json: String(args[1]),
        last_sync_at: prev?.last_sync_at ?? null,
      })
      return { changes: 1 }
    }
    if (sql.includes('UPDATE kol_cloud_subscription SET last_sync_at')) {
      const row = subs.get(String(args[1]))
      if (row !== undefined) row.last_sync_at = String(args[0])
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_charges')) {
      const key = String(args[0])
      if (!charges.has(key)) charges.set(key, { charge_key: key, json: String(args[1]), at: String(args[2]) })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_audit')) {
      const [seq, at, org_id, action, actor, note] = args
      audit.push({ seq, at, org_id, action, actor, note })
      return { changes: 1 }
    }
    if (sql.includes('UPDATE kol_cloud_conflicts SET resolved_at')) {
      const row = conflicts.get(String(args[1]))
      if (row !== undefined && row.resolved_at === null) row.resolved_at = args[0]
      return { changes: 1 }
    }
    throw new Error(`内存替身没实现这条 SQL：${sql}`)
  }

  const all = (sql: string, args: unknown[]): unknown[] => {
    if (sql.includes('FROM kol_cloud_objects')) {
      let rows = [...objects.values()]
      if (sql.includes('seq > ?')) {
        rows = rows.filter((r) => Number(r.seq) > Number(args[0]))
        if (sql.includes('writer <> ?')) rows = rows.filter((r) => r.writer !== args[1])
        rows.sort((a, b) => Number(a.seq) - Number(b.seq))
        const limit = Number(args[sql.includes('writer <> ?') ? 2 : 1])
        return rows.slice(0, limit)
      }
      if (sql.includes('GROUP BY kind')) {
        const counts = new Map<string, number>()
        for (const r of rows.filter((x) => r0(x)))
          counts.set(String(r.kind), (counts.get(String(r.kind)) ?? 0) + 1)
        return [...counts].sort().map(([kind, n]) => ({ kind, n }))
      }
      rows.sort((a, b) =>
        `${String(a.kind)}|${String(a.id)}`.localeCompare(`${String(b.kind)}|${String(b.id)}`),
      )
      return rows
    }
    if (sql.includes('FROM kol_cloud_conflicts'))
      return [...conflicts.values()].filter((c) => c.resolved_at === null)
    if (sql.includes('FROM kol_cloud_charges')) return [...charges.values()]
    if (sql.includes('FROM kol_cloud_audit')) return [...audit].reverse()
    throw new Error(`内存替身没实现这条查询：${sql}`)
  }
  // GROUP BY 那一支要按行过滤墓碑，抽出来免得上面那段读不懂
  const r0 = (row: Record<string, unknown>): boolean => Number(row.deleted) === 0

  const get = (sql: string, args: unknown[]): unknown => {
    if (sql.includes('FROM kol_cloud_meta')) {
      const v = meta.get(String(args[0]))
      return v === undefined ? undefined : { value: v }
    }
    if (sql.includes('COUNT(*) AS n FROM kol_cloud_objects'))
      return { n: [...objects.values()].filter(r0).length }
    if (sql.includes('COUNT(*) AS n FROM kol_cloud_conflicts'))
      return { n: [...conflicts.values()].filter((c) => c.resolved_at === null).length }
    if (sql.includes('FROM kol_cloud_objects'))
      return objects.get(`${String(args[0])}|${String(args[1])}`)
    if (sql.includes('FROM kol_cloud_subscription')) return subs.get(String(args[0]))
    throw new Error(`内存替身没实现这条查询：${sql}`)
  }

  return {
    exec(sql: string) {
      if (sql.startsWith('DELETE FROM kol_cloud_objects')) objects.clear()
      else if (sql.startsWith('DELETE FROM kol_cloud_conflicts')) conflicts.clear()
      return undefined
    },
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => run(sql, args),
        get: (...args: unknown[]) => get(sql, args),
        all: (...args: unknown[]) => all(sql, args),
      }
    },
    close() {},
  }
}

/** 钱包替身：记下被扣了几次，可以随时调成"没钱"。 */
function fakeWallet(): SubscriptionWallet & { charges: string[]; broke: boolean } {
  const state = {
    charges: [] as string[],
    broke: false,
    // eslint-disable-next-line @typescript-eslint/require-await
    async charge(args: { request_id: string; credits: number }) {
      if (state.broke)
        return { ok: false as const, reason: `积分不够了：这一次要 ${String(args.credits)} 积分，可用 4。` }
      state.charges.push(args.request_id)
      return { ok: true as const, credits: args.credits }
    },
  }
  return state
}

const PRINCIPAL = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: 'ws_1',
  scopes: ['kol'],
}

const T0 = '2026-01-31T04:00:00.000Z'

const obj = (over: Partial<KolSyncObject> = {}): KolSyncObject => ({
  kind: 'creator',
  id: 'c1',
  version: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  writer: 'device:a',
  body: { handle: 'someone' },
  ...over,
})

describe('红人营销增值服务', () => {
  let store: KolCloudStore
  let wallet: ReturnType<typeof fakeWallet>
  let service: KolCloudService
  let clock: string

  beforeEach(() => {
    store = new KolCloudStore(memoryDb())
    wallet = fakeWallet()
    clock = T0
    service = new KolCloudService({ store, wallet, now: () => clock })
  })

  describe('没订阅', () => {
    it('调同步接口回 402，一句人话，而且不是 403', async () => {
      await expect(async () => service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] }))
        .rejects.toBeInstanceOf(KolCloudError)
      try {
        service.status(PRINCIPAL)
        service.pull(PRINCIPAL, {})
        throw new Error('该拦住的')
      } catch (err) {
        expect(err).toBeInstanceOf(KolCloudError)
        if (!(err instanceof KolCloudError)) return
        expect(err.status).toBe(402)
        expect(err.message).toContain('还没开通')
        // 人话里不许有 org_id、表名、令牌
        expect(err.message).not.toContain('org_1')
      }
    })

    it('状态查得到（是 none，不是报错）——界面上那张卡总要有东西渲染', () => {
      const status = service.status(PRINCIPAL)
      expect(status.subscription.status).toBe('none')
      expect(status.object_count).toBe(0)
      expect(status.pending_conflicts).toBe(0)
    })
  })

  describe('开通与扣费', () => {
    it('开通当场扣第一期 30 积分', async () => {
      const sub = await service.subscribe(PRINCIPAL)
      expect(sub.status).toBe('active')
      expect(wallet.charges).toHaveLength(1)
      expect(wallet.charges[0]).toContain('kol.service.monthly:org_1')
    })

    it('同一个 cycle 不重复扣费——定时任务重跑十遍也只扣一次', async () => {
      await service.subscribe(PRINCIPAL)
      for (let i = 0; i < 10; i++) await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(1)
    })

    it('下个月到点了才扣第二期', async () => {
      await service.subscribe(PRINCIPAL)
      clock = '2026-02-10T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      // 2 月那一期从 2 月 28 日起（1 月 31 日开通，日号收界），10 号还没到
      expect(wallet.charges).toHaveLength(1)
      clock = '2026-03-02T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(2)
    })

    it('赠送的月份 0 积分，一分钱不碰钱包', async () => {
      service.grantMonths('org_1', 2)
      await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(0)
      expect(service.subscription('org_1').status).toBe('active')
    })
  })

  describe('余额不足', () => {
    it('进宽限、同步暂停，但**一条数据都不删**', async () => {
      await service.subscribe(PRINCIPAL)
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj(), obj({ id: 'c2' })] })
      expect(store.count()).toBe(2)

      wallet.broke = true
      clock = '2026-03-02T00:00:00.000Z'
      const result = await service.runBilling(PRINCIPAL)
      expect(result.at(-1)?.status).toBe('failed')
      expect(service.subscription('org_1').status).toBe('grace')
      // 数据还在
      expect(store.count()).toBe(2)
      // 同步暂停，而且那句话要说清楚数据没动
      expect(() => service.pull(PRINCIPAL, {})).toThrowError(/一条都没动/)
    })

    it('宽限期过了是 suspended，数据**还是**不删', async () => {
      await service.subscribe(PRINCIPAL)
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      wallet.broke = true
      clock = '2026-03-02T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      clock = '2026-05-02T00:00:00.000Z'
      expect(service.liveStatus('org_1')).toBe('suspended')
      expect(store.count()).toBe(1)
      expect(() => service.status(PRINCIPAL)).not.toThrow()
    })

    it('扣不上的那一期没记进账——充上钱回来还是扣它，用户不会白付一个月', async () => {
      await service.subscribe(PRINCIPAL)
      wallet.broke = true
      clock = '2026-03-02T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(1) // 只有 1 月那一期

      wallet.broke = false
      await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(2)
      expect(service.subscription('org_1').status).toBe('active')
    })
  })

  describe('双向同步', () => {
    beforeEach(async () => {
      await service.subscribe(PRINCIPAL)
    })

    it('第一次全量上行：来几条进几条', () => {
      const result = service.push(PRINCIPAL, {
        writer: 'device:a',
        objects: [obj(), obj({ id: 'c2' }), obj({ kind: 'collaboration', id: 'k1' })],
      })
      expect(result.accepted).toBe(3)
      expect(result.conflicts).toEqual([])
      expect(store.count()).toBe(3)
    })

    it('看过云端那一版之后再改（版本号更高）是干净覆盖，不算冲突', () => {
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      const result = service.push(PRINCIPAL, {
        writer: 'device:a',
        objects: [obj({ version: 2, updated_at: '2026-02-02T00:00:00.000Z' })],
      })
      expect(result.accepted).toBe(1)
      expect(result.conflicts).toEqual([])
    })

    it('两头各改各的：最后写入者胜，**输的那一份留着**', () => {
      // A 先推上去
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      // B 没看过 A 那一版（版本号一样），但改得更晚
      const result = service.push(PRINCIPAL, {
        writer: 'device:b',
        objects: [
          obj({ writer: 'device:b', updated_at: '2026-02-05T00:00:00.000Z', body: { handle: 'b' } }),
        ],
      })
      expect(result.conflicts).toHaveLength(1)
      const conflict = result.conflicts[0]
      expect(conflict?.winner.writer).toBe('device:b')
      expect(conflict?.loser.writer).toBe('device:a')
      // 输的那一份连正文一起留着——这是这一块最要紧的一条
      expect(conflict?.loser.body).toEqual({ handle: 'someone' })
      expect(store.openConflictCount()).toBe(1)
      expect(service.status(PRINCIPAL).pending_conflicts).toBe(1)
    })

    it('云端赢了的那一条回给本地（rejected），本地照着覆盖回去', () => {
      service.push(PRINCIPAL, {
        writer: 'device:a',
        objects: [obj({ updated_at: '2026-02-09T00:00:00.000Z' })],
      })
      const result = service.push(PRINCIPAL, {
        writer: 'device:b',
        objects: [obj({ writer: 'device:b', updated_at: '2026-02-05T00:00:00.000Z' })],
      })
      expect(result.accepted).toBe(0)
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]?.writer).toBe('device:a')
    })

    it('赢了的那一份版本号接着云端往上数——下次推同一条不会又判成冲突', () => {
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj({ version: 3 })] })
      service.push(PRINCIPAL, {
        writer: 'device:b',
        objects: [obj({ writer: 'device:b', version: 3, updated_at: '2026-02-05T00:00:00.000Z' })],
      })
      expect(store.object('creator', 'c1')?.version).toBe(4)
    })

    it('反复推一模一样的那一条：不写库、不记冲突', () => {
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      const before = store.cursor()
      const again = service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      expect(again.conflicts).toEqual([])
      expect(store.cursor()).toBe(before)
    })

    it('删除留墓碑：拉下来看得见，count 不算它', () => {
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      service.push(PRINCIPAL, {
        writer: 'device:a',
        objects: [obj({ version: 2, deleted: true, updated_at: '2026-02-03T00:00:00.000Z' })],
      })
      expect(store.count()).toBe(0)
      const pulled = service.pull(PRINCIPAL, { cursor: '0' })
      expect(pulled.objects.at(-1)?.deleted).toBe(true)
      expect(pulled.objects.at(-1)?.body).toBeUndefined()
    })

    it('下行按游标翻页，自己推上来的不回给自己', () => {
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj(), obj({ id: 'c2' })] })
      service.push(PRINCIPAL, { writer: 'device:b', objects: [obj({ id: 'c3', writer: 'device:b' })] })
      const forA = service.pull(PRINCIPAL, { cursor: '0', writer: 'device:a' })
      expect(forA.objects.map((o) => o.id)).toEqual(['c3'])
      // 再拉一次（带着新游标）就没有了
      expect(service.pull(PRINCIPAL, { cursor: forA.cursor, writer: 'device:a' }).objects).toEqual([])
    })

    it('一次推太多：回一句人话，让本地自己分批（不是默默截断）', () => {
      const many = Array.from({ length: 501 }, (_, i) => obj({ id: `c${String(i)}` }))
      expect(() => service.push(PRINCIPAL, { writer: 'device:a', objects: many })).toThrowError(
        /分几批/,
      )
    })

    it('认不出的种类当场拒，不猜一个', () => {
      expect(() =>
        service.push(PRINCIPAL, {
          writer: 'device:a',
          objects: [obj({ kind: 'orders' as never })],
        }),
      ).toThrowError(/认不出/)
    })
  })

  describe('用户的数据权利', () => {
    it('欠费也能导出——这时候拦着等于拿数据当人质', async () => {
      await service.subscribe(PRINCIPAL)
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      wallet.broke = true
      clock = '2026-03-02T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      const dump = service.exportAll(PRINCIPAL)
      expect(dump.objects).toHaveLength(1)
      expect(dump.format).toBe(1)
    })

    it('导出里带着输掉的那些冲突版本（不然「输的那一份」就真丢了）', async () => {
      await service.subscribe(PRINCIPAL)
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj()] })
      service.push(PRINCIPAL, {
        writer: 'device:b',
        objects: [obj({ writer: 'device:b', updated_at: '2026-02-05T00:00:00.000Z' })],
      })
      expect(service.exportAll(PRINCIPAL).conflicts).toHaveLength(1)
    })

    it('删云端这一份：订阅留着、账留着、审计留着', async () => {
      await service.subscribe(PRINCIPAL)
      service.push(PRINCIPAL, { writer: 'device:a', objects: [obj(), obj({ id: 'c2' })] })
      const result = service.deleteAll(PRINCIPAL)
      expect(result.deleted).toBe(2)
      expect(result.subscription_kept).toBe(true)
      expect(store.count()).toBe(0)
      expect(service.subscription('org_1').status).toBe('active')
      expect(store.charges()).toHaveLength(1)
      expect(store.audit().some((a) => a.action === 'delete')).toBe(true)
    })
  })

  describe('取消', () => {
    it('当期用完为止：还能同步，到期之后就不能了', async () => {
      await service.subscribe(PRINCIPAL)
      service.cancel(PRINCIPAL)
      clock = '2026-02-10T00:00:00.000Z'
      expect(() => service.pull(PRINCIPAL, {})).not.toThrow()
      clock = '2026-04-10T00:00:00.000Z'
      expect(() => service.pull(PRINCIPAL, {})).toThrowError(/还没开通/)
    })

    it('取消之后不再扣钱', async () => {
      await service.subscribe(PRINCIPAL)
      service.cancel(PRINCIPAL)
      clock = '2026-06-10T00:00:00.000Z'
      await service.runBilling(PRINCIPAL)
      expect(wallet.charges).toHaveLength(1)
    })
  })
})
