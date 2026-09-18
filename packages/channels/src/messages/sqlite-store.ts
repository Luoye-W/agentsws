/**
 * WP113（63 §3）：消息库的 SQLite 档。**自己一张库、自己一张 `_migrations`**
 * （35 §2「每个包一张自己的 `_migrations`，不共享其他包的表」）。
 *
 * 形照 `sqlite-queue.ts`：内嵌迁移数组 + 参数化 SQL + 同步 `better-sqlite3`。
 *
 * 两件事故意这么设计：
 *
 * 1. **正文与元数据同一行，用 `json` 列装整条记录**，另外把要筛的几格
 *    （账号 / 文件夹 / 会话 / 时间 / 已读 / 星标 / 路由）拎出来建索引。
 *    邮件的形状还在长（附件、标签、分拣结论都是这一版才有的），一列一列拆表
 *    的代价是每加一个字段就得写一次迁移，而这只库的量级（一只邮箱几万封）
 *    根本用不上那点收益。
 * 2. **细筛与会话聚合走 `query.ts` 的纯函数**，SQL 只做索引粗筛。两个实现
 *    （内存 / SQLite）于是必然给出一样的答案——搜索这种东西最怕两边不一致。
 */

import type {
  Clock,
  MessageDraft,
  MessageFolder,
  MessageLabel,
  MessageListQuery,
  MessageRecord,
  MessageThreadSummary,
  SenderRule,
} from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { type Migration, migrate, schemaVersion } from '../migrations.js'
import { BUILTIN_LABELS } from './labels.js'
import { aggregateThreads, byNewest, matchesQuery } from './query.js'
import type { MessagePatch, MessageStore } from './store.js'

export const MESSAGE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source       TEXT NOT NULL,
  account      TEXT NOT NULL,
  folder       TEXT NOT NULL,
  folder_kind  TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  message_id   TEXT,
  date_ms      INTEGER NOT NULL,
  read         INTEGER NOT NULL,
  starred      INTEGER NOT NULL,
  route        TEXT NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS messages_by_folder ON messages (account, folder, date_ms DESC);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id, date_ms);
