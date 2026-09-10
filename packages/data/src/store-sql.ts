/**
 * 共享数据层的 **SQL 与行形状**（21 §2）——SQLite 档与 Postgres 档共用这一份。
 *
 * 与 kernel 事件日志同一个做法：两个方言各写一份 SQL 必然跑偏，
 * 而这一层扛着「过滤在数据层、不在应用层」（21 §3）与字段分级，跑偏了看不见。
 */
import type { SqlDialect } from '@agentsws/core/sql'

export interface Row {
  id: string
  schema_version: number
  workspace_id: string
  owners: string
  scope: string
  sensitivity: string
  source: string | null
  created_at: string
  updated_at: string
  version: string
  body: string
}

export interface TombstoneRow {
  subject_id: string
  collection: string
  record_id: string
  workspace_id: string
  at: string
  event: string
}

/** 每个 collection 一张表（21 §2 信封列 + body JSON）。 */
export function collectionDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS "${name}" (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  owners TEXT NOT NULL,
  scope TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "${name}_ws" ON "${name}" (workspace_id);`
}

export const TOMBSTONES_DDL = `CREATE TABLE IF NOT EXISTS _tombstones (
  subject_id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL
)`

export const INSERT_TOMBSTONE_SQL = `INSERT INTO _tombstones
  (subject_id, collection, record_id, workspace_id, at, event)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (subject_id) DO NOTHING`

export const SELECT_TOMBSTONES_SQL = 'SELECT * FROM _tombstones ORDER BY at ASC, subject_id ASC'

export const COUNT_TOMBSTONE_SQL = 'SELECT COUNT(*) AS n FROM _tombstones WHERE subject_id = ?'

export function selectOneSql(table: string, where: string): string {
  return `SELECT * FROM "${table}" WHERE workspace_id = ? AND id = ? AND ${where}`
}

export const RECORD_COLUMNS = [
  'id',
  'schema_version',
  'workspace_id',
  'owners',
  'scope',
  'sensitivity',
  'source',
  'created_at',
  'updated_at',
  'version',
  'body',
] as const

export function insertRecordSql(table: string): string {
  return `INSERT INTO "${table}"
   (${RECORD_COLUMNS.join(', ')})
   VALUES (${RECORD_COLUMNS.map(() => '?').join(', ')})`
}

export function updateRecordSql(table: string): string {
  return `UPDATE "${table}" SET schema_version = ?, owners = ?, scope = ?, sensitivity = ?,
     source = ?, updated_at = ?, version = ?, body = ?
   WHERE id = ? AND version = ?`
}

/** 主体密钥表（21 §4）。两个档共用；`key BLOB` 由方言表翻成 BYTEA。 */
export const SUBJECT_KEYS_DDL = `CREATE TABLE IF NOT EXISTS _subject_keys (
  subject_id TEXT PRIMARY KEY,
  key BLOB,
  created_at TEXT NOT NULL,
  destroyed_at TEXT,
  wrapped INTEGER NOT NULL DEFAULT 0
)`

export const SELECT_KEY_SQL = 'SELECT * FROM _subject_keys WHERE subject_id = ?'

export const INSERT_KEY_SQL =
  'INSERT INTO _subject_keys (subject_id, key, created_at, wrapped) VALUES (?, ?, ?, ?)'

export const INSERT_DESTROYED_KEY_SQL =
  'INSERT INTO _subject_keys (subject_id, key, created_at, destroyed_at, wrapped) VALUES (?, NULL, ?, ?, 0)'

export const DESTROY_KEY_SQL =
  'UPDATE _subject_keys SET key = NULL, destroyed_at = ? WHERE subject_id = ?'

/** 21 §3「过滤下推」：JSON 字段等值过滤的两套写法由驱动那层的 `jsonExtract` 给。 */
export type { SqlDialect }
