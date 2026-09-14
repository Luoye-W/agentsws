/**
 * 聊天会话与消息的 SQLite 档（WP57）。接口与内存档一致——同一份一致性套件跑两遍。
 *
 * 两张表，本包自己的库（35 §2：不共享别的包的表）：
 * - `chat_session`：唯一键 `(workspace_id, source, external_session_id)` 由
 *   UNIQUE 索引兜住——同一个访客刷新页面回来接着说，不会多出一条会话；
 * - `chat_message`：`(session_id, external_id)` 唯一，重复投递只留一条
 *   （与入站管线的 24h 去重窗口是两道，各管各的：窗口管"重发"，这道管"重放"）。
 *
 * 纪律：SQL 全部参数化；`better-sqlite3` 同步 API；时间由调用方按注入的 Clock 传。
 */
import type { Clock, Iso8601, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { ChannelError } from '../errors.js'
import { type Migration, migrate } from '../migrations.js'
import {
  type ChatMessage,
  type ChatMessageRole,
  type ChatSession,
  type ChatSessionInput,
  type ChatSessionPatch,
  type ChatSource,
  type ChatStore,
  chatThreadExternalId,
} from './types.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS chat_session (
  id                   TEXT PRIMARY KEY NOT NULL,
  workspace_id         TEXT NOT NULL,
  source               TEXT NOT NULL,
  external_session_id  TEXT NOT NULL,
  visitor_id           TEXT NOT NULL,
  visitor_display      TEXT,
  visitor_email        TEXT,
  status               TEXT NOT NULL,
  thread_external_id   TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_seen_at         TEXT,
  assist_requested_at  TEXT,
  assist_reminded_at   TEXT,
  takeover             INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_unique
  ON chat_session (workspace_id, source, external_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_thread
  ON chat_session (thread_external_id);
CREATE INDEX IF NOT EXISTS chat_session_visitor ON chat_session (visitor_id);

CREATE TABLE IF NOT EXISTS chat_message (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT NOT NULL,
  at           TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  run_id       TEXT,
  plan_action  TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_unique ON chat_message (session_id, external_id);
CREATE INDEX IF NOT EXISTS chat_message_by_time ON chat_message (session_id, at);
`,
  },
]

interface SessionRow {
  id: string
  workspace_id: string
  source: string
  external_session_id: string
  visitor_id: string
  visitor_display: string | null
  visitor_email: string | null
  status: string
  thread_external_id: string
  created_at: string
  updated_at: string
  last_seen_at: string | null
  assist_requested_at: string | null
  assist_reminded_at: string | null
  takeover: number
}

interface MessageRow {
  id: string
  session_id: string
  workspace_id: string
  role: string
  text: string
  at: string
  external_id: string
  run_id: string | null
  plan_action: string | null
}

function toSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    source: row.source as ChatSource,
    external_session_id: row.external_session_id,
    visitor_id: row.visitor_id,
    status: row.status,
    thread_external_id: row.thread_external_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    takeover: row.takeover === 1,
    ...(row.visitor_display === null ? {} : { visitor_display: row.visitor_display }),
    ...(row.visitor_email === null ? {} : { visitor_email: row.visitor_email }),
    ...(row.last_seen_at === null ? {} : { last_seen_at: row.last_seen_at }),
    ...(row.assist_requested_at === null ? {} : { assist_requested_at: row.assist_requested_at }),
    ...(row.assist_reminded_at === null ? {} : { assist_reminded_at: row.assist_reminded_at }),
  }
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    workspace_id: row.workspace_id,
    role: row.role as ChatMessageRole,
    text: row.text,
    at: row.at,
    external_id: row.external_id,
    ...(row.run_id === null ? {} : { run_id: row.run_id }),
    ...(row.plan_action === null ? {} : { plan_action: row.plan_action }),
  }
}

export interface SqliteChatStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  clock?: Clock
}

export class SqliteChatStore implements ChatStore {
  private readonly db: Db

  constructor(options: SqliteChatStoreOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    migrate(this.db, MIGRATIONS, options.clock?.now() ?? '1970-01-01T00:00:00.000Z')
  }

  ensureSession(input: ChatSessionInput): ChatSession {
    const existing = this.findSession(input.workspace_id, input.source, input.external_session_id)
    if (existing !== undefined) return existing
    const n = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM chat_session')
      .get() as { n: number }
    const id = `cs_${String(n.n + 1).padStart(4, '0')}`
    this.db
      .prepare(
        `INSERT INTO chat_session
         (id, workspace_id, source, external_session_id, visitor_id, visitor_display, visitor_email,
          status, thread_external_id, created_at, updated_at, last_seen_at,
          assist_requested_at, assist_reminded_at, takeover)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?, NULL, NULL, NULL, 0)`,
      )
      .run(
        id,
        input.workspace_id,
        input.source,
        input.external_session_id,
        input.visitor_id,
        input.visitor_display ?? null,
        chatThreadExternalId(id),
        input.at,
        input.at,
      )
    return this.getSession(id) as ChatSession
  }

  getSession(id: string): ChatSession | undefined {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM chat_session WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : toSession(row)
  }

  findSession(
    workspace_id: WorkspaceId,
    source: ChatSource,
    external_session_id: string,
  ): ChatSession | undefined {
    const row = this.db
      .prepare<[string, string, string], SessionRow>(
        'SELECT * FROM chat_session WHERE workspace_id = ? AND source = ? AND external_session_id = ?',
      )
      .get(workspace_id, source, external_session_id)
    return row === undefined ? undefined : toSession(row)
  }

  findByThread(thread_external_id: string): ChatSession | undefined {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM chat_session WHERE thread_external_id = ?')
      .get(thread_external_id)
    return row === undefined ? undefined : toSession(row)
  }

  listSessions(
    workspace_id: WorkspaceId,
    filter: { status?: string[]; limit?: number } = {},
  ): ChatSession[] {
    const rows = this.db
      .prepare<[string], SessionRow>(
        'SELECT * FROM chat_session WHERE workspace_id = ? ORDER BY updated_at DESC',
      )
      .all(workspace_id)
    const list = rows
      .map(toSession)
      .filter((s) => filter.status === undefined || filter.status.includes(s.status))
    return filter.limit === undefined ? list : list.slice(0, filter.limit)
  }

  patchSession(id: string, patch: ChatSessionPatch): ChatSession {
    const prior = this.getSession(id)
    if (prior === undefined) throw new ChannelError('not_found', `没有这条会话：${id}`, { id })
    const nullable = (
      value: Iso8601 | null | undefined,
      current: Iso8601 | undefined,
    ): string | null => (value === null ? null : (value ?? current ?? null))
    this.db
      .prepare(
        `UPDATE chat_session SET status = ?, takeover = ?, visitor_email = ?, last_seen_at = ?,
           assist_requested_at = ?, assist_reminded_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? prior.status,
        (patch.takeover ?? prior.takeover) ? 1 : 0,
        patch.visitor_email ?? prior.visitor_email ?? null,
        patch.last_seen_at ?? prior.last_seen_at ?? null,
        nullable(patch.assist_requested_at, prior.assist_requested_at),
        nullable(patch.assist_reminded_at, prior.assist_reminded_at),
        patch.at,
        id,
      )
    return this.getSession(id) as ChatSession
  }

  appendMessage(input: Omit<ChatMessage, 'id'>): ChatMessage {
    if (this.getSession(input.session_id) === undefined) {
      throw new ChannelError('not_found', `没有这条会话：${input.session_id}`, {
        session_id: input.session_id,
      })
    }
    const already = this.db
      .prepare<[string, string], MessageRow>(
        'SELECT * FROM chat_message WHERE session_id = ? AND external_id = ?',
      )
      .get(input.session_id, input.external_id)
    if (already !== undefined) return toMessage(already)
    const n = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM chat_message')
      .get() as { n: number }
    const id = `cm_${String(n.n + 1).padStart(6, '0')}`
    this.db
      .prepare(
        `INSERT INTO chat_message (id, session_id, workspace_id, role, text, at, external_id, run_id, plan_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.session_id,
        input.workspace_id,
        input.role,
        input.text,
        input.at,
        input.external_id,
        input.run_id ?? null,
        input.plan_action ?? null,
      )
    return { ...input, id }
  }

  listMessages(session_id: string, filter: { limit?: number } = {}): ChatMessage[] {
    const rows = this.db
      .prepare<[string], MessageRow>(
        'SELECT * FROM chat_message WHERE session_id = ? ORDER BY at ASC, id ASC',
      )
      .all(session_id)
    const list = rows.map(toMessage)
    return filter.limit === undefined ? list : list.slice(-filter.limit)
  }

  /** 21 §4 随主体删除：这个访客的会话与消息一起清掉（一个事务）。 */
  eraseVisitor(visitor_id: string): number {
    const erase = this.db.transaction((who: string): number => {
      const ids = this.db
        .prepare<[string], { id: string }>('SELECT id FROM chat_session WHERE visitor_id = ?')
        .all(who)
        .map((r) => r.id)
      let rows = 0
      for (const id of ids) {
        rows += this.db.prepare('DELETE FROM chat_message WHERE session_id = ?').run(id).changes
        rows += this.db.prepare('DELETE FROM chat_session WHERE id = ?').run(id).changes
      }
      return rows
    })
    return erase(visitor_id)
  }

  close(): void {
    this.db.close()
  }
}
