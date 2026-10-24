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
CREATE TABLE IF NOT EXISTS assistant_threads (
  person_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_segments_session ON assistant_segments (session_id, started_at);
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
  /** WP350：同一张方案卡派出去的带同一个来源批次（回报按批次聚在一起）。 */
  batch_id?: string
  batch_title?: string
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

/** WP352：一段话题为什么开始（第一段 / 隔了 2 小时以上 / 跨天 / 模型判断话题变了 / 人点了或说了「换个话题」/ 老会话迁过来）。 */
export type AssistantSegmentReason = 'first' | 'gap' | 'day' | 'topic' | 'manual' | 'migrated'

/**
 * WP352（决策 931）：助理那条长对话里的一段（一个话题）。话存在 `free_chat_messages`，每条带 `segment_id`；
 * 这里只记段的头尾、为什么切、段落小结（谁、要做什么、定了什么、派了哪些事）与段内压缩。
 */
export interface AssistantSegmentRow {
  id: string
  session_id: string
  person_id: string
  started_at: string
  /** 有 = 这段已经结束（后面开了新段）。 */
  ended_at?: string
  reason: AssistantSegmentReason
  /** 一行小结（分隔线上那一行）。 */
  title?: string
  /** 话题小结（几行；进下一段的开场上下文、能被「查以前聊过的」搜到）。 */
  summary?: string
  summarized_by?: 'ai' | 'rule'
  /** 这段里交出去的事（只记编号与一句话；进度永远现查）。 */
  dispatches?: { matter_id: string; title: string; position_name: string; batch_id?: string }[]
  /** 段内压缩：`upto` 这条（含）以前的原话已经压进 `text`，进模型时只带它与之后的原话。 */
  compact?: {
    upto: string
    text: string
    at: string
    /** WP511：压进去的话里附过的资料（编号、名字、字数）——小结末尾那一行按它重写，压几次都不丢。 */
    files?: { ref: string; name: string; chars: number }[]
  }
  /**
   * WP511（决策 1545）：估算 → 真 token 的换算比（模型报回的输入 / 我们估的，滑动平均，夹在 0.4–1.5）。
   * 原话预算按真 token 算，比较时用它把估算换过去；新的一段从上一段接着用。
   */
  token_ratio?: number
  /**
   * WP470（决策 1543）：这一段第一轮拼上下文时冻结的那几块——之后这一段每一轮的系统提示都用它，
   * 开头逐字不变才命中缓存。`memory_ids` = 当时已有的记忆（进系统提示的照旧是其中最近 20 条；段内新记的放末尾附加）；
   * `topics` = 当时那份「最近聊过的几个话题」（后台 AI 小结出来了也等下一段再换）。
   */
  frozen?: {
    at: string
    memory_ids: string[]
    topics: string
    topic_count: number
    topic_tokens: number
  }
}

export interface FreeChatStore {
  sessions(person_id: string): FreeChatSessionRow[]
  session(id: string): FreeChatSessionRow | undefined
  putSession(row: FreeChatSessionRow): void
  removeSession(id: string): boolean
  messages(session_id: string): FreeChatMessageView[]
  addMessage(message: FreeChatMessageView): void
  removeMessage(id: string): void
  /** WP350：改一条已经存下的话（方案卡点过之后状态变了）。没有这条就什么都不做。 */
  putMessage(message: FreeChatMessageView): void
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
  /** WP352：这个人的那条长对话（会话 id）；还没有就 `undefined`。 */
  threadOf(person_id: string): string | undefined
  setThread(person_id: string, session_id: string): void
  /** WP352：一段对话里的话题段（按开始时间）。 */
  segments(session_id: string): AssistantSegmentRow[]
  putSegment(row: AssistantSegmentRow): void
  /** WP352：把一段会话的话整段挪到另一段会话（迁移老会话用；接在目标会话末尾，标上 `segment_id`）。 */
  moveMessages(from: string, to: string, segment_id: string): number
  /** WP352：交出去的事那根线跟着挪（回报落到新的那条对话里）。 */
  retargetDispatches(from: string, to: string): void
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
    putMessage: (message) => {
      db.prepare('UPDATE free_chat_messages SET json = ? WHERE id = ?').run(
        JSON.stringify(message),
        message.id,
      )
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
    threadOf: (person_id) =>
      (
        db.prepare('SELECT session_id FROM assistant_threads WHERE person_id = ?').get(person_id) as
          | { session_id: string }
          | undefined
      )?.session_id,
    setThread: (person_id, session_id) => {
      db.prepare(
        `INSERT INTO assistant_threads (person_id, session_id) VALUES (?,?)
         ON CONFLICT(person_id) DO UPDATE SET session_id = excluded.session_id`,
      ).run(person_id, session_id)
    },
    segments: (session_id) =>
      (
        db
          .prepare(
            'SELECT json FROM assistant_segments WHERE session_id = ? ORDER BY started_at, rowid',
          )
          .all(session_id) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as AssistantSegmentRow),
    putSegment: (row) => {
      db.prepare(
        `INSERT INTO assistant_segments (id, session_id, person_id, started_at, json) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, started_at = excluded.started_at, json = excluded.json`,
      ).run(row.id, row.session_id, row.person_id, row.started_at, JSON.stringify(row))
    },
    moveMessages: (from, to, segment_id) =>
      db.transaction(() => {
        const rows = db
          .prepare('SELECT id, json FROM free_chat_messages WHERE session_id = ? ORDER BY seq')
          .all(from) as { id: string; json: string }[]
        const next = db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM free_chat_messages WHERE session_id = ?')
          .get(to) as { n: number }
        const move = db.prepare(
          'UPDATE free_chat_messages SET session_id = ?, seq = ?, json = ? WHERE id = ?',
        )
        rows.forEach((r, i) => {
          const m = { ...(JSON.parse(r.json) as FreeChatMessageView), session_id: to, segment_id }
          move.run(to, next.n + i + 1, JSON.stringify(m), r.id)
        })
        return rows.length
      })(),
    retargetDispatches: (from, to) => {
      const rows = db
        .prepare('SELECT matter_id, json FROM assistant_dispatches WHERE session_id = ?')
        .all(from) as { matter_id: string; json: string }[]
      const put = db.prepare(
        'UPDATE assistant_dispatches SET session_id = ?, json = ? WHERE matter_id = ?',
      )
      for (const r of rows)
        put.run(to, JSON.stringify({ ...JSON.parse(r.json), session_id: to }), r.matter_id)
    },
    close: () => {
      db.close()
    },
  }
}
