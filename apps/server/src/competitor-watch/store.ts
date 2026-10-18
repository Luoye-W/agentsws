/**
 * WP392（docs/104 §3.3）：竞品监控的本机存储——一台机器一个 `competitor-watch.sqlite`，每一行钉着 `workspace_id`
 * （品牌之间互不可见，照 `reddit-watch/store.ts`）。
 *
 * 五张表：监控源（含各来源最近一次读的结果）、快照（每条源一行：每个款式的最新值 + 读到过的时间，**不存整页原文**）、
 * 变化（竞品变化表）、每一轮、杂项（设置…）。整条存 JSON；变化表把要筛的几格单独拎成列。
 */
import {
  type CatalogSnapshot,
  COMPETITOR_WATCH_SETTINGS_DEFAULTS,
  type CompetitorChange,
  type CompetitorChangeQuery,
  type CompetitorWatchRun,
  type CompetitorWatchSettings,
  type CompetitorWatchSource,
  type CompetitorWatchStore,
  type WorkspaceId,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cw_sources (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS cw_snapshots (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);
CREATE TABLE IF NOT EXISTS cw_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cw_changes_ws ON cw_changes (workspace_id, detected_at);
CREATE TABLE IF NOT EXISTS cw_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cw_runs_ws ON cw_runs (workspace_id, started_at);
CREATE TABLE IF NOT EXISTS cw_kv (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
`

const SETTINGS_KEY = 'settings'

/** 一台机器一份库，按品牌取那一份存储接口。 */
export interface CompetitorWatchDb {
  forWorkspace(workspace_id: WorkspaceId): CompetitorWatchStore
  close(): void
}

/** `dbPath` 不给就是内存档（测试与没有数据目录的档）。 */
export function createCompetitorWatchDb(dbPath?: string): CompetitorWatchDb {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const parse = <T>(r: unknown): T | undefined =>
    r === undefined ? undefined : (JSON.parse((r as { json: string }).json) as T)

  const forWorkspace = (ws: WorkspaceId): CompetitorWatchStore => {
    const kv = <T>(key: string): T | undefined =>
      parse<T>(db.prepare('SELECT json FROM cw_kv WHERE workspace_id = ? AND key = ?').get(ws, key))
    const setKv = (key: string, value: unknown): void => {
      db.prepare(
        `INSERT INTO cw_kv (workspace_id, key, json) VALUES (?,?,?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET json = excluded.json`,
      ).run(ws, key, JSON.stringify(value))
    }
    return {
      workspace_id: ws,
      sources: () =>
        (
          db.prepare('SELECT json FROM cw_sources WHERE workspace_id = ? ORDER BY id').all(ws) as {
            json: string
          }[]
        ).map((r) => JSON.parse(r.json) as CompetitorWatchSource),
      source: (id) =>
        parse(
          db.prepare('SELECT json FROM cw_sources WHERE workspace_id = ? AND id = ?').get(ws, id),
        ),
      putSource: (row) => {
        db.prepare(
          `INSERT INTO cw_sources (workspace_id, id, json) VALUES (?,?,?)
           ON CONFLICT(workspace_id, id) DO UPDATE SET json = excluded.json`,
        ).run(ws, row.id, JSON.stringify(row))
      },
      removeSource: (id) => {
        db.prepare('DELETE FROM cw_sources WHERE workspace_id = ? AND id = ?').run(ws, id)
      },
      snapshot: (source_id) =>
        parse<CatalogSnapshot>(
          db
            .prepare('SELECT json FROM cw_snapshots WHERE workspace_id = ? AND source_id = ?')
            .get(ws, source_id),
        ),
      putSnapshot: (s) => {
        db.prepare(
          `INSERT INTO cw_snapshots (workspace_id, source_id, json) VALUES (?,?,?)
           ON CONFLICT(workspace_id, source_id) DO UPDATE SET json = excluded.json`,
        ).run(ws, s.source_id, JSON.stringify({ ...s, workspace_id: ws }))
      },
      removeSnapshot: (source_id) => {
        db.prepare('DELETE FROM cw_snapshots WHERE workspace_id = ? AND source_id = ?').run(
          ws,
          source_id,
        )
      },
      putChanges: (changes) => {
        const put = db.prepare(
          `INSERT INTO cw_changes (id, workspace_id, detected_at, competitor_id, kind, source_id, source_kind, json)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        )
        db.transaction((list: readonly CompetitorChange[]) => {
          for (const c of list)
            put.run(
              c.id,
              ws,
              c.detected_at,
              c.competitor_id,
              c.kind,
              c.source_id,
              c.source_kind,
              JSON.stringify({ ...c, workspace_id: ws }),
            )
        })(changes)
      },
      changes: (q: CompetitorChangeQuery = {}) => {
        const where = ['workspace_id = ?']
        const args: unknown[] = [ws]
        if (q.since !== undefined) {
          where.push('detected_at >= ?')
          args.push(q.since)
        }
        if (q.until !== undefined) {
          where.push('detected_at < ?')
          args.push(q.until)
        }
        if (q.competitor_id !== undefined) {
          where.push('competitor_id = ?')
          args.push(q.competitor_id)
        }
        if (q.kinds !== undefined && q.kinds.length > 0) {
          where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`)
          args.push(...q.kinds)
        }
        if (q.source_id !== undefined) {
          where.push('source_id = ?')
          args.push(q.source_id)
        }
        if (q.source_kind !== undefined) {
          where.push('source_kind = ?')
          args.push(q.source_kind)
        }
        const limit = Math.max(1, Math.min(q.limit ?? 500, 5000))
        return (
          db
            .prepare(
              `SELECT json FROM cw_changes WHERE ${where.join(' AND ')}
               ORDER BY detected_at DESC, id DESC LIMIT ${limit}`,
            )
            .all(...args) as { json: string }[]
        ).map((r) => JSON.parse(r.json) as CompetitorChange)
      },
      settings: () => ({
        ...COMPETITOR_WATCH_SETTINGS_DEFAULTS,
        ...(kv<Partial<CompetitorWatchSettings>>(SETTINGS_KEY) ?? {}),
      }),
      putSettings: (next) => setKv(SETTINGS_KEY, next),
      runs: (limit = 20) =>
        (
          db
            .prepare(
              `SELECT json FROM cw_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
            )
            .all(ws) as { json: string }[]
        ).map((r) => JSON.parse(r.json) as CompetitorWatchRun),
      putRun: (run) => {
        db.prepare(
          `INSERT INTO cw_runs (id, workspace_id, started_at, json) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        ).run(run.id, ws, run.started_at, JSON.stringify(run))
      },
      kv,
      setKv,
    }
  }

  return { forWorkspace, close: () => db.close() }
}
