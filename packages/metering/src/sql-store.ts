/**
 * 钱包的 SQL 档（{@link WalletStore} 的第二份实现），写在**同步 SQL 口**
 * （`@agentsws/core/sql/sync-db` 的 {@link SyncDb}）上。
 *
 * 为什么是同步口：`WalletStore` 那行注释——"钱的读写要么成要么不成，中间不该有
 * 一个 await 让别的请求插进来"。WP114 把这个档从 better-sqlite3 的类型上摘下来，
 * 换成一张只要求 `exec / prepare / transaction` 的库，于是同一份表、同一份 SQL
 * 在两个地方跑：本机与 Compose 形态走 better-sqlite3（`sqlite-store.ts`），
 * Cloudflare Workers 形态走 Durable Object 的 SQLite（也同步、也单线程）。
 *
 * 三张表，各自一句话：
 * - `wallet_lots`：两类积分各一行，`remaining` 是还剩多少（不删行——扣到 0 也留着，账要看得见）；
 * - `wallet_reservations`：预扣中的；进程崩了这些行会留下来，起来时 {@link SqlWalletStore.sweepReservations}
 *   把过期的扫掉——不扫的话那些积分就永远被占住了；
 * - `metering_events`：**只有八列**，与 `MeteringEvent` 一一对应。表结构本身就是
 *   49 M6 那条纪律：这张表里没有地方放正文，想存也存不进来。
 *
 * 迁移器与网关那份同一个做法（内嵌 SQL 数组 + 版本号表），
 * 但这是**自己的一张库**，不碰别人的表（35 §2）。
 */
import type { Iso8601, MeteringEvent, WalletLot } from '@agentsws/contracts'
import type { SyncDb } from '@agentsws/core/sql/sync-db'
import type { WalletReservation, WalletStore } from './wallet.js'

interface Migration {
  version: number
  sql: string
}

