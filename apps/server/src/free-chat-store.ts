/**
 * WP188「随便聊」的本机存储：一个品牌一个 `free-chat.sqlite`（和事项分开，不进事件日志）。
 *
 * 两张表：会话（谁的、叫什么、最后动过的时间）与话（一条一行，正文与附带的东西整条存 JSON）。
 * 图片也存在这里——它是用户贴进来的，删会话就一起删掉；它**永不**进事件日志。
 */

import type { FreeChatMessageView, FreeChatSessionView } from '@agentsws/api'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS free_chat_sessions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS free_chat_sessions_person ON free_chat_sessions (person_id, updated_at);
CREATE TABLE IF NOT EXISTS free_chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS free_chat_messages_session ON free_chat_messages (session_id, seq);
CREATE TABLE IF NOT EXISTS assistant_dispatches (
  matter_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_dispatches_session ON assistant_dispatches (session_id, at);
CREATE TABLE IF NOT EXISTS assistant_memory (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_memory_person ON assistant_memory (person_id, at);
CREATE TABLE IF NOT EXISTS assistant_memory_tombstones (
  person_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
`

export interface FreeChatSessionRow extends FreeChatSessionView {
  person_id: string
}

/**
 * WP343：助理交给岗位的一件事（对话 ↔ 事项的那根线）。`reported` 是已经回报过的那几步
 * （`done:<run>` / `failed:<run>` / `card:<卡>`），同一步只报一次。
 */
export interface AssistantDispatchRow {
  matter_id: string
  session_id: string
  person_id: string
  at: string
  title: string
  position_id: string
  position_name: string
  role_id?: string
  duty_name?: string
  reported: string[]
}

/** WP343：「我的助理」这一层的一条记忆（本人的，只在助理对话里用）。 */
export interface AssistantMemoryRow {
  id: string
  person_id: string
  at: string
  text: string
  written_by: 'ai' | 'person'
  reason?: string
  session_id?: string
}

export interface FreeChatStore {
  sessions(person_id: string): FreeChatSessionRow[]
  session(id: string): FreeChatSessionRow | undefined
  putSession(row: FreeChatSessionRow): void
  removeSession(id: string): boolean
  messages(session_id: string): FreeChatMessageView[]
  addMessage(message: FreeChatMessageView): void
  removeMessage(id: string): void
  /** WP343：记下 / 更新一件交出去的事。 */
  putDispatch(row: AssistantDispatchRow): void
  /** WP343：这个人交出去、`since` 之后的事（新的在后）。 */
  dispatches(person_id: string, since?: string): AssistantDispatchRow[]
  /** WP343：助理层记忆（本人的，按时间）。 */
  memories(person_id: string): AssistantMemoryRow[]
  putMemory(row: AssistantMemoryRow): void
  removeMemory(id: string): AssistantMemoryRow | undefined
  /** 删过的那几句（AI 不再记回来，除非人又明说）。 */
  tombstones(person_id: string): string[]
  close(): void
}

/** `dbPath` 不给就是内存档（测试与一次性任务）。 */
export function createFreeChatStore(dbPath?: string): FreeChatStore {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const sessionCols = 'id, person_id, title, created_at, updated_at'
  return {
    sessions: (person_id) =>
      db
        .prepare(
          `SELECT ${sessionCols} FROM free_chat_sessions WHERE person_id = ? ORDER BY updated_at DESC, id DESC`,
        )
        .all(person_id) as FreeChatSessionRow[],
    session: (id) =>
      db.prepare(`SELECT ${sessionCols} FROM free_chat_sessions WHERE id = ?`).get(id) as
        | FreeChatSessionRow
        | undefined,
    putSession: (row) => {
      db.prepare(
        `INSERT INTO free_chat_sessions (${sessionCols}) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      ).run(row.id, row.person_id, row.title, row.created_at, row.updated_at)
    },
    removeSession: (id) =>
      db.transaction(() => {
        db.prepare('DELETE FROM free_chat_messages WHERE session_id = ?').run(id)
        return db.prepare('DELETE FROM free_chat_sessions WHERE id = ?').run(id).changes > 0
      })(),
    messages: (session_id) =>
      (
        db
          .prepare('SELECT json FROM free_chat_messages WHERE session_id = ? ORDER BY seq')
          .all(session_id) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as FreeChatMessageView),
    addMessage: (message) => {
      const next = db
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM free_chat_messages WHERE session_id = ?',
        )
        .get(message.session_id) as { n: number }
      db.prepare('INSERT INTO free_chat_messages (id, session_id, seq, json) VALUES (?,?,?,?)').run(
        message.id,
        message.session_id,
        next.n,
        JSON.stringify(message),
      )
    },
    removeMessage: (id) => {
      db.prepare('DELETE FROM free_chat_messages WHERE id = ?').run(id)
    },
    putDispatch: (row) => {
      db.prepare(
        `INSERT INTO assistant_dispatches (matter_id, session_id, person_id, at, json) VALUES (?,?,?,?,?)
         ON CONFLICT(matter_id) DO UPDATE SET json = excluded.json`,
      ).run(row.matter_id, row.session_id, row.person_id, row.at, JSON.stringify(row))
    },
    dispatches: (person_id, since) =>
      (
        db
          .prepare(
            'SELECT json FROM assistant_dispatches WHERE person_id = ? AND at >= ? ORDER BY at, matter_id',
          )
          .all(person_id, since ?? '') as { json: string }[]
      ).map((r) => JSON.parse(r.json) as AssistantDispatchRow),
    memories: (person_id) =>
      (
        db
          .prepare('SELECT json FROM assistant_memory WHERE person_id = ? ORDER BY at, id')
          .all(person_id) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as AssistantMemoryRow),
    putMemory: (row) => {
      db.prepare(
        `INSERT INTO assistant_memory (id, person_id, at, json) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(row.id, row.person_id, row.at, JSON.stringify(row))
    },
    removeMemory: (id) =>
      db.transaction(() => {
        const got = db.prepare('SELECT json FROM assistant_memory WHERE id = ?').get(id) as
          | { json: string }
          | undefined
        if (got === undefined) return undefined
        const row = JSON.parse(got.json) as AssistantMemoryRow
        db.prepare('DELETE FROM assistant_memory WHERE id = ?').run(id)
        db.prepare(
          'INSERT INTO assistant_memory_tombstones (person_id, text, at) VALUES (?,?,?)',
        ).run(row.person_id, row.text, row.at)
        return row
      })(),
    tombstones: (person_id) =>
      (
        db
          .prepare('SELECT text FROM assistant_memory_tombstones WHERE person_id = ?')
          .all(person_id) as { text: string }[]
      ).map((r) => r.text),
    close: () => {
      db.close()
    },
  }
}
