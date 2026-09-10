/**
 * 交易控制模块的**方言可移植性**（WP40 §2）。
 *
 * 说清楚这条测试证明了什么、没证明什么：
 *
 * - **证明了**：同一份迁移集（`MIGRATIONS`）经共用迁移器在 SQLite 与 Postgres 上
 *   都能建出同样一批表与索引，幂等、一次一事务；账本与审批用到的那几种写法
 *   （upsert、`state IN (…)` 过滤、施行锁的 CAS、预占额度求和）两边行为一致。
 * - **没证明**：`TxnStore` 能在 Postgres 上跑。它的**契约是同步的**
 *   （`putApproval(item): void`），而 Postgres 驱动只能是异步的——
 *   要真上 Postgres，得先把 TxnStore / approvals / executor / ledger
 *   连同调用方一起转异步；另外 5 处 `ORDER BY rowid` 要换成显式的自增列。
 *   两件事都不在 WP40 的可改范围里，见报告 §5。
 */
import { migrate, openSqliteDriver, type SqlDriver, upsert } from '@agentsws/core/sql'
import { openScratchPostgres, postgresTestUrl } from '@agentsws/core/sql/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../src/schema.js'

const AT = '2026-09-10T00:00:00.000Z'
const pgUrl = await postgresTestUrl()
const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup()
})

const BACKENDS: { name: string; skip: boolean; open(): Promise<SqlDriver> }[] = [
  { name: 'sqlite', skip: false, open: async () => openSqliteDriver({ path: ':memory:' }) },
  {
    name: 'postgres',
    skip: pgUrl === undefined,
    open: async () => {
      const scratch = await openScratchPostgres(pgUrl as string, 'txn')
      cleanups.push(() => scratch.dispose())
      return scratch.driver
    },
  },
]

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`txn 表结构可移植性 · ${backend.name}`, () => {
    it('迁移集建得起来，幂等', async () => {
      const driver = await backend.open()
      expect(await migrate(driver, MIGRATIONS, AT)).toEqual([1, 2])
      expect(await migrate(driver, MIGRATIONS, AT)).toEqual([])
      for (const table of [
        'approvals',
        'approval_revisions',
        'approval_events',
        'tokens',
        'changes',
        'mandates',
        'contexts',
        'approved_changes',
        'reservations',
        'provenance',
        'cursors',
        'apply_locks',
        'apply_lock_tokens',
      ]) {
        // 建不出来这一句就抛
        await driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
      }
      if (backend.name === 'sqlite') await driver.close()
    })

    it('审批 upsert + state IN 过滤两边一致', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, AT)
      const sql = upsert('approvals', ['id', 'workspace_id', 'kind', 'state', 'json'], ['id'])
      await driver.prepare(sql).run('a1', 'ws_1', 'refund', 'pending', '{"id":"a1"}')
      await driver.prepare(sql).run('a1', 'ws_1', 'refund', 'approved', '{"id":"a1"}')
      const rows = await driver
        .prepare<{ id: string; state: string }>(
          'SELECT id, state FROM approvals WHERE workspace_id = ? AND state IN (?, ?)',
        )
        .all('ws_1', 'approved', 'rejected')
      expect(rows).toEqual([{ id: 'a1', state: 'approved' }])
      if (backend.name === 'sqlite') await driver.close()
    })

    it('施行锁的围栏号：抢锁 CAS 与「号不回头」两边一致（31 §3.2）', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, AT)
      const bump = upsert('apply_lock_tokens', ['key', 'token'], ['key'])
      const hold = upsert(
        'apply_locks',
        ['key', 'holder', 'token', 'acquired_at', 'expires_at', 'expires_ms'],
        ['key'],
      )
      for (const [holder, token] of [
        ['h1', 1],
        ['h2', 2],
      ] as const) {
        await driver.prepare(bump).run('k', token)
        await driver.prepare(hold).run('k', holder, token, AT, AT, 1000 + token)
      }
      const row = await driver
        .prepare<{ holder: string; token: number; expires_ms: number }>(
          'SELECT holder, token, expires_ms FROM apply_locks WHERE key = ?',
        )
        .get('k')
      expect(row?.holder).toBe('h2')
      expect(Number(row?.token)).toBe(2)
      // 毫秒时间戳是 64 位：Postgres 的 INTEGER 只有 32 位，方言表把它翻成 BIGINT
      await driver
        .prepare('UPDATE apply_locks SET expires_ms = ? WHERE key = ?')
        .run(1_800_000_000_000, 'k')
      const big = await driver
        .prepare<{ expires_ms: number }>('SELECT expires_ms FROM apply_locks WHERE key = ?')
        .get('k')
      expect(Number(big?.expires_ms)).toBe(1_800_000_000_000)
      if (backend.name === 'sqlite') await driver.close()
    })

    it('预占额度求和：released 不计入（两边同一句 SQL）', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, AT)
      const put = upsert('reservations', ['change_id', 'counter', 'amount', 'state'], ['change_id'])
      await driver.prepare(put).run('c1', 'refund_amount', 100, 'held')
      await driver.prepare(put).run('c2', 'refund_amount', 50, 'committed')
      await driver.prepare(put).run('c3', 'refund_amount', 999, 'released')
      const row = await driver
        .prepare<{ total: number | null }>(
          `SELECT SUM(amount) AS total FROM reservations WHERE counter = ? AND state != 'released'`,
        )
        .get('refund_amount')
      expect(Number(row?.total ?? 0)).toBe(150)
      if (backend.name === 'sqlite') await driver.close()
    })
  })
}

if (pgUrl === undefined) {
  console.warn(
    '[WP40] txn 的 Postgres 可移植性用例已跳过：没有可连的库（设 AGENTSWS_TEST_DATABASE_URL，或 docker compose --profile postgres up -d）。',
  )
}
