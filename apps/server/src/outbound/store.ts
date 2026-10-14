/**
 * WP323（docs/102 §5）：发出记录与记录去处的本机存储——一台机器一个 `outbound.sqlite`，
 * 每一行都钉着 `workspace_id`（品牌之间互不可见）。
 *
 * 三张表：发出记录（一条一行，整条存 JSON，`source_key` 唯一 = 同一条只记一次）、
 * 记录去处（一个去处一行）、写入状态（某条记录写进某个去处到哪一步了；`(sink_id, record_id)` 唯一
 * = 同一条不会写两次）。删去处连带删它的写入状态（「删除联动」）。
 */
import type {
  OutboundQuery,
  OutboundRecord,
  RecordSink,
  SinkWrite,
  WorkspaceId,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  json TEXT NOT NULL,
  UNIQUE (workspace_id, source_key)
);
CREATE INDEX IF NOT EXISTS outbound_records_ws ON outbound_records (workspace_id, sent_at);
CREATE INDEX IF NOT EXISTS outbound_records_ext ON outbound_records (workspace_id, external_id);
CREATE TABLE IF NOT EXISTS record_sinks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS record_sinks_ws ON record_sinks (workspace_id);
CREATE TABLE IF NOT EXISTS sink_writes (
  sink_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  status TEXT NOT NULL,
  next_at TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (sink_id, record_id)
);
CREATE INDEX IF NOT EXISTS sink_writes_due ON sink_writes (status, next_at);
`

export interface OutboundStore {
  /** 按 `source_key` 找（写入点去重用）。 */
  bySource(workspace_id: WorkspaceId, source_key: string): OutboundRecord | undefined
  get(workspace_id: WorkspaceId, id: string): OutboundRecord | undefined
  /** 我们发出去的那一条在平台上的 id → 那一行（挂后续用）。 */
  byExternal(workspace_id: WorkspaceId, external_id: string): OutboundRecord | undefined
  /** 新的在前。 */
  list(workspace_id: WorkspaceId, query?: OutboundQuery): OutboundRecord[]
  put(record: OutboundRecord): void
  sinks(workspace_id: WorkspaceId): RecordSink[]
  sink(id: string): RecordSink | undefined
  putSink(sink: RecordSink): void
  /** 删去处 + 它的全部写入状态。 */
  removeSink(id: string): boolean
  write(sink_id: string, record_id: string): SinkWrite | undefined
  /** 新建（已有就不动，回 false）。 */
  addWrite(write: SinkWrite): boolean
  putWrite(write: SinkWrite): void
  /** 这个去处还没写进去的（按记录先后）。 */
  pending(sink_id: string): SinkWrite[]
  counts(sink_id: string): { written: number; pending: number }
  close(): void
}

/** `dbPath` 不给就是内存档（测试与没有数据目录的档）。 */
export function createOutboundStore(dbPath?: string): OutboundStore {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const parse = (r: { json: string } | undefined): OutboundRecord | undefined =>
    r === undefined ? undefined : (JSON.parse(r.json) as OutboundRecord)

  return {
    bySource: (ws, key) =>
      parse(
        db
          .prepare('SELECT json FROM outbound_records WHERE workspace_id = ? AND source_key = ?')
          .get(ws, key) as { json: string } | undefined,
      ),
    get: (ws, id) =>
      parse(
        db
          .prepare('SELECT json FROM outbound_records WHERE workspace_id = ? AND id = ?')
          .get(ws, id) as { json: string } | undefined,
      ),
    byExternal: (ws, ext) =>
      parse(
        db
          .prepare(
            'SELECT json FROM outbound_records WHERE workspace_id = ? AND external_id = ? ORDER BY sent_at DESC LIMIT 1',
          )
          .get(ws, ext) as { json: string } | undefined,
      ),
    list: (ws, query = {}) => {
      const where = ['workspace_id = ?']
      const args: unknown[] = [ws]
      if (query.channel !== undefined) {
        where.push('channel = ?')
        args.push(query.channel)
      }
      if (query.status !== undefined) {
        where.push('status = ?')
        args.push(query.status)
      }
      if (query.since !== undefined) {
        where.push('sent_at >= ?')
        args.push(query.since)
      }
      if (query.until !== undefined) {
        where.push('sent_at < ?')
        args.push(query.until)
      }
      const limit = Math.max(1, Math.min(query.limit ?? 200, 5000))
      return (
        db
          .prepare(
            `SELECT json FROM outbound_records WHERE ${where.join(' AND ')} ORDER BY sent_at DESC, id DESC LIMIT ${limit}`,
          )
          .all(...args) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as OutboundRecord)
    },
    put: (r) => {
      db.prepare(
        `INSERT INTO outbound_records (id, workspace_id, source_key, sent_at, channel, status, external_id, json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, external_id = excluded.external_id, json = excluded.json`,
      ).run(
        r.id,
        r.workspace_id,
        r.source_key,
        r.sent_at,
        r.channel,
        r.status,
        r.external_id ?? null,
        JSON.stringify(r),
      )
    },
    sinks: (ws) =>
      (
        db
          .prepare('SELECT json FROM record_sinks WHERE workspace_id = ? ORDER BY rowid')
          .all(ws) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as RecordSink),
    sink: (id) => {
      const r = db.prepare('SELECT json FROM record_sinks WHERE id = ?').get(id) as
        | { json: string }
        | undefined
      return r === undefined ? undefined : (JSON.parse(r.json) as RecordSink)
    },
    putSink: (s) => {
      db.prepare(
        `INSERT INTO record_sinks (id, workspace_id, json) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(s.id, s.workspace_id, JSON.stringify(s))
    },
    removeSink: (id) =>
      db.transaction(() => {
        db.prepare('DELETE FROM sink_writes WHERE sink_id = ?').run(id)
        return db.prepare('DELETE FROM record_sinks WHERE id = ?').run(id).changes > 0
      })(),
    write: (sink_id, record_id) => {
      const r = db
        .prepare('SELECT json FROM sink_writes WHERE sink_id = ? AND record_id = ?')
        .get(sink_id, record_id) as { json: string } | undefined
      return r === undefined ? undefined : (JSON.parse(r.json) as SinkWrite)
    },
    addWrite: (w) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO sink_writes (sink_id, record_id, status, next_at, json) VALUES (?,?,?,?,?)`,
        )
        .run(w.sink_id, w.record_id, w.status, w.next_at ?? null, JSON.stringify(w)).changes > 0,
    putWrite: (w) => {
      db.prepare(
        `INSERT INTO sink_writes (sink_id, record_id, status, next_at, json) VALUES (?,?,?,?,?)
         ON CONFLICT(sink_id, record_id) DO UPDATE SET status = excluded.status, next_at = excluded.next_at, json = excluded.json`,
      ).run(w.sink_id, w.record_id, w.status, w.next_at ?? null, JSON.stringify(w))
    },
    pending: (sink_id) =>
      (
        db
          .prepare(
            `SELECT w.json FROM sink_writes w LEFT JOIN outbound_records r ON r.id = w.record_id
             WHERE w.sink_id = ? AND w.status = 'pending' ORDER BY r.sent_at, w.record_id`,
          )
          .all(sink_id) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as SinkWrite),
    counts: (sink_id) => {
      const rows = db
        .prepare('SELECT status, COUNT(*) AS n FROM sink_writes WHERE sink_id = ? GROUP BY status')
        .all(sink_id) as { status: string; n: number }[]
      return {
        written: rows.find((r) => r.status === 'written')?.n ?? 0,
        pending: rows.find((r) => r.status === 'pending')?.n ?? 0,
      }
    },
    close: () => db.close(),
  }
}