CREATE INDEX IF NOT EXISTS messages_by_route  ON messages (workspace_id, route, date_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_mid ON messages (account, message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_labels (
  id      TEXT PRIMARY KEY NOT NULL,
  builtin INTEGER NOT NULL,
  json    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS message_sender_rules (
  id     TEXT PRIMARY KEY NOT NULL,
  sender TEXT NOT NULL,
  json   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sender_rules_by_sender ON message_sender_rules (sender);

CREATE TABLE IF NOT EXISTS message_drafts (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  json          TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS message_trusted_senders (
  email TEXT PRIMARY KEY NOT NULL
) STRICT;
`,
  },
]

export interface SqliteMessageStoreOptions {
  dbPath?: string
  clock?: Clock
  database?: Db
}

const EPOCH = '1970-01-01T00:00:00.000Z'

interface Row {
  json: string
}

export class SqliteMessageStore implements MessageStore {
  readonly #db: Db
  readonly #owned: boolean
  #closed = false

  constructor(options: SqliteMessageStoreOptions = {}) {
    if (options.database !== undefined) {
      this.#db = options.database
      this.#owned = false
    } else {
      this.#db = new Database(options.dbPath ?? ':memory:')
      this.#db.pragma('journal_mode = WAL')
      this.#db.pragma('busy_timeout = 5000')
      this.#owned = true
    }
    migrate(this.#db, MESSAGE_MIGRATIONS, options.clock?.now() ?? EPOCH)
    this.#seedLabels()
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  /** 内置标签是**数据**不是代码常量：用户改了名字改了色，改的就是这几行。 */
  #seedLabels(): void {
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO message_labels (id, builtin, json) VALUES (?,1,?)',
    )
    const seed = this.#db.transaction(() => {
      for (const l of BUILTIN_LABELS) insert.run(l.id, JSON.stringify(l))
    })
    seed()
  }

  put(record: MessageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO messages
           (id, workspace_id, source, account, folder, folder_kind, thread_id, message_id,
            date_ms, read, starred, route, json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           folder = excluded.folder, folder_kind = excluded.folder_kind,
           thread_id = excluded.thread_id, date_ms = excluded.date_ms,
           read = excluded.read, starred = excluded.starred,
           route = excluded.route, json = excluded.json`,
      )
      .run(
        record.id,
        record.workspace_id,
        record.source,
        record.account,
        record.folder,
        record.folder_kind,
        record.thread_id,
        record.message_id ?? null,
        Date.parse(record.date),
        record.flags.read ? 1 : 0,
        record.flags.starred ? 1 : 0,
        record.route,
        JSON.stringify(record),
      )
  }

  get(id: string): MessageRecord | undefined {
    const row = this.#db.prepare<[string], Row>('SELECT json FROM messages WHERE id = ?').get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as MessageRecord)
  }

  find(account: string, message_id: string): MessageRecord | undefined {
    const row = this.#db
      .prepare<[string, string], Row>(
        'SELECT json FROM messages WHERE account = ? AND message_id = ?',
      )
      .get(account, message_id)
    return row === undefined ? undefined : (JSON.parse(row.json) as MessageRecord)
  }

  /** 索引粗筛：只用得上索引的那几格；其余交给 `matchesQuery`。 */
  #coarse(query: MessageListQuery): MessageRecord[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (query.account !== undefined) {
      where.push('account = ?')
      args.push(query.account)
    }
    if (query.folder !== undefined) {
      where.push('folder = ?')
      args.push(query.folder)
    }
    if (query.folder_kind !== undefined) {
      where.push('folder_kind = ?')
      args.push(query.folder_kind)
    }
    if (query.route !== undefined) {
      where.push('route = ?')
      args.push(query.route)
    }
    if (query.unread === true) where.push('read = 0')
    if (query.starred === true) where.push('starred = 1')
    const sql = `SELECT json FROM messages${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ORDER BY date_ms DESC`
    return this.#db
      .prepare<(string | number)[], Row>(sql)
      .all(...args)
      .map((r) => JSON.parse(r.json) as MessageRecord)
  }

  list(query: MessageListQuery): MessageRecord[] {
    return this.#coarse(query)
      .filter((m) => matchesQuery(m, query))
      .sort(byNewest)
      .slice(0, query.limit ?? 200)
  }

  threads(query: MessageListQuery): MessageThreadSummary[] {
    const matched = this.#coarse(query).filter((m) => matchesQuery(m, query))
    const ids = [...new Set(matched.map((m) => m.thread_id))]
    if (ids.length === 0) return []
    // 一条会话的信可能散在几个文件夹里，所以聚合要按 thread_id 把全部取回来
    const placeholders = ids.map(() => '?').join(',')
    const full = this.#db
      .prepare<string[], Row>(`SELECT json FROM messages WHERE thread_id IN (${placeholders})`)
      .all(...ids)
      .map((r) => JSON.parse(r.json) as MessageRecord)
    return aggregateThreads(full).slice(0, query.limit ?? 100)
  }

  thread(thread_id: string): MessageRecord[] {
    return this.#db
      .prepare<[string], Row>('SELECT json FROM messages WHERE thread_id = ? ORDER BY date_ms')
      .all(thread_id)
      .map((r) => JSON.parse(r.json) as MessageRecord)
  }

  update(id: string, patch: MessagePatch): MessageRecord | undefined {
    const prior = this.get(id)
    if (prior === undefined) return undefined
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v
    const next = { ...prior, ...clean } as MessageRecord
    this.put(next)
    return next
  }

  folders(account?: string): MessageFolder[] {
    const rows = this.#db
      .prepare<
        string[],
        { account: string; folder: string; folder_kind: string; total: number; unread: number }
      >(
        `SELECT account, folder, folder_kind, COUNT(*) AS total,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread
           FROM messages${account === undefined ? '' : ' WHERE account = ?'}
          GROUP BY account, folder, folder_kind
          ORDER BY folder`,
      )
      .all(...(account === undefined ? [] : [account]))
    return rows.map((r) => ({
      path: r.folder,
      kind: r.folder_kind as MessageFolder['kind'],
      account: r.account,
      unread: r.unread,
      total: r.total,
    }))
  }

  accounts(): string[] {
    return this.#db
      .prepare<[], { account: string }>('SELECT DISTINCT account FROM messages ORDER BY account')
      .all()
      .map((r) => r.account)
  }

  labels(): MessageLabel[] {
    return this.#db
      .prepare<[], Row>('SELECT json FROM message_labels ORDER BY builtin DESC, id')
      .all()
      .map((r) => JSON.parse(r.json) as MessageLabel)
  }

  putLabel(label: MessageLabel): void {
    this.#db
      .prepare(
        `INSERT INTO message_labels (id, builtin, json) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      )
      .run(label.id, label.builtin ? 1 : 0, JSON.stringify(label))
  }

  deleteLabel(id: string): boolean {
    const row = this.#db
      .prepare<[string], { builtin: number }>('SELECT builtin FROM message_labels WHERE id = ?')
      .get(id)
    if (row === undefined || row.builtin === 1) return false
    const drop = this.#db.transaction((labelId: string) => {
      this.#db.prepare('DELETE FROM message_labels WHERE id = ?').run(labelId)
      for (const m of this.#db
        .prepare<[], Row>('SELECT json FROM messages')
        .all()
        .map((r) => JSON.parse(r.json) as MessageRecord)) {
        if (!m.labels.includes(labelId)) continue
        this.put({ ...m, labels: m.labels.filter((l) => l !== labelId) })
      }
    })
    drop(id)
    return true
  }

  senderRules(): SenderRule[] {
    return this.#db
      .prepare<[], Row>('SELECT json FROM message_sender_rules ORDER BY sender')
      .all()
      .map((r) => JSON.parse(r.json) as SenderRule)
  }

  putSenderRule(rule: SenderRule): void {
    this.#db
      .prepare(
        `INSERT INTO message_sender_rules (id, sender, json) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET sender = excluded.sender, json = excluded.json`,
      )
      .run(rule.id, rule.sender.toLowerCase(), JSON.stringify(rule))
  }

  deleteSenderRule(id: string): boolean {
    return this.#db.prepare('DELETE FROM message_sender_rules WHERE id = ?').run(id).changes > 0
  }

  drafts(): MessageDraft[] {
    return this.#db
      .prepare<[], Row>('SELECT json FROM message_drafts ORDER BY updated_at_ms DESC')
      .all()
      .map((r) => JSON.parse(r.json) as MessageDraft)
  }

  getDraft(id: string): MessageDraft | undefined {
    const row = this.#db
      .prepare<[string], Row>('SELECT json FROM message_drafts WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as MessageDraft)
  }

  putDraft(draft: MessageDraft): void {
    this.#db
      .prepare(
        `INSERT INTO message_drafts (id, workspace_id, updated_at_ms, json) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at_ms = excluded.updated_at_ms, json = excluded.json`,
      )
      .run(draft.id, draft.workspace_id, Date.parse(draft.updated_at), JSON.stringify(draft))
  }

  deleteDraft(id: string): boolean {
    return this.#db.prepare('DELETE FROM message_drafts WHERE id = ?').run(id).changes > 0
  }

  trustedSenders(): string[] {
    return this.#db
      .prepare<[], { email: string }>('SELECT email FROM message_trusted_senders ORDER BY email')
      .all()
      .map((r) => r.email)
  }

  trustSender(email: string): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO message_trusted_senders (email) VALUES (?)')
      .run(email.trim().toLowerCase())
  }

  close(): void {
    if (this.#closed || !this.#owned) return
    this.#closed = true
    this.#db.close()
  }
}
