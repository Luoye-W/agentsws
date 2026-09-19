/**
 * 租户私有的云端红人库（67 §3）。
 *
 * **每个组织一份**：Workers 形态是 `KolTenantDO(org_id)` 自己的 SQLite，Compose
 * 形态是数据目录里的一个库文件。所以表里**没有 `org_id` 这一列**——一个库就是
 * 一个组织，多一列就多一种"忘了加 where"的漏数据方式。
 *
 * 五张表：
 *
 * - `kol_cloud_objects`：同步单元。主键 `(kind, id)`，删掉的留**墓碑**（`deleted=1`，
 *   没有 body）。不留墓碑的话，一台机器删掉的东西会被另一台还没同步的机器当成
 *   "新对象"推回来，删不掉。
 * - `kol_cloud_conflicts`：两头同时改同一条时，**输的那一份**。留着是这一块最
 *   要紧的一条纪律——静默丢掉用户在另一台机器上写的半句话，是这类功能最常见
 *   也最伤的事故。
 * - `kol_cloud_subscription`：这个组织的订阅（一行，整个 json 存一格）。
 * - `kol_cloud_charges`：扣过的那些 cycle。**主键就是幂等键**，所以"同一个 cycle
 *   扣两次"在库这一层也过不去（与 `wallet_lots(org_id, source_ref)` 同一条思路）。
 * - `kol_cloud_audit`：用户数据权利那几条动作（开通 / 取消 / 赠送 / 扣费 / 导出 / 删除）。
 *
 * 游标是一个**单调自增的 seq**，存在 `kol_cloud_meta` 里。为什么不用时间戳当
 * 游标：两条在同一毫秒写进来的对象会有一条被永远跳过，而那一条是用户的数据。
 */
