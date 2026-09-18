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
  {
    /*
     * WP115 的成本会计扩列（65 §3）。**只加列不改列**：旧行这几格是 NULL，
     * 聚合时 `COALESCE(..., 0)`——那不是"未知"，是"那时候没记"。
     *
     * 为什么加在计量事件上而不是另开一张成本表：一次调用的"收"与"支"必须在
     * 同一行上，否则"这一笔亏没亏本"就要靠 join 两张表对 request_id，而其中
     * 一张的写入可能失败。KOLAgents 的用量账本就是一行两列，照搬。
     *
     * 这份迁移两个形态共用：Compose 跑在 `wallet.sqlite` 上，Workers 跑在每个
     * `WalletDO` 自己的 SQLite 上，**同一段 SQL**。
     */
    version: 2,
    sql: `
ALTER TABLE metering_events ADD COLUMN provider      TEXT;
ALTER TABLE metering_events ADD COLUMN model         TEXT;
ALTER TABLE metering_events ADD COLUMN input_tokens  REAL;
ALTER TABLE metering_events ADD COLUMN output_tokens REAL;
ALTER TABLE metering_events ADD COLUMN cost_micros   INTEGER;
ALTER TABLE metering_events ADD COLUMN cost_currency TEXT;
ALTER TABLE metering_events ADD COLUMN charge_status TEXT;
ALTER TABLE metering_events ADD COLUMN account_id    TEXT;

-- 后台三张分组表各自的入口（65 §9：全部 SQL 聚合 + 索引，不把全量行拉进内存）
CREATE INDEX IF NOT EXISTS metering_events_at          ON metering_events (at);
CREATE INDEX IF NOT EXISTS metering_events_provider_at ON metering_events (provider, at);
CREATE INDEX IF NOT EXISTS metering_events_cap_at      ON metering_events (capability, at);
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

/** 库里的一行计量事件。WP115 的扩列在旧行上是 NULL，所以这里全是 `| null`。 */
export interface EventRow {
  capability: string
  unit: string
  quantity: number
  credits: number
  at: string
  org_id: string
  workspace_id: string
  request_id: string
  provider: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_micros: number | null
  cost_currency: string | null
  charge_status: string | null
  account_id: string | null
}

/**
 * 行 → {@link MeteringEvent}。**NULL 的那几格干脆不出现**，不写成 `undefined`：
 * `exactOptionalPropertyTypes` 下这两件事不一样，而 `assertMeteringEvent` 查的是
 * "键在不在"。
 */
export function toEvent(r: EventRow): MeteringEvent {
  return {
    capability: r.capability,
    unit: r.unit,
    quantity: r.quantity,
    credits: r.credits,
    at: r.at,
    org_id: r.org_id,
    workspace_id: r.workspace_id,
    request_id: r.request_id,
    ...(r.provider === null ? {} : { provider: r.provider }),
    ...(r.model === null ? {} : { model: r.model }),
    ...(r.input_tokens === null ? {} : { input_tokens: r.input_tokens }),
    ...(r.output_tokens === null ? {} : { output_tokens: r.output_tokens }),
    ...(r.cost_micros === null ? {} : { cost_micros: r.cost_micros }),
    ...(r.cost_currency === null ? {} : { cost_currency: r.cost_currency }),
    ...(r.charge_status === null ? {} : { charge_status: r.charge_status }),
    ...(r.account_id === null ? {} : { account_id: r.account_id }),
  }
}

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
    `INSERT INTO metering_events
       (capability, unit, quantity, credits, at, org_id, workspace_id, request_id,
        provider, model, input_tokens, output_tokens, cost_micros, cost_currency,
        charge_status, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectEvents = db.prepare<EventRow>(
    `SELECT capability, unit, quantity, credits, at, org_id, workspace_id, request_id,
            provider, model, input_tokens, output_tokens, cost_micros, cost_currency,
            charge_status, account_id
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
       * 正是 49 M6 要挡的那种事故。列就这十六个，这里也只写得出十六个。
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
        e.provider ?? null,
        e.model ?? null,
        e.input_tokens ?? null,
        e.output_tokens ?? null,
        e.cost_micros ?? null,
        e.cost_currency ?? null,
        e.charge_status ?? null,
        e.account_id ?? null,
      )
    },

    events(filter) {
      return selectEvents
        .all(
          filter.org_id,
          filter.from ?? '0000-01-01T00:00:00.000Z',
          filter.to ?? '9999-12-31T23:59:59.999Z',
        )
        .map(toEvent)
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
