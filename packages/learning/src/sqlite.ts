/**
 * lesson 池的落盘档（表在本包，不共享别的包的表——35 §2）。
 *
 * 两张表：`learning_lessons`（池）与 `learning_rejected`（语义键黑名单）。
 * 全部参数化 SQL；时间由调用方经 Clock 给，这里不读机器时钟。
 */

import type { WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { LearningStore, LessonFilter } from './pool.js'
import type { PooledLesson, RejectedKey } from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_lessons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  section_id TEXT,
  semantic_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  signal TEXT NOT NULL,
  strength TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  hits INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  runs TEXT NOT NULL,
  assignments TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  proposed_at TEXT
);
CREATE INDEX IF NOT EXISTS learning_lessons_ws ON learning_lessons(workspace_id, status);
CREATE INDEX IF NOT EXISTS learning_lessons_key ON learning_lessons(workspace_id, semantic_key);
CREATE TABLE IF NOT EXISTS learning_rejected (
  workspace_id TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  skill TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, semantic_key)
);
`

interface Row {
  id: string
  workspace_id: string
  skill: string
  section_id: string | null
  semantic_key: string
  kind: string
  signal: string
  strength: string
  text: string
  confidence: number
  hits: number
  status: string
  run_id: string
  assignment_id: string
  runs: string
  assignments: string
  evidence: string
  created_at: string
  updated_at: string
  proposed_at: string | null
}

function toLesson(r: Row): PooledLesson {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    assignment_id: r.assignment_id,
    run_id: r.run_id,
    applies_to: {
      skill: r.skill,
      ...(r.section_id === null ? {} : { section_id: r.section_id }),
    },
    kind: r.kind as PooledLesson['kind'],
    signal: r.signal as PooledLesson['signal'],
    strength: r.strength as PooledLesson['strength'],
    text: r.text,
    confidence: r.confidence,
    semantic_key: r.semantic_key,
    evidence: JSON.parse(r.evidence) as PooledLesson['evidence'],
    hits: r.hits,
    status: r.status as PooledLesson['status'],
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(r.proposed_at === null ? {} : { proposed_at: r.proposed_at }),
    runs: JSON.parse(r.runs) as string[],
    assignments: JSON.parse(r.assignments) as string[],
  }
}

export interface SqliteLearningStoreOptions {
  /** 缺省 `:memory:`。 */
  dbPath?: string
  db?: Db
}

export class SqliteLearningStore implements LearningStore {
  readonly db: Db
  readonly #own: boolean

  constructor(options: SqliteLearningStoreOptions = {}) {
    this.db = options.db ?? new Database(options.dbPath ?? ':memory:')
    this.#own = options.db === undefined
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  put(lesson: PooledLesson): void {
    this.db
      .prepare(
        `INSERT INTO learning_lessons
           (id, workspace_id, skill, section_id, semantic_key, kind, signal, strength, text,
            confidence, hits, status, run_id, assignment_id, runs, assignments, evidence,
            created_at, updated_at, proposed_at)
         VALUES
           (@id, @workspace_id, @skill, @section_id, @semantic_key, @kind, @signal, @strength, @text,
            @confidence, @hits, @status, @run_id, @assignment_id, @runs, @assignments, @evidence,
            @created_at, @updated_at, @proposed_at)
         ON CONFLICT(id) DO UPDATE SET
           semantic_key = excluded.semantic_key, text = excluded.text,
           confidence = excluded.confidence, hits = excluded.hits, status = excluded.status,
           runs = excluded.runs, assignments = excluded.assignments, evidence = excluded.evidence,
           updated_at = excluded.updated_at, proposed_at = excluded.proposed_at`,
      )
      .run({
        id: lesson.id,
        workspace_id: lesson.workspace_id,
        skill: lesson.applies_to.skill,
        section_id: lesson.applies_to.section_id ?? null,
        semantic_key: lesson.semantic_key,
        kind: lesson.kind,
        signal: lesson.signal,
        strength: lesson.strength,
        text: lesson.text,
        confidence: lesson.confidence,
        hits: lesson.hits,
        status: lesson.status,
        run_id: lesson.run_id,
        assignment_id: lesson.assignment_id,
        runs: JSON.stringify(lesson.runs),
        assignments: JSON.stringify(lesson.assignments),
        evidence: JSON.stringify(lesson.evidence),
        created_at: lesson.created_at,
        updated_at: lesson.updated_at,
        proposed_at: lesson.proposed_at ?? null,
      })
  }

  get(id: string): PooledLesson | undefined {
    const row = this.db.prepare('SELECT * FROM learning_lessons WHERE id = ?').get(id) as
      | Row
      | undefined
    return row === undefined ? undefined : toLesson(row)
  }

  list(filter: LessonFilter): PooledLesson[] {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (filter.workspace_id !== undefined) {
      where.push('workspace_id = @workspace_id')
      params.workspace_id = filter.workspace_id
    }
    if (filter.skill !== undefined) {
      where.push('skill = @skill')
      params.skill = filter.skill
    }
    if (filter.status !== undefined) {
      where.push('status = @status')
      params.status = filter.status
    }
    const sql = `SELECT * FROM learning_lessons${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ORDER BY id`
    const rows = this.db.prepare(sql).all(params) as Row[]
    const out = rows.map(toLesson)
    // assignment 过滤在 JS 侧：合并后的来源是 JSON 数组，SQL 里 LIKE 会误命中前缀
    return filter.assignment_id === undefined
      ? out
      : out.filter((l) => l.assignments.includes(filter.assignment_id as string))
  }

  reject(entry: RejectedKey): void {
    this.db
      .prepare(
        `INSERT INTO learning_rejected (workspace_id, semantic_key, skill, reason, at, by)
         VALUES (@workspace_id, @semantic_key, @skill, @reason, @at, @by)
         ON CONFLICT(workspace_id, semantic_key) DO UPDATE SET
           reason = excluded.reason, at = excluded.at, by = excluded.by`,
      )
      .run(entry)
  }

  rejected(workspace_id: WorkspaceId): RejectedKey[] {
    return this.db
      .prepare('SELECT * FROM learning_rejected WHERE workspace_id = ? ORDER BY semantic_key')
      .all(workspace_id) as RejectedKey[]
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM learning_lessons WHERE id = ?').run(id)
  }

  close(): void {
    if (this.#own) this.db.close()
  }
}
