/**
 * WP328：Reddit 每日巡查的本机存储——一台机器一个 `reddit-watch.sqlite`，每一行钉着 `workspace_id`
 * （品牌之间互不可见）。三张表：巡查到的条目（同一品牌同一来源同一全名只记一次）、每次巡查、
 * 杂项（设置 / 每一路读到哪 / 插件状态 / 排着的活），整条存 JSON。
 */
import type {
  Iso8601,
  RedditWatchItem,
  RedditWatchItemStatus,
  RedditWatchRun,
  RedditWatchSource,
  WorkspaceId,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rw_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  fullname TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reply INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL,
  UNIQUE (workspace_id, source, fullname)
);
CREATE INDEX IF NOT EXISTS rw_items_created ON rw_items (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS rw_items_pending ON rw_items (workspace_id, status, reply);
CREATE INDEX IF NOT EXISTS rw_items_fullname ON rw_items (workspace_id, fullname);
CREATE TABLE IF NOT EXISTS rw_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rw_runs_ws ON rw_runs (workspace_id, started_at);
CREATE TABLE IF NOT EXISTS rw_kv (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
`

export interface RedditWatchItemQuery {
  source?: RedditWatchSource
  status?: RedditWatchItemStatus
  /** 只要「要回」的。 */
  reply?: boolean
  /** 按 Reddit 上的发帖时间筛（含 since，不含 until）。 */
  since?: Iso8601
  until?: Iso8601
  limit?: number
}

export interface RedditWatchStore {
  /** 新的才记（同一来源同一全名已有 → 回 false，不动它：可能已经处理过）。 */
  insert(item: RedditWatchItem): boolean
  put(item: RedditWatchItem): void
  get(workspace_id: WorkspaceId, id: string): RedditWatchItem | undefined
  /** 任一来源里的这一条（挂后续 / 对方删了用）。 */
  byFullname(workspace_id: WorkspaceId, fullname: string): RedditWatchItem[]
  /** 新的在前（按发帖时间）。 */
  list(workspace_id: WorkspaceId, query?: RedditWatchItemQuery): RedditWatchItem[]
  putRun(run: RedditWatchRun): void
  run(workspace_id: WorkspaceId, id: string): RedditWatchRun | undefined
  /** 新的在前。 */
  runs(workspace_id: WorkspaceId, query?: { since?: Iso8601; limit?: number }): RedditWatchRun[]
  kv<T>(workspace_id: WorkspaceId, key: string): T | undefined
  setKv(workspace_id: WorkspaceId, key: string, value: unknown): void
  close(): void
}

/** `dbPath` 不给就是内存档（测试与没有数据目录的档）。 */
export function createRedditWatchStore(dbPath?: string): RedditWatchStore {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const parse = (r: { json: string } | undefined): RedditWatchItem | undefined =>
    r === undefined ? undefined : (JSON.parse(r.json) as RedditWatchItem)
  const row = (i: RedditWatchItem): unknown[] => [
    i.id,
    i.workspace_id,
    i.source,
    i.fullname,
    i.created_at,
    i.status,
    i.judgement?.reply === true ? 1 : 0,
    JSON.stringify(i),
  ]

  return {
    insert: (i) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO rw_items (id, workspace_id, source, fullname, created_at, status, reply, json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(...row(i)).changes > 0,
    put: (i) => {
      db.prepare(
        `INSERT INTO rw_items (id, workspace_id, source, fullname, created_at, status, reply, json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, reply = excluded.reply, json = excluded.json`,
      ).run(...row(i))
    },
    get: (ws, id) =>
      parse(
        db.prepare('SELECT json FROM rw_items WHERE workspace_id = ? AND id = ?').get(ws, id) as
          | { json: string }
          | undefined,
      ),
    byFullname: (ws, fullname) =>
      (
        db
          .prepare('SELECT json FROM rw_items WHERE workspace_id = ? AND fullname = ?')
          .all(ws, fullname) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as RedditWatchItem),
    list: (ws, q = {}) => {
      const where = ['workspace_id = ?']
      const args: unknown[] = [ws]
      if (q.source !== undefined) {
        where.push('source = ?')
        args.push(q.source)
      }
      if (q.status !== undefined) {
        where.push('status = ?')
        args.push(q.status)
      }
      if (q.reply !== undefined) {
        where.push('reply = ?')
        args.push(q.reply ? 1 : 0)
      }
      if (q.since !== undefined) {
        where.push('created_at >= ?')
        args.push(q.since)
      }
      if (q.until !== undefined) {
        where.push('created_at < ?')
        args.push(q.until)
      }
      const limit = Math.max(1, Math.min(q.limit ?? 200, 5000))
      return (
        db
          .prepare(
            `SELECT json FROM rw_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
          )
          .all(...args) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as RedditWatchItem)
    },
    putRun: (r) => {
      db.prepare(
        `INSERT INTO rw_runs (id, workspace_id, started_at, json) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(r.id, r.workspace_id, r.started_at, JSON.stringify(r))
    },
    run: (ws, id) => {
      const r = db
        .prepare('SELECT json FROM rw_runs WHERE workspace_id = ? AND id = ?')
        .get(ws, id) as { json: string } | undefined
      return r === undefined ? undefined : (JSON.parse(r.json) as RedditWatchRun)
    },
    runs: (ws, q = {}) => {
      const limit = Math.max(1, Math.min(q.limit ?? 50, 1000))
      const rows = (
        q.since === undefined
          ? db
              .prepare(
                `SELECT json FROM rw_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ${limit}`,
              )
              .all(ws)
          : db
              .prepare(
                `SELECT json FROM rw_runs WHERE workspace_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT ${limit}`,
              )
              .all(ws, q.since)
      ) as { json: string }[]
      return rows.map((r) => JSON.parse(r.json) as RedditWatchRun)
    },
    kv: <T>(ws: WorkspaceId, key: string): T | undefined => {
      const r = db
        .prepare('SELECT json FROM rw_kv WHERE workspace_id = ? AND key = ?')
        .get(ws, key) as { json: string } | undefined
      return r === undefined ? undefined : (JSON.parse(r.json) as T)
    },
    setKv: (ws, key, value) => {
      db.prepare(
        `INSERT INTO rw_kv (workspace_id, key, json) VALUES (?,?,?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET json = excluded.json`,
      ).run(ws, key, JSON.stringify(value))
    },
    close: () => db.close(),
  }
}
