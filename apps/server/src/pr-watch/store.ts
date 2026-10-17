/**
 * WP386：信息监控的存储——落在**这个品牌自己的**公关库 `pr.sqlite` 里（与提及同一个文件，四张新表），
 * 不给目录就是内存档（测试与一次性任务）。形状是契约里的 `PrWatchStore`（WP387 依赖它）。
 *
 * feed 地址（Google Alerts 的地址本身就是钥匙）只在这里，不进事件、不进模型上下文。
 */
import { join } from 'node:path'
import {
  MONITOR_SETTINGS_DEFAULTS,
  type MonitorPlanItem,
  type MonitorRun,
  type MonitorSettings,
  type MonitorSource,
  type PrWatchStore,
  type WorkspaceId,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pw_source (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pw_plan (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pw_run (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pw_run_started ON pw_run (started_at);
CREATE TABLE IF NOT EXISTS pw_kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
`

/** 一轮留多少条（够右栏「上一轮」与简报用）。 */
const RUNS_KEPT = 200

export interface PrWatchStoreHandle extends PrWatchStore {
  close(): void
}

/** 设置收进合法范围（认不出的格用默认值）。 */
export function normalizeMonitorSettings(
  raw: Partial<MonitorSettings> | undefined,
): MonitorSettings {
  const d = MONITOR_SETTINGS_DEFAULTS
  const int = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
  }
  const queries: string[] = []
  for (const q of raw?.reddit_queries ?? []) {
    const t = String(q).trim().slice(0, 120)
    if (t !== '' && !queries.some((x) => x.toLowerCase() === t.toLowerCase())) queries.push(t)
  }
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    day_start_hour: int(raw?.day_start_hour, 0, 23, d.day_start_hour),
    default_every_hours: int(raw?.default_every_hours, 1, 168, d.default_every_hours),
    reddit_queries: queries.slice(0, 20),
  }
}

export function createPrWatchStore(input: {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）；不给就全内存。 */
  dbDir?: string
}): PrWatchStoreHandle {
  const db = new Database(input.dbDir === undefined ? ':memory:' : join(input.dbDir, 'pr.sqlite'))
  if (input.dbDir !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const all = <T>(table: string): T[] =>
    (db.prepare(`SELECT json FROM ${table} ORDER BY id`).all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as T,
    )
  const one = <T>(table: string, id: string): T | undefined => {
    const r = db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as
      | { json: string }
      | undefined
    return r === undefined ? undefined : (JSON.parse(r.json) as T)
  }
  const put = (table: string, id: string, row: unknown): void => {
    db.prepare(
      `INSERT INTO ${table} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    ).run(id, JSON.stringify(row))
  }
  const kv = <T>(key: string): T | undefined => {
    const r = db.prepare('SELECT json FROM pw_kv WHERE key = ?').get(key) as
      | { json: string }
      | undefined
    return r === undefined ? undefined : (JSON.parse(r.json) as T)
  }
  const setKv = (key: string, value: unknown): void => {
    db.prepare(
      'INSERT INTO pw_kv (key, json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
    ).run(key, JSON.stringify(value))
  }
  return {
    workspace_id: input.workspace_id,
    sources: () => all<MonitorSource>('pw_source'),
    source: (id) => one<MonitorSource>('pw_source', id),
    putSource: (row) => put('pw_source', row.id, row),
    removeSource: (id) => {
      db.prepare('DELETE FROM pw_source WHERE id = ?').run(id)
    },
    planItems: () => all<MonitorPlanItem>('pw_plan'),
    planItem: (id) => one<MonitorPlanItem>('pw_plan', id),
    putPlanItem: (row) => put('pw_plan', row.id, row),
    removePlanItem: (id) => {
      db.prepare('DELETE FROM pw_plan WHERE id = ?').run(id)
    },
    settings: () => normalizeMonitorSettings(kv<Partial<MonitorSettings>>('settings')),
    putSettings: (next) => setKv('settings', normalizeMonitorSettings(next)),
    runs: (limit = 20) =>
      (
        db
          .prepare(`SELECT json FROM pw_run ORDER BY started_at DESC LIMIT ?`)
          .all(Math.max(1, Math.min(limit, RUNS_KEPT))) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as MonitorRun),
    putRun: (run) => {
      db.prepare(
        `INSERT INTO pw_run (id, started_at, json) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(run.id, run.started_at, JSON.stringify(run))
      db.prepare(
        `DELETE FROM pw_run WHERE id NOT IN (SELECT id FROM pw_run ORDER BY started_at DESC LIMIT ${RUNS_KEPT})`,
      ).run()
    },
    kv,
    setKv,
    close: () => db.close(),
  }
}
