/**
 * 交易控制模块的表结构（14 §存储 / 15 §5）。
 *
 * 单独一个文件是为了让**双方言可移植性测试**能拿到同一份迁移集：
 * 同一批 DDL 经共用迁移器（`@agentsws/core/sql`）在 SQLite 与 Postgres 上各建一遍，
 * 建不出来就红在这里，而不是等真有人切 Postgres 才发现。
 *
 * 规范形态是 SQLite 那一份（`INTEGER` / `STRICT` 由方言表翻译）。
 */
import type { Migration } from '@agentsws/core/sql'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  role_id      TEXT,
  state        TEXT NOT NULL,
  dedupe_key   TEXT,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS approvals_by_ws ON approvals (workspace_id, state);
CREATE INDEX IF NOT EXISTS approvals_by_dedupe ON approvals (dedupe_key);

CREATE TABLE IF NOT EXISTS approval_revisions (
  item_id TEXT NOT NULL,
  json    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS approval_revisions_by_item ON approval_revisions (item_id);

CREATE TABLE IF NOT EXISTS approval_events (
  item_id  TEXT NOT NULL,
  event_id TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS approval_events_by_item ON approval_events (item_id);

CREATE TABLE IF NOT EXISTS tokens (
  token         TEXT PRIMARY KEY NOT NULL,
  item_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  person        TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  revoked       INTEGER NOT NULL,
  used          TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS tokens_by_item ON tokens (item_id);

CREATE TABLE IF NOT EXISTS changes (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  run_id        TEXT,
  assignment_id TEXT,
  change_set_id TEXT,
  status        TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  created_ms    INTEGER NOT NULL,
  json          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS changes_by_status ON changes (status, created_ms);
CREATE INDEX IF NOT EXISTS changes_by_target ON changes (target_key, kind);
CREATE INDEX IF NOT EXISTS changes_by_run    ON changes (run_id);

CREATE TABLE IF NOT EXISTS mandates (
  change_id TEXT PRIMARY KEY NOT NULL,
  json      TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS contexts (
  item_id TEXT PRIMARY KEY NOT NULL,
  json    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approved_changes (
  change_id TEXT PRIMARY KEY NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS reservations (
  change_id TEXT PRIMARY KEY NOT NULL,
  counter   TEXT NOT NULL,
  amount    INTEGER NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('held','committed','released'))
) STRICT;
CREATE INDEX IF NOT EXISTS reservations_by_counter ON reservations (counter, state);

CREATE TABLE IF NOT EXISTS provenance (
  run_id TEXT PRIMARY KEY NOT NULL,
  json   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cursors (
  name  TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
`,
  },
  {
    // WP31：跨进程施行锁 + 围栏号（31 §3.2「同目标同 kind 的 apply 串行」）。
    // `last_token` 单独一张表：锁行会被删（释放），围栏号却**不能回头**，
    // 否则接管者可能发出一个比老施行者还小的号，围栏就白建了。
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS apply_locks (
  key         TEXT PRIMARY KEY NOT NULL,
  holder      TEXT NOT NULL,
  token       INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS apply_lock_tokens (
  key   TEXT PRIMARY KEY NOT NULL,
  token INTEGER NOT NULL
) STRICT;
`,
  },
]