import type {
  Iso8601,
  KolObjectKind,
  KolSyncConflict,
  KolSyncObject,
  ServiceSubscription,
  SubscriptionCharge,
} from '@agentsws/contracts'
import type { KolCloudAuditRow, SqliteLike } from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kol_cloud_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kol_cloud_objects (
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  writer     TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  body       TEXT,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS kol_cloud_objects_seq ON kol_cloud_objects(seq);
CREATE TABLE IF NOT EXISTS kol_cloud_conflicts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  winner      TEXT NOT NULL,
  loser       TEXT NOT NULL,
  at          TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS kol_cloud_conflicts_open ON kol_cloud_conflicts(resolved_at);
CREATE TABLE IF NOT EXISTS kol_cloud_subscription (
  service_id   TEXT PRIMARY KEY,
  json         TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS kol_cloud_charges (
  charge_key TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kol_cloud_audit (
  seq    INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor  TEXT NOT NULL,
  note   TEXT
);
`

interface ObjectSqlRow {
  kind: string
  id: string
  version: number
  updated_at: string
  writer: string
  deleted: number
  body: string | null
  seq: number
}

interface ConflictSqlRow {
  id: string
  kind: string
  object_id: string
  winner: string
  loser: string
  at: string
  resolved_at: string | null
}

function toObject(row: ObjectSqlRow): KolSyncObject {
  const base: KolSyncObject = {
    kind: row.kind as KolObjectKind,
    id: row.id,
    version: row.version,
    updated_at: row.updated_at,
    writer: row.writer,
  }
  if (row.deleted === 1) return { ...base, deleted: true }
  return row.body === null
    ? base
    : { ...base, body: JSON.parse(row.body) as Record<string, unknown> }
}

/**
 * 一个组织的云端红人库。
 *
 * 全部方法**同步**：库那一口（`SqliteLike`）在两个形态里都是同步的，所以这一层
 * 一个 `async` 都不出现。异步只在"钱"与"路由"那两侧（见 `service.ts`）。
 */
export class KolCloudStore {
  private readonly db: SqliteLike

  constructor(db: SqliteLike) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  /* ---------------- 游标 ---------------- */

  /** 当前游标（最后一次写入的 seq）。空库是 0。 */
  cursor(): number {
    const row = this.db
      .prepare('SELECT value FROM kol_cloud_meta WHERE key = ?')
      .get('seq') as { value: string } | undefined
    return row === undefined ? 0 : Number(row.value)
  }

  /**
   * 下一个计数。
   *
   * 同步游标（`seq`）与审计行号（`audit_seq`）**各数各的**：审计写一行就把同步
   * 游标往前推一格的话，本地那头会以为"云端有新东西"，于是每次导出都触发一次
   * 空拉取。两个计数器，一张表，互不打扰。
   */
  private bump(key: 'seq' | 'audit_seq'): number {
    const row = this.db.prepare('SELECT value FROM kol_cloud_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    const next = (row === undefined ? 0 : Number(row.value)) + 1
    this.db
      .prepare(
        'INSERT INTO kol_cloud_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, String(next))
    return next
  }

  /* ---------------- 对象 ---------------- */

  object(kind: string, id: string): KolSyncObject | undefined {
    const row = this.db
      .prepare('SELECT * FROM kol_cloud_objects WHERE kind = ? AND id = ?')
      .get(kind, id) as ObjectSqlRow | undefined
    return row === undefined ? undefined : toObject(row)
  }

  /** 写一条（覆盖）。回新的 seq。 */
  put(object: KolSyncObject): number {
    const seq = this.bump('seq')
    const deleted = object.deleted === true
    this.db
      .prepare(
        `INSERT INTO kol_cloud_objects (kind, id, version, updated_at, writer, deleted, body, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           version = excluded.version, updated_at = excluded.updated_at,
           writer = excluded.writer, deleted = excluded.deleted,
           body = excluded.body, seq = excluded.seq`,
      )
      .run(
        object.kind,
        object.id,
        object.version,
        object.updated_at,
        object.writer,
        deleted ? 1 : 0,
        // 墓碑不留 body：删掉的那条正文不该还躺在库里
        deleted || object.body === undefined ? null : JSON.stringify(object.body),
        seq,
      )
    return seq
  }

  /**
   * 游标之后改过的那些（按 seq 升序）。`exceptWriter` 那一台自己推的不回给它。
   *
   * **回的每一条都带着自己的 seq**：下一次的游标是这一页最后一条的 seq，而那个数
   * 只有库知道。让调用方去猜（按条数加）的话，一旦中间有几条被 `exceptWriter`
   * 滤掉，游标就会算小——于是同一批数据被反复拉下来。
   */
  since(cursor: number, limit: number, exceptWriter?: string): { object: KolSyncObject; seq: number }[] {
    const rows = (
      exceptWriter === undefined
        ? this.db
            .prepare('SELECT * FROM kol_cloud_objects WHERE seq > ? ORDER BY seq ASC LIMIT ?')
            .all(cursor, limit)
        : this.db
            .prepare(
              'SELECT * FROM kol_cloud_objects WHERE seq > ? AND writer <> ? ORDER BY seq ASC LIMIT ?',
            )
            .all(cursor, exceptWriter, limit)
    ) as ObjectSqlRow[]
    return rows.map((r) => ({ object: toObject(r), seq: r.seq }))
  }

  /** 全部对象（导出用；含墓碑，因为墓碑也是用户数据的一部分）。 */
  all(): KolSyncObject[] {
    const rows = this.db
      .prepare('SELECT * FROM kol_cloud_objects ORDER BY kind ASC, id ASC')
      .all() as ObjectSqlRow[]
    return rows.map(toObject)
  }

  /** 还活着的条数（不含墓碑）。界面上那句"云端 1,204 条"。 */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM kol_cloud_objects WHERE deleted = 0')
      .get() as { n: number } | undefined
    return row?.n ?? 0
  }

  /** 按种类分的条数（不含墓碑）。 */
  countByKind(): { kind: KolObjectKind; count: number }[] {
    const rows = this.db
      .prepare(
        'SELECT kind, COUNT(*) AS n FROM kol_cloud_objects WHERE deleted = 0 GROUP BY kind ORDER BY kind ASC',
      )
      .all() as { kind: string; n: number }[]
    return rows.map((r) => ({ kind: r.kind as KolObjectKind, count: r.n }))
  }

  /* ---------------- 冲突 ---------------- */

  /** 记一条冲突。`id` 由调用方给（`(kind, id, at)` 推出来，重放不会记两条）。 */
  putConflict(id: string, conflict: KolSyncConflict): void {
    this.db
      .prepare(
        `INSERT INTO kol_cloud_conflicts (id, kind, object_id, winner, loser, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        conflict.kind,
        conflict.id,
        JSON.stringify(conflict.winner),
        JSON.stringify(conflict.loser),
        conflict.at,
      )
  }

  /** 还没被人处理的冲突。界面上那个标记看它。 */
  openConflicts(limit = 200): KolSyncConflict[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM kol_cloud_conflicts WHERE resolved_at IS NULL ORDER BY at DESC LIMIT ?',
      )
      .all(limit) as ConflictSqlRow[]
    return rows.map((r) => ({
      kind: r.kind as KolObjectKind,
      id: r.object_id,
      winner: JSON.parse(r.winner) as KolSyncObject,
      loser: JSON.parse(r.loser) as KolSyncObject,
      at: r.at,
    }))
  }

  openConflictCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM kol_cloud_conflicts WHERE resolved_at IS NULL')
      .get() as { n: number } | undefined
    return row?.n ?? 0
  }

  /** 用户在界面上处理完一条（挑了其中一份）。**行不删**——审计要看得见。 */
  resolveConflict(id: string, at: Iso8601): void {
    this.db
      .prepare('UPDATE kol_cloud_conflicts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
      .run(at, id)
  }

  /* ---------------- 订阅 ---------------- */

  subscription(service_id: string): ServiceSubscription | undefined {
    const row = this.db
      .prepare('SELECT json FROM kol_cloud_subscription WHERE service_id = ?')
      .get(service_id) as { json: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.json) as ServiceSubscription)
  }

  putSubscription(sub: ServiceSubscription): void {
    this.db
      .prepare(
        `INSERT INTO kol_cloud_subscription (service_id, json) VALUES (?, ?)
         ON CONFLICT(service_id) DO UPDATE SET json = excluded.json`,
      )
      .run(sub.service_id, JSON.stringify(sub))
  }

  lastSyncAt(service_id: string): Iso8601 | undefined {
    const row = this.db
      .prepare('SELECT last_sync_at FROM kol_cloud_subscription WHERE service_id = ?')
      .get(service_id) as { last_sync_at: string | null } | undefined
    return row?.last_sync_at ?? undefined
  }

  touchSync(service_id: string, at: Iso8601): void {
    this.db
      .prepare('UPDATE kol_cloud_subscription SET last_sync_at = ? WHERE service_id = ?')
      .run(at, service_id)
  }

  /* ---------------- 扣费 ---------------- */

  /** 扣过的那些 key（`dueCharges` 拿它判幂等）。 */
  chargedKeys(): Set<string> {
    const rows = this.db.prepare('SELECT charge_key FROM kol_cloud_charges').all() as {
      charge_key: string
    }[]
    return new Set(rows.map((r) => r.charge_key))
  }

  /**
   * 记一笔扣费。**主键是幂等键**，所以重放写不进第二条——这是幂等的第二道，
   * 第一道是 `dueCharges` 里的那个集合（两道都要有：一道是逻辑，一道是库）。
   */
  putCharge(charge: SubscriptionCharge): void {
    this.db
      .prepare(
        'INSERT INTO kol_cloud_charges (charge_key, json, at) VALUES (?, ?, ?) ON CONFLICT(charge_key) DO NOTHING',
      )
      .run(charge.charge_key, JSON.stringify(charge), charge.at)
  }

  charges(limit = 50): SubscriptionCharge[] {
    const rows = this.db
      .prepare('SELECT json FROM kol_cloud_charges ORDER BY at DESC LIMIT ?')
      .all(limit) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as SubscriptionCharge)
  }

  /* ---------------- 审计 ---------------- */

  appendAudit(row: KolCloudAuditRow): void {
    const seq = this.bump('audit_seq')
    this.db
      .prepare('INSERT INTO kol_cloud_audit (seq, at, org_id, action, actor, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(seq, row.at, row.org_id, row.action, row.actor, row.note ?? null)
  }

  audit(limit = 100): KolCloudAuditRow[] {
    const rows = this.db
      .prepare('SELECT at, org_id, action, actor, note FROM kol_cloud_audit ORDER BY seq DESC LIMIT ?')
      .all(limit) as { at: string; org_id: string; action: string; actor: string; note: string | null }[]
    return rows.map((r) => ({
      at: r.at,
      org_id: r.org_id,
      action: r.action,
      actor: r.actor,
      ...(r.note === null ? {} : { note: r.note }),
    }))
  }

  /**
   * 把云端这一份**清空**（用户自己按的那颗按钮）。
   *
   * 清对象与冲突，**不动订阅、不动扣费记录、不动审计**：删数据不等于退订
   * （用户可能只是想清空重来），而账与审计是我们对自己的交代。
   * 回删掉了多少条。
   */
  clearObjects(): number {
    const n = this.count()
    this.db.exec('DELETE FROM kol_cloud_objects')
    this.db.exec('DELETE FROM kol_cloud_conflicts')
    return n
  }

  close(): void {
    this.db.close?.()
  }
}
