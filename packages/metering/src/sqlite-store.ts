/**
 * 钱包的 sqlite 档（{@link WalletStore} 的第二份实现）。
 *
 * 三张表，各自一句话：
 * - `wallet_lots`：两类积分各一行，`remaining` 是还剩多少（不删行——扣到 0 也留着，账要看得见）；
 * - `wallet_reservations`：预扣中的；进程崩了这些行会留下来，起来时 {@link sweepReservations}
 *   把过期的扫掉——不扫的话那些积分就永远被占住了；
 * - `metering_events`：**只有八列**，与 `MeteringEvent` 一一对应。表结构本身就是
 *   49 M6 那条纪律：这张表里没有地方放正文，想存也存不进来。
 *
 * 迁移器与网关那份同一个做法（内嵌 SQL 数组 + `_migrations` 版本表），
 * 但这是**自己的一张库**，不碰别人的表（35 §2）。
 */
import type { Iso8601, MeteringEvent, WalletLot } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { WalletReservation, WalletStore } from './wallet.js'

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
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

const VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`

function migrate(db: Db, at: string): void {
  db.exec(VERSION_TABLE)
  const done = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  )
  const record = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
  const run = db.transaction((list: readonly Migration[]) => {
    for (const m of list) {
      db.exec(m.sql)
      record.run(m.version, at)
    }
  })
  run(MIGRATIONS.filter((m) => !done.has(m.version)))
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

export interface SqliteWalletStoreOptions {
  /** 库文件路径；`:memory:` 也行（测试用）。 */
  dbPath: string
  now: () => Iso8601
  /** 已经开好的库（宿主想与别的表共用一个连接时给它）。 */
  db?: Db
}

export interface SqliteWalletStore extends WalletStore {
  readonly db: Db
  /**
   * 扫掉太老的预扣（进程崩在 reserve 与 settle 之间留下的孤儿）。
   * 不扫的话那些积分就永远被占住——用户看到余额少了一块，却找不到是哪一笔。
   */
  sweepReservations(olderThan: Iso8601): number
  close(): void
}

export function createSqliteWalletStore(options: SqliteWalletStoreOptions): SqliteWalletStore {
  const db = options.db ?? new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db, options.now())

  const insertLot = db.prepare(
    `INSERT INTO wallet_lots (id, org_id, kind, credits, remaining, granted_at, expires_at, source_ref)
     VALUES (@id, @org_id, @kind, @credits, @remaining, @granted_at, @expires_at, @source_ref)`,
  )
  const selectLots = db.prepare<[string], LotRow>(
    'SELECT * FROM wallet_lots WHERE org_id = ? ORDER BY granted_at',
  )
  const selectLotByRef = db.prepare<[string, string], LotRow>(
    'SELECT * FROM wallet_lots WHERE org_id = ? AND source_ref = ?',
  )
  const consumeLot = db.prepare(
    'UPDATE wallet_lots SET remaining = MAX(0, remaining - ?) WHERE id = ?',
  )
  const insertReservation = db.prepare(
    `INSERT OR REPLACE INTO wallet_reservations
       (id, org_id, workspace_id, capability, unit, quantity, credits, request_id, at)
     VALUES (@id, @org_id, @workspace_id, @capability, @unit, @quantity, @credits, @request_id, @at)`,
  )
  const selectReservations = db.prepare<[string], WalletReservation>(
    'SELECT id, org_id, workspace_id, capability, unit, quantity, credits, request_id, at FROM wallet_reservations WHERE org_id = ?',
  )
  const deleteReservation = db.prepare('DELETE FROM wallet_reservations WHERE id = ?')
  const sweep = db.prepare('DELETE FROM wallet_reservations WHERE at < ?')
  const insertEvent = db.prepare(
    `INSERT INTO metering_events (capability, unit, quantity, credits, at, org_id, workspace_id, request_id)
     VALUES (@capability, @unit, @quantity, @credits, @at, @org_id, @workspace_id, @request_id)`,
  )
  const selectEvents = db.prepare<[string, string, string], MeteringEvent>(
    `SELECT capability, unit, quantity, credits, at, org_id, workspace_id, request_id
       FROM metering_events WHERE org_id = ? AND at >= ? AND at <= ? ORDER BY at`,
  )

  return {
    db,

    lots(org_id) {
      return selectLots.all(org_id).map(toLot)
    },

    addLot(lot) {
      insertLot.run({
        id: lot.id,
        org_id: lot.org_id,
        kind: lot.kind,
        credits: lot.credits,
        remaining: lot.remaining,
        granted_at: lot.granted_at,
        expires_at: lot.expires_at ?? null,
        source_ref: lot.source_ref ?? null,
      })
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
      insertReservation.run({ ...r })
    },

    dropReservation(id) {
      deleteReservation.run(id)
    },

    appendEvent(e) {
      // 参数按名字取，多给的键 better-sqlite3 会直接报错——又一道"只有八列"的闸
      insertEvent.run({
        capability: e.capability,
        unit: e.unit,
        quantity: e.quantity,
        credits: e.credits,
        at: e.at,
        org_id: e.org_id,
        workspace_id: e.workspace_id,
        request_id: e.request_id,
      })
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

    close() {
      db.close()
    },
  }
}
