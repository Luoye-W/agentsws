/**
 * 事件日志一致性套件（21 §6）——**同一份用例，两个方言各跑一遍**。
 *
 * 用例编号对着 21 §6：
 * 1. 任何对事件表的 UPDATE / DELETE 被数据层拒绝（这里直连 SQL 打，绕开应用层）
 * 2. 写入旧版 schema 的记录被拒；读旧版记录经迁移器返回最新形状
 * 3. 无 workspace_id 的记录写入被拒
 * 另加 21 §1 的哈希链与读过滤——它们是「不可篡改」这条纪律在 Postgres 上
 * 也成立的证据，不能只在 SQLite 上验。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import type { SqlDriver } from '@agentsws/core/sql'
import { describe, expect, it } from 'vitest'
import { FixedClock, seededRandom } from '../src/clock.js'
import { collect } from '../src/event-log-sql.js'
import type { SqlEventLog } from '../src/sql-event-log.js'

const WS = 'ws_1'

export interface EventLogBackend {
  name: string
  /** 每个用例一套干净的表。 */
  open(schemaVersion?: number): Promise<{ log: SqlEventLog; driver: SqlDriver }>
  dispose(handle: { log: SqlEventLog; driver: SqlDriver }): Promise<void>
  skip?: boolean
}

function event(overrides: Partial<EventEnvelope> = {}): Parameters<SqlEventLog['append']>[0] {
  return {
    schema_version: 1,
    workspace_id: WS,
    type: 'approval.decided',
    actor: { kind: 'person', id: 'p_1' },
    correlation: { trace_id: 't_1' },
    payload: { decision: 'approve' },
    ...overrides,
  } as Parameters<SqlEventLog['append']>[0]
}

