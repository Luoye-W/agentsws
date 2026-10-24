/**
 * WP509：红人同步到表格的本机存储——这个品牌自己的目录下一个 `kol-sync.sqlite`（不给目录就全内存，测试 / 一次性进程）。
 *
 * 三张表：
 * - `kol_sync_sink`：一个同步设置一行（链接、列对照、同步什么、多久一次、阶段词对选项、状态、最近一次读回来的表）；
 * - `kol_sync_row`：一个人在这张表里上一次的样子（认行的原字、各列的字），`(sink_id, creator_id)` 唯一；
 * - `kol_sync_log`：**每一次同步的本机留痕**（写了谁、哪几格、结果、失败的原因）——发出去的一律本地留痕。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Iso8601, WorkspaceId } from '@agentsws/contracts'
import type {
  StageOptionMap,
  SyncColumn,
  SyncRowState,
  SyncTableSnapshot,
  SyncWhat,
} from '@agentsws/kol-core'
import type BetterSqlite3 from 'better-sqlite3'

export type KolSyncCadence = 'realtime' | 'hourly' | 'daily'
export type KolSyncState = 'pending_confirm' | 'active' | 'paused' | 'broken'

/** 一个同步设置（用户一句话配的，名字就是那张表的名字）。 */
export interface KolSyncSink {
  id: string
  workspace_id: WorkspaceId
  name: string
  url: string
  kind: 'bitable' | 'sheet'
  /** 经谁写（这一版只有 ego：用户已登录的浏览器，不要飞书开发者应用）。 */
  via: 'ego'
  instruction: string
  columns: SyncColumn[]
  key_column?: string
  what: SyncWhat
  cadence: KolSyncCadence
  stage_map: StageOptionMap
  /** 用户在卡上同意了「对不上的阶段在飞书里新建选项」。 */
  allow_new_options: boolean
  state: KolSyncState
  created_at: Iso8601
  updated_at: Iso8601
  confirmed_at?: Iso8601
  card_id?: string
  created_by: { person_id: string; assignment_id: string; role_id: string }
  /** 最近一次读回来的整张表（第一次对上表里已有的人用）。 */
  snapshot?: SyncTableSnapshot
  /** 有变化等着写的那一刻（攒一批再写）。 */
  pending_since?: Iso8601
  last_run_at?: Iso8601
  last_ok_at?: Iso8601
  /** 下一次自动试的时间（失败退避）。 */
  retry_at?: Iso8601
  failures?: number
  last_error?: { code: string; message: string; at: Iso8601 }
  totals: { appended: number; updated: number; fallback: number }
  /** 改设置：等确认的新一版（批了替换上面那几格；没批之前照旧按老的同步）。 */
  draft?: KolSyncDraft
}

/** 一版设置（出卡时那一份 / 改设置时等确认的那一份）。 */
export interface KolSyncDraft {
  name: string
  kind: 'bitable' | 'sheet'
  columns: SyncColumn[]
  key_column?: string
  what: SyncWhat
  cadence: KolSyncCadence
  stage_map: StageOptionMap
  allow_new_options: boolean
  snapshot?: SyncTableSnapshot
  card_id?: string
}

/** 一次同步的留痕。 */
export interface KolSyncLog {
  id: string
  sink_id: string
  at: Iso8601
  trigger: 'auto' | 'manual' | 'first'
  /** `nothing` = 没有要写的；其余同 ego 那一趟的结果。 */
  state: string
  message: string
  appended: number
  updated: number
  fallback: number
  failed: number
  items: {
    creator_id: string
    name: string
    action: 'append' | 'update' | 'progress'
    result: string
    cells: Record<string, string>
    why?: string
  }[]
}

/** 一个人的状态（`baseline` = 开同步那一刻库里已经有这个人：不算「新进的人」）。 */
export type KolSyncRowState = SyncRowState & { baseline?: boolean }

export interface KolSyncStore {
  sinks(): KolSyncSink[]
  sink(id: string): KolSyncSink | undefined
  putSink(row: KolSyncSink): void
  removeSink(id: string): void
  rows(sink_id: string): Map<string, KolSyncRowState>
  putRow(sink_id: string, creator_id: string, row: KolSyncRowState): void
  /** 新的在前。 */
  logs(sink_id: string, limit?: number): KolSyncLog[]
  addLog(row: KolSyncLog): void
  close(): void
}

