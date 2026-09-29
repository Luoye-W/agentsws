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
`

export interface FreeChatSessionRow extends FreeChatSessionView {
  person_id: string
}

export interface FreeChatStore {
  sessions(person_id: string): FreeChatSessionRow[]
  session(id: string): FreeChatSessionRow | undefined
  putSession(row: FreeChatSessionRow): void
  removeSession(id: string): boolean
  messages(session_id: string): FreeChatMessageView[]
  addMessage(message: FreeChatMessageView): void
  removeMessage(id: string): void
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
    close: () => {
      db.close()
    },
  }
}