export function runEventLogConformance(backend: EventLogBackend): void {
  const run = describe.skipIf(backend.skip === true)

  run(`事件日志一致性 · ${backend.name}`, () => {
    const withLog = async (
      fn: (log: SqlEventLog, driver: SqlDriver) => Promise<void>,
      schemaVersion?: number,
    ): Promise<void> => {
      const handle = await backend.open(schemaVersion)
      try {
        await fn(handle.log, handle.driver)
      } finally {
        await backend.dispose(handle)
      }
    }

    it('用例 1：直连 SQL 的 UPDATE / DELETE 被存储层拒绝', async () => {
      await withLog(async (log, driver) => {
        await log.append(event())
        await expect(driver.exec(`UPDATE events SET payload = '{}'`)).rejects.toThrow(
          /append-only: UPDATE rejected/,
        )
        await expect(driver.exec('DELETE FROM events')).rejects.toThrow(
          /append-only: DELETE rejected/,
        )
        expect(await log.readAll({ workspace_id: WS })).toHaveLength(1)
      })
    })

    it('用例 2 前半：写入非当前版本的记录被拒', async () => {
      await withLog(async (log) => {
        await expect(log.append(event({ schema_version: 0 }))).rejects.toThrow(
          /current schema_version/,
        )
        await expect(log.append(event({ schema_version: 2 }))).rejects.toThrow(
          /current schema_version/,
        )
      })
    })

    it('用例 2 后半：旧版记录读出来经迁移器升到最新形状', async () => {
      await withLog(async (log) => {
        await log.appendHistorical(event({ schema_version: 1, payload: { old: true } }) as never)
        log.registerUpcaster('approval.decided', 1, (payload) => ({
          ...(payload as object),
          migrated: true,
        }))
        const [first] = await log.readAll({ workspace_id: WS })
        expect(first?.schema_version).toBe(2)
        expect(first?.payload).toEqual({ old: true, migrated: true })
      }, 2)
    })

    it('用例 2 后半（缺环）：没注册迁移器就抛，不悄悄返回旧形状', async () => {
      await withLog(async (log) => {
        await log.appendHistorical(event({ schema_version: 1 }) as never)
        await expect(log.readAll({ workspace_id: WS })).rejects.toThrow(/no upcaster registered/)
      }, 2)
    })

    it('用例 3：无 workspace_id 拒写', async () => {
      await withLog(async (log) => {
        await expect(log.append(event({ workspace_id: '' }))).rejects.toThrow(
          /non-empty workspace_id/,
        )
        await expect(log.append(event({ correlation: { trace_id: '' } }))).rejects.toThrow(
          /non-empty correlation.trace_id/,
        )
      })
    })

    it('21 §1：prev_hash 串成链，verifyChain 通过', async () => {
      await withLog(async (log) => {
        const a = await log.append(event())
        const b = await log.append(event({ payload: { decision: 'reject' } }))
        expect(a.prev_hash).toBeUndefined()
        expect(b.prev_hash).toBeDefined()
        expect(await log.verifyChain(WS)).toEqual({ ok: true })
        expect(await log.verifyChain('ws_empty')).toEqual({ ok: true })
      })
    })

    it('21 §1：并发追加同一工作区也串成一条链', async () => {
      await withLog(async (log) => {
        await Promise.all([
          log.append(event({ payload: { n: 1 } })),
          log.append(event({ payload: { n: 2 } })),
          log.append(event({ payload: { n: 3 } })),
        ])
        expect(await log.verifyChain(WS)).toEqual({ ok: true })
        expect(await log.readAll({ workspace_id: WS })).toHaveLength(3)
      })
    })

    it('21 §1：读过滤全下推（since / 时间闭区间 / types / run_id / limit）', async () => {
      await withLog(async (log) => {
        const a = await log.append(event({ at: undefined }))
        await log.append(
          event({ type: 'run.completed', correlation: { trace_id: 't', run_id: 'r1' } }),
        )
        await log.append(event({ type: 'approval.decided' }))

        expect(await log.readAll({ workspace_id: WS, since: a.id })).toHaveLength(2)
        expect(await log.readAll({ workspace_id: WS, types: ['run.completed'] })).toHaveLength(1)
        expect(await log.readAll({ workspace_id: WS, types: [] })).toHaveLength(0)
        expect(await log.readAll({ workspace_id: WS, run_id: 'r1' })).toHaveLength(1)
        expect(await log.readAll({ workspace_id: WS, limit: 2 })).toHaveLength(2)
        expect(await log.readAll({ workspace_id: 'ws_other' })).toHaveLength(0)
        expect(
          await log.readAll({ workspace_id: WS, since_at: '2000-01-01T00:00:00.000Z' }),
        ).toHaveLength(3)
        expect(
          await log.readAll({ workspace_id: WS, until_at: '2000-01-01T00:00:00.000Z' }),
        ).toHaveLength(0)
      })
    })

    it('21 §1：replay(run_id) 与 read 的异步迭代面一致', async () => {
      await withLog(async (log) => {
        await log.append(event({ correlation: { trace_id: 't', run_id: 'r9' } }))
        await log.append(event())
        expect(await collect(log.replayRun('r9'))).toHaveLength(1)
        expect(await collect(log.read({ workspace_id: WS }))).toHaveLength(2)
      })
    })

    it('负载与密文原样回来（中文、嵌套、payload_encrypted）', async () => {
      await withLog(async (log) => {
        await log.append(
          event({
            payload: { 中文: '退款', nested: { a: [1, 2, 3] } },
            payload_encrypted: { key_id: 'k1', blob: 'AAAA' },
          }),
        )
        const [row] = await log.readAll({ workspace_id: WS })
        expect(row?.payload).toEqual({ 中文: '退款', nested: { a: [1, 2, 3] } })
        expect(row?.payload_encrypted).toEqual({ key_id: 'k1', blob: 'AAAA' })
      })
    })
  })
}

/** 两个档共用的时钟与随机源（ulid 可复现）。 */
export function deps(): { clock: FixedClock; random: ReturnType<typeof seededRandom> } {
  return { clock: new FixedClock('2026-09-10T00:00:00.000Z'), random: seededRandom(42) }
}
