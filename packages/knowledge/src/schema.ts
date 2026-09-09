import type { Database } from 'better-sqlite3'

/**
 * 单库三簇表：事实卡（+ scope 展开表 + FTS5 + 向量）、运行记忆、导入源与缺口队列。
 * scope 展开成一行一个 `kind:id`，让 `range: 'assigned'` 的可见性判断留在 SQL 里（过滤下推）。
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fact_cards (
  id                     TEXT PRIMARY KEY,
  schema_version         INTEGER NOT NULL,
  workspace_id           TEXT NOT NULL,
  layer                  TEXT NOT NULL,
  domain                 TEXT NOT NULL,
  scope_json             TEXT NOT NULL,
  sensitivity            TEXT NOT NULL,
  sensitivity_rank       INTEGER NOT NULL,
  subject_type           TEXT NOT NULL,
  subject_id             TEXT,
  subject_key            TEXT NOT NULL,
  statement              TEXT NOT NULL,
  structured_json        TEXT,
  provenance_json        TEXT NOT NULL,
  confidence_value       REAL NOT NULL,
  confidence_state       TEXT NOT NULL,
  conflicts_json         TEXT NOT NULL,
  valid_from             TEXT,
  valid_until            TEXT,
  usage_recalled         INTEGER NOT NULL,
  usage_cited            INTEGER NOT NULL,
  usage_last_recalled_at TEXT,
  usage_drafts_edited    INTEGER NOT NULL,
  status                 TEXT NOT NULL,
  owner                  TEXT NOT NULL,
  created_by_kind        TEXT NOT NULL,
  created_by_id          TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_cards_ws ON fact_cards (workspace_id, status);
CREATE INDEX IF NOT EXISTS fact_cards_subject ON fact_cards (workspace_id, subject_key);

CREATE TABLE IF NOT EXISTS fact_card_scopes (
  card_id TEXT NOT NULL REFERENCES fact_cards (id) ON DELETE CASCADE,
  ref     TEXT NOT NULL,
  PRIMARY KEY (card_id, ref)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fact_cards_fts USING fts5(
  card_id UNINDEXED,
  text,
  ngram,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS fact_card_vectors (
  card_id TEXT PRIMARY KEY REFERENCES fact_cards (id) ON DELETE CASCADE,
  dim     INTEGER NOT NULL,
  vec     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_card_citations (
  card_id TEXT NOT NULL,
  run_id  TEXT NOT NULL,
  at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_facts (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    TEXT NOT NULL,
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  category        TEXT NOT NULL,
  source_run_hash TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  written_at      TEXT NOT NULL,
  state           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_facts_subject
  ON memory_facts (workspace_id, subject_type, subject_id, state);

-- 19 §1.3 导入源：同工作区同 (kind, ref) 只有一条
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  ref            TEXT NOT NULL,
  parser         TEXT NOT NULL,
  acl_inherit    INTEGER NOT NULL,
  chunks         INTEGER NOT NULL,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_ref
  ON knowledge_sources (workspace_id, kind, ref);

-- 19 §4 缺口队列：Agent 答不了的问题，等人答
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  question         TEXT NOT NULL,
  subject_type     TEXT NOT NULL,
  subject_id       TEXT,
  subject_key      TEXT NOT NULL,
  domain           TEXT NOT NULL,
  status           TEXT NOT NULL,
  asked_by_kind    TEXT NOT NULL,
  asked_by_id      TEXT NOT NULL,
  run_id           TEXT,
  answer           TEXT,
  answered_by      TEXT,
  answered_at      TEXT,
  approval_item_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_gaps_queue
  ON knowledge_gaps (workspace_id, status, created_at);
-- 「同问题只开一条」：只对还开着的那些唯一
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_gaps_open
  ON knowledge_gaps (workspace_id, subject_key, question) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS knowledge_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`

export function migrate(db: Database): void {
  db.exec(SCHEMA_SQL)
}

/** 单调计数器，用于生成稳定的卡片 id（不依赖 Math.random / Date.now）。 */
export function nextSeq(db: Database, name: string): number {
  const row = db.prepare('SELECT v FROM knowledge_meta WHERE k = ?').get(name) as
    | { v: string }
    | undefined
  const next = (row ? Number.parseInt(row.v, 10) : 0) + 1
  db.prepare(
    'INSERT INTO knowledge_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?',
  ).run(name, String(next), String(next))
  return next
}
