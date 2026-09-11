import type { Clock, KnowledgeSource, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { KnowledgeEmitter } from './events.js'
import {
  type Chunk,
  type DocumentParser,
  type IngestSource,
  ingestDocument,
  ingestMarkdown,
} from './ingest.js'
import { SqliteIntakeStore } from './intake.js'
import { SqliteMemoryStore } from './memory.js'
import { SqliteRetrieval } from './retrieval.js'
import { migrate } from './schema.js'
import { type Embedder, SqliteKnowledgeStore } from './store.js'

export * from './errors.js'
export * from './events.js'
export * from './ingest.js'
export * from './intake.js'
export * from './markdown.js'
export * from './memory.js'
export * from './retrieval.js'
export * from './rows.js'
export * from './schema.js'
export * from './state-words.js'
export * from './store.js'
export * from './text.js'
export * from './visibility.js'

/** 系统时钟：本包唯一一处 `new Date()`，其余全部经注入的 Clock（25 §4）。 */
export const systemClock: Clock = { now: () => new Date().toISOString() }

export interface CreateKnowledgeOptions {
  /** SQLite 文件路径；缺省 `:memory:`（测试与一次性任务用）。 */
  dbPath?: string
  clock?: Clock
  /** 传了就做 BM25 + 向量的 RRF 融合；不传只有 BM25。embedding 走模型网关（13 §2）。 */
  embed?: Embedder
  /** anydoc / html 清洗 / 转写的挂点（13 §3）；本包不安装 anydoc。 */
  parser?: DocumentParser
  /** 19 §6 事件（`KnownEventType` 里 `knowledge.*` 的那几条）。 */
  emit?: KnowledgeEmitter
  /** 单工作区本地档的缺省 workspace（记忆的 recall / forget 契约里没带）。 */
  workspace_id?: WorkspaceId
}

export interface Knowledge {
  db: Db
  store: SqliteKnowledgeStore
  retrieval: SqliteRetrieval
  memory: SqliteMemoryStore
  /** 19 §1.3 导入源与 §4 缺口队列（WP35 补的两张表）。 */
  intake: SqliteIntakeStore
  ingestMarkdown(text: string, source: IngestSource, opts?: { maxChars?: number }): Chunk[]
  ingestDocument(
    input: { ref: string; parser: KnowledgeSource['parser']; data: string | Uint8Array },
    source: IngestSource,
    opts?: { maxChars?: number },
  ): Promise<Chunk[]>
  close(): void
}

export function createKnowledge(opts: CreateKnowledgeOptions = {}): Knowledge {
  const clock = opts.clock ?? systemClock
  const db = new Database(opts.dbPath ?? ':memory:')
  migrate(db)

  const shared = {
    clock,
    ...(opts.embed === undefined ? {} : { embed: opts.embed }),
    ...(opts.emit === undefined ? {} : { emit: opts.emit }),
  }
  const store = new SqliteKnowledgeStore(db, shared)
  const retrieval = new SqliteRetrieval(db, shared)
  const intake = new SqliteIntakeStore(db, shared)
  const memory = new SqliteMemoryStore(db, {
    clock,
    ...(opts.workspace_id === undefined ? {} : { workspace_id: opts.workspace_id }),
  })

  return {
    db,
    store,
    retrieval,
    intake,
    memory,
    ingestMarkdown,
    ingestDocument: (input, source, chunkOpts) =>
      ingestDocument(input, source, opts.parser, chunkOpts),
    close: () => db.close(),
  }
}