/** 钱包三张表。两份实现共用这一份——表结构只写一遍。 */
export const WALLET_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS wallet_lots (
  id          TEXT PRIMARY KEY NOT NULL,
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  credits     REAL NOT NULL,
  remaining   REAL NOT NULL,
  granted_at  TEXT NOT NULL,
  expires_at  TEXT,
  source_ref  TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS wallet_lots_org ON wallet_lots (org_id, granted_at);
-- 幂等靠它：同一个组织同一个支付订单号只入一次账
CREATE UNIQUE INDEX IF NOT EXISTS wallet_lots_source
  ON wallet_lots (org_id, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_reservations (
  id           TEXT PRIMARY KEY NOT NULL,
  org_id       TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  capability   TEXT NOT NULL,
  unit         TEXT NOT NULL,
  quantity     REAL NOT NULL,
  credits      REAL NOT NULL,
  request_id   TEXT NOT NULL,
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS wallet_reservations_org ON wallet_reservations (org_id);

-- 49 M6：**八列，一列不多**。没有 body、没有 prompt、没有 payload——
-- 想存正文也没地方存，这是纪律唯一可执行的形式。
CREATE TABLE IF NOT EXISTS metering_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  capability   TEXT NOT NULL,
  unit         TEXT NOT NULL,
  quantity     REAL NOT NULL,
  credits      REAL NOT NULL,
  at           TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS metering_events_org_at ON metering_events (org_id, at);
`,
  },
]

/** 版本号表的默认名字。 */
export const WALLET_MIGRATIONS_TABLE = '_migrations'

const versionDdl = (table: string): string => `
CREATE TABLE IF NOT EXISTS ${table} (
  version    INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`

function migrate(db: SyncDb, at: string, table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
    throw new Error(`版本号表的名字只能是标识符：${table}`)
  db.exec(versionDdl(table))
  const done = new Set(
    db
      .prepare<{ version: number }>(`SELECT version FROM ${table}`)
      .all()
      .map((r) => r.version),
  )
  const record = db.prepare(`INSERT INTO ${table} (version, applied_at) VALUES (?, ?)`)
  const pending = WALLET_MIGRATIONS.filter((m) => !done.has(m.version))
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql)
      record.run(m.version, at)
    }
  })
}

interface LotRow {
  id: string
  org_id: string
  kind: string
  credits: number
  remaining: number
  granted_at: string
  expires_at: string | null
  source_ref: string | null
}

const toLot = (r: LotRow): WalletLot => ({
  id: r.id,
  org_id: r.org_id,
  kind: r.kind === 'granted' ? 'granted' : 'purchased',
  credits: r.credits,
  remaining: r.remaining,
  granted_at: r.granted_at,
  ...(r.expires_at === null ? {} : { expires_at: r.expires_at }),
  ...(r.source_ref === null ? {} : { source_ref: r.source_ref }),
})

export interface SqlWalletStoreOptions {
  db: SyncDb
  now: () => Iso8601
  /**
   * 版本号表叫什么。**只有与别的表挤在同一张库里时才要给**——
   * Durable Object 一个对象只有一张库，钱包与幂等表住在一起。
   */
  migrationsTable?: string
}

export interface SqlWalletStore extends WalletStore {
  /**
   * 扫掉太老的预扣（进程崩在 reserve 与 settle 之间留下的孤儿）。
   * 不扫的话那些积分就永远被占住——用户看到余额少了一块，却找不到是哪一笔。
   */
  sweepReservations(olderThan: Iso8601): number
  /** 这个库里现在有没有预扣（Workers 形态的 alarm 靠它决定要不要续下一拍）。 */
  hasReservations(): boolean
  close(): void
}

/** 在一张已经开好的库上装一个钱包存储。开库 / 关库由调用方负责。 */
export function createSqlWalletStore(options: SqlWalletStoreOptions): SqlWalletStore {
  const db = options.db
  migrate(db, options.now(), options.migrationsTable ?? WALLET_MIGRATIONS_TABLE)

  const insertLot = db.prepare(
    `INSERT INTO wallet_lots (id, org_id, kind, credits, remaining, granted_at, expires_at, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectLots = db.prepare<LotRow>(
    'SELECT * FROM wallet_lots WHERE org_id = ? ORDER BY granted_at',
  )
  const selectLotByRef = db.prepare<LotRow>(
    'SELECT * FROM wallet_lots WHERE org_id = ? AND source_ref = ?',
  )
  const consumeLot = db.prepare(
    'UPDATE wallet_lots SET remaining = MAX(0, remaining - ?) WHERE id = ?',
  )
  const insertReservation = db.prepare(
    `INSERT OR REPLACE INTO wallet_reservations
       (id, org_id, workspace_id, capability, unit, quantity, credits, request_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectReservations = db.prepare<WalletReservation>(
    'SELECT id, org_id, workspace_id, capability, unit, quantity, credits, request_id, at FROM wallet_reservations WHERE org_id = ?',
  )
  const countReservations = db.prepare<{ n: number }>(
    'SELECT COUNT(*) AS n FROM wallet_reservations',
  )
  const deleteReservation = db.prepare('DELETE FROM wallet_reservations WHERE id = ?')
  const sweep = db.prepare('DELETE FROM wallet_reservations WHERE at < ?')
  const insertEvent = db.prepare(
    `INSERT INTO metering_events (capability, unit, quantity, credits, at, org_id, workspace_id, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectEvents = db.prepare<MeteringEvent>(
    `SELECT capability, unit, quantity, credits, at, org_id, workspace_id, request_id
       FROM metering_events WHERE org_id = ? AND at >= ? AND at <= ? ORDER BY at`,
  )

  return {
    lots(org_id) {
      return selectLots.all(org_id).map(toLot)
    },

    addLot(lot) {
      insertLot.run(
        lot.id,
        lot.org_id,
        lot.kind,
        lot.credits,
        lot.remaining,
        lot.granted_at,
        lot.expires_at ?? null,
        lot.source_ref ?? null,
      )
    },

    consume(lot_id, credits) {
      consumeLot.run(credits, lot_id)
    },

    lotBySourceRef(org_id, source_ref) {
      const row = selectLotByRef.get(org_id, source_ref)
      return row === undefined ? undefined : toLot(row)
    },

    reservations(org_id) {
      return selectReservations.all(org_id)
    },

    putReservation(r) {
      insertReservation.run(
        r.id,
        r.org_id,
        r.workspace_id,
        r.capability,
        r.unit,
        r.quantity,
        r.credits,
        r.request_id,
        r.at,
      )
    },

    dropReservation(id) {
      deleteReservation.run(id)
    },

    appendEvent(e) {
      /*
       * 参数一条一条按名字取，**不 spread**——"从上游响应里 spread 一把过来"
       * 正是 49 M6 要挡的那种事故。列只有八个，这里也只写得出八个。
       */
      insertEvent.run(
        e.capability,
        e.unit,
        e.quantity,
        e.credits,
        e.at,
        e.org_id,
        e.workspace_id,
        e.request_id,
      )
    },

    events(filter) {
      return selectEvents.all(
        filter.org_id,
        filter.from ?? '0000-01-01T00:00:00.000Z',
        filter.to ?? '9999-12-31T23:59:59.999Z',
      )
    },

    sweepReservations(olderThan) {
      return sweep.run(olderThan).changes
    },

    hasReservations() {
      return (countReservations.get()?.n ?? 0) > 0
    },

    close() {
      db.close()
    },
  }
}