interface Backend {
  all(table: string, where?: { col: string; val: string }): { id: string; json: string }[]
  put(table: string, id: string, json: string, extra?: Record<string, string>): void
  remove(table: string, where: { col: string; val: string }): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kol_sync_sink (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kol_sync_row (id TEXT PRIMARY KEY, sink_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS kol_sync_row_sink ON kol_sync_row (sink_id);
CREATE TABLE IF NOT EXISTS kol_sync_log (id TEXT PRIMARY KEY, sink_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS kol_sync_log_sink ON kol_sync_log (sink_id, at);
`

function sqliteBackend(path: string): Backend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: (table, where) =>
      (where === undefined
        ? db.prepare(`SELECT id, json FROM ${table} ORDER BY id`).all()
        : db
            .prepare(`SELECT id, json FROM ${table} WHERE ${where.col} = ? ORDER BY id`)
            .all(where.val)) as { id: string; json: string }[],
    put: (table, id, json, extra = {}) => {
      const cols = ['id', ...Object.keys(extra), 'json']
      db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, ...Object.values(extra), json)
    },
    remove: (table, where) => {
      db.prepare(`DELETE FROM ${table} WHERE ${where.col} = ?`).run(where.val)
    },
    close: () => db.close(),
  }
}

function memoryBackend(): Backend {
  const tables = new Map<string, Map<string, { json: string; extra: Record<string, string> }>>()
  const of = (t: string) => {
    let m = tables.get(t)
    if (m === undefined) {
      m = new Map()
      tables.set(t, m)
    }
    return m
  }
  return {
    all: (table, where) =>
      [...of(table).entries()]
        .filter(
          ([id, v]) =>
            where === undefined || (where.col === 'id' ? id : v.extra[where.col]) === where.val,
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, v]) => ({ id, json: v.json })),
    put: (table, id, json, extra = {}) => {
      of(table).set(id, { json, extra })
    },
    remove: (table, where) => {
      const m = of(table)
      for (const [id, v] of [...m.entries()])
        if ((where.col === 'id' ? id : v.extra[where.col]) === where.val) m.delete(id)
    },
    close: () => tables.clear(),
  }
}

export function createKolSyncStore(options: { dbDir?: string | undefined } = {}): KolSyncStore {
  const b =
    options.dbDir === undefined
      ? memoryBackend()
      : sqliteBackend(join(options.dbDir, 'kol-sync.sqlite'))
  const parse = <T>(r: { json: string }): T => JSON.parse(r.json) as T
  return {
    sinks: () => b.all('kol_sync_sink').map((r) => parse<KolSyncSink>(r)),
    sink: (id) => {
      const r = b.all('kol_sync_sink', { col: 'id', val: id })[0]
      return r === undefined ? undefined : parse<KolSyncSink>(r)
    },
    putSink: (row) => b.put('kol_sync_sink', row.id, JSON.stringify(row)),
    removeSink: (id) => {
      b.remove('kol_sync_sink', { col: 'id', val: id })
      b.remove('kol_sync_row', { col: 'sink_id', val: id })
      b.remove('kol_sync_log', { col: 'sink_id', val: id })
    },
    rows: (sink_id) =>
      new Map(
        b
          .all('kol_sync_row', { col: 'sink_id', val: sink_id })
          .map((r) => [r.id.slice(sink_id.length + 1), parse<KolSyncRowState>(r)]),
      ),
    putRow: (sink_id, creator_id, row) =>
      b.put('kol_sync_row', `${sink_id}:${creator_id}`, JSON.stringify(row), { sink_id }),
    logs: (sink_id, limit = 20) =>
      b
        .all('kol_sync_log', { col: 'sink_id', val: sink_id })
        .map((r) => parse<KolSyncLog>(r))
        .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? 1 : -1))
        .slice(0, limit),
    addLog: (row) =>
      b.put('kol_sync_log', row.id, JSON.stringify(row), { sink_id: row.sink_id, at: row.at }),
    close: () => b.close(),
  }
}
