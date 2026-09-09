/**
 * 19 §1.3 导入源 与 §4 缺口队列的**落库**（docs/38 §1 列的那个缺口）。
 *
 * WP33 在网关上留了四个可选端口（`sources` / `addSource` / `gaps` / `openGap` / `answerGap`），
 * 没有存的地方，那几条路由一直回 501。这里补上两张表。
 *
 * 两条纪律照旧：
 * - **写只经审批项**：`answerGap` 记的是「谁答的、答了什么」，答案变不变成知识由
 *   `approval_item_id` 指向的那张 `knowledge_update` 卡决定（宿主建卡，本包只存 id）；
 * - **外部文本先过围栏**：问题、答案、源的 ref 都是人 / 上游给的，落库前过 `EXTERNAL_FENCE`。
 *
 * 存储只有 SQLite 一档：`createKnowledge` 不给 `dbPath` 就是 `:memory:`，
 * 「内存档」与「文件档」跑的是同一份实现，一致性用例两档各跑一遍。
 */
import { createHash } from 'node:crypto'
import type {
  Clock,
  DataDomain,
  Iso8601,
  KnowledgeGap,
  KnowledgeGapAnswer,
  KnowledgeGapInput,
  KnowledgeGapStatus,
  KnowledgeSource,
  KnowledgeSourceInput,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import type { Database } from 'better-sqlite3'
import { invalidInput, notFound } from './errors.js'
import type { KnowledgeEmitter, KnowledgeEventType } from './events.js'
import { nextSeq } from './schema.js'

/** 问题 / 答案的长度上限：缺口是一句话，不是一篇文档。 */
export const MAX_QUESTION_CHARS = 500
export const MAX_ANSWER_CHARS = 2000
/** 源的 ref（路径 / url / 线程 id）上限。 */
export const MAX_REF_CHARS = 2000

const SOURCE_KINDS = new Set<KnowledgeSource['kind']>([
  'upload',
  'feishu_doc',
  'shopify_page',
  'website',
  'email_thread',
  'meeting',
])
const PARSERS = new Set<KnowledgeSource['parser']>(['anydoc', 'html', 'transcript'])
const GAP_STATUSES = new Set<KnowledgeGapStatus>(['open', 'answered', 'dismissed'])

interface SourceRow {
  id: string
  workspace_id: string
  kind: string
  ref: string
  parser: string
  acl_inherit: number
  chunks: number
  last_synced_at: string | null
  created_at: string
}

interface GapRow {
  id: string
  workspace_id: string
  question: string
  subject_type: string
  subject_id: string | null
  subject_key: string
  domain: string
  status: string
  asked_by_kind: string
  asked_by_id: string
  run_id: string | null
  answer: string | null
  answered_by: string | null
  answered_at: string | null
  approval_item_id: string | null
  created_at: string
}

function rowToSource(r: SourceRow): KnowledgeSource {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    kind: r.kind as KnowledgeSource['kind'],
    ref: r.ref,
    parser: r.parser as KnowledgeSource['parser'],
    acl_inherit: r.acl_inherit === 1,
    chunks: r.chunks,
    ...(r.last_synced_at === null ? {} : { last_synced_at: r.last_synced_at }),
  }
}

function rowToGap(r: GapRow): KnowledgeGap {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    question: r.question,
    subject: {
      type: r.subject_type,
      key: r.subject_key,
      ...(r.subject_id === null ? {} : { id: r.subject_id }),
    },
    domain: r.domain as DataDomain | 'company',
    status: r.status as KnowledgeGapStatus,
    asked_by: { kind: r.asked_by_kind as 'agent' | 'person', id: r.asked_by_id },
    created_at: r.created_at,
    ...(r.run_id === null ? {} : { run_id: r.run_id }),
    ...(r.answer === null ? {} : { answer: r.answer }),
    ...(r.answered_by === null ? {} : { answered_by: r.answered_by }),
    ...(r.answered_at === null ? {} : { answered_at: r.answered_at }),
    ...(r.approval_item_id === null ? {} : { approval_item_id: r.approval_item_id }),
  }
}

export interface IntakeStoreOptions {
  clock: Clock
  emit?: KnowledgeEmitter
}

/** `addSource` 的入参：契约那一份 + 落在哪个工作区。 */
export type AddSourceInput = KnowledgeSourceInput & { workspace_id: WorkspaceId }

/** `openGap` 的入参：契约那一份 + 工作区 + 谁问的。 */
export type OpenGapInput = KnowledgeGapInput & {
  workspace_id: WorkspaceId
  asked_by: { kind: 'agent' | 'person'; id: string }
}

export interface AnswerGapInput {
  answer: string
  by: PersonId
  /** 19 §4：答案不直接生效，宿主先建一张 `knowledge_update` 卡，这里只记它的 id。 */
  approval_item_id?: string
  at?: Iso8601
}

export class SqliteIntakeStore {
  private readonly db: Database
  private readonly clock: Clock
  private readonly emit: KnowledgeEmitter | undefined

  constructor(db: Database, opts: IntakeStoreOptions) {
    this.db = db
    this.clock = opts.clock
    this.emit = opts.emit
  }

  private fire(
    type: KnowledgeEventType,
    workspace_id: WorkspaceId,
    payload: Record<string, unknown>,
  ): void {
    this.emit?.({ type, workspace_id, at: this.clock.now(), payload })
  }

  private id(prefix: string, seqName: string, parts: string[]): string {
    const seq = nextSeq(this.db, seqName)
    return `${prefix}_${createHash('sha256')
      .update([...parts, String(seq)].join(' '))
      .digest('hex')
      .slice(0, 24)}`
  }

  // ── 19 §1.3 导入源 ──────────────────────────────────────────────────

  /**
   * 登记一个导入源。**同工作区同 (kind, ref) 是同一个源**——重复登记回原来那一条，
   * 不造第二行（否则「同一篇飞书文档」会在清单里出现两次）。
   */
  addSource(input: AddSourceInput): KnowledgeSource {
    if (input.workspace_id === '') throw invalidInput('缺少 workspace_id')
    if (!SOURCE_KINDS.has(input.kind)) throw invalidInput(`未知的源类型：${String(input.kind)}`)
    if (!PARSERS.has(input.parser)) throw invalidInput(`未知的解析器：${String(input.parser)}`)
    const ref = EXTERNAL_FENCE.sanitizeText(input.ref, MAX_REF_CHARS).trim()
    if (ref === '') throw invalidInput('源的 ref 不能为空')

    const existing = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE workspace_id = ? AND kind = ? AND ref = ?')
      .get(input.workspace_id, input.kind, ref) as SourceRow | undefined
    if (existing !== undefined) return rowToSource(existing)

    const now = this.clock.now()
    const row: SourceRow = {
      id: this.id('src', 'knowledge_source_seq', [input.workspace_id, input.kind, ref, now]),
      workspace_id: input.workspace_id,
      kind: input.kind,
      ref,
      parser: input.parser,
      // 19 §1.3：飞书文档一类的源默认继承上游 ACL
      acl_inherit: (input.acl_inherit ?? input.kind === 'feishu_doc') ? 1 : 0,
      chunks: 0,
      last_synced_at: null,
      created_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO knowledge_sources
           (id, workspace_id, kind, ref, parser, acl_inherit, chunks, last_synced_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspace_id,
        row.kind,
        row.ref,
        row.parser,
        row.acl_inherit,
        row.chunks,
        row.last_synced_at,
        row.created_at,
      )
    return rowToSource(row)
  }

  sources(workspace_id: WorkspaceId): KnowledgeSource[] {
    return (
      this.db
        .prepare(
          // rowid = 插入顺序：固定时钟下 created_at 会相同，按 id（哈希）排就成了随机序
          'SELECT * FROM knowledge_sources WHERE workspace_id = ? ORDER BY rowid',
        )
        .all(workspace_id) as SourceRow[]
    ).map(rowToSource)
  }

  getSource(id: string): KnowledgeSource | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as
      | SourceRow
      | undefined
    return row === undefined ? undefined : rowToSource(row)
  }

  /** 解析完之后回填「切了几块、什么时候同步的」。 */
  markSynced(id: string, chunks: number): KnowledgeSource {
    if (!Number.isInteger(chunks) || chunks < 0) throw invalidInput('chunks 必须是非负整数')
    const info = this.db
      .prepare('UPDATE knowledge_sources SET chunks = ?, last_synced_at = ? WHERE id = ?')
      .run(chunks, this.clock.now(), id)
    if (info.changes === 0) throw notFound(`导入源不存在：${id}`, { id })
    return this.getSource(id) as KnowledgeSource
  }

  // ── 19 §4 缺口队列 ─────────────────────────────────────────────────

  /**
   * 开一个缺口。**同工作区、同 subject.key、同问题、还开着 → 是同一条**：
   * 一句「德国退货运费谁出」被十次运行各问一遍，队列里只该有一条。
   */
  openGap(input: OpenGapInput): KnowledgeGap {
    if (input.workspace_id === '') throw invalidInput('缺少 workspace_id')
    const question = EXTERNAL_FENCE.sanitizeText(input.question, MAX_QUESTION_CHARS).trim()
    if (question === '') throw invalidInput('缺口的问题不能为空')
    const key = EXTERNAL_FENCE.sanitizeText(input.subject.key, 200).trim()
    if (key === '') throw invalidInput('缺口要说清「关于什么」（subject.key）')

    const open = this.db
      .prepare(
        `SELECT * FROM knowledge_gaps
          WHERE workspace_id = ? AND subject_key = ? AND question = ? AND status = 'open'`,
      )
      .get(input.workspace_id, key, question) as GapRow | undefined
    if (open !== undefined) return rowToGap(open)

    const now = this.clock.now()
    const row: GapRow = {
      id: this.id('gap', 'knowledge_gap_seq', [input.workspace_id, key, question, now]),
      workspace_id: input.workspace_id,
      question,
      subject_type: EXTERNAL_FENCE.sanitizeText(input.subject.type, 100),
      subject_id:
        input.subject.id === undefined ? null : EXTERNAL_FENCE.sanitizeText(input.subject.id, 200),
      subject_key: key,
      domain: input.domain ?? 'company',
      status: 'open',
      asked_by_kind: input.asked_by.kind,
      asked_by_id: input.asked_by.id,
      run_id: input.run_id ?? null,
      answer: null,
      answered_by: null,
      answered_at: null,
      approval_item_id: null,
      created_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO knowledge_gaps
           (id, workspace_id, question, subject_type, subject_id, subject_key, domain, status,
            asked_by_kind, asked_by_id, run_id, answer, answered_by, answered_at,
            approval_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspace_id,
        row.question,
        row.subject_type,
        row.subject_id,
        row.subject_key,
        row.domain,
        row.status,
        row.asked_by_kind,
        row.asked_by_id,
        row.run_id,
        row.answer,
        row.answered_by,
        row.answered_at,
        row.approval_item_id,
        row.created_at,
      )
    // 事件只带「关于什么」，问题正文不进日志
    this.fire('knowledge.gap.opened', row.workspace_id, {
      gap_id: row.id,
      subject_key: row.subject_key,
      domain: row.domain,
      asked_by: row.asked_by_kind,
      ...(row.run_id === null ? {} : { run_id: row.run_id }),
    })
    return rowToGap(row)
  }

  gaps(workspace_id: WorkspaceId, filter: { status?: KnowledgeGapStatus } = {}): KnowledgeGap[] {
    if (filter.status !== undefined && !GAP_STATUSES.has(filter.status))
      throw invalidInput(`status 不合法：${String(filter.status)}`)
    const rows =
      filter.status === undefined
        ? (this.db
            .prepare('SELECT * FROM knowledge_gaps WHERE workspace_id = ? ORDER BY rowid')
            .all(workspace_id) as GapRow[])
        : (this.db
            .prepare(
              'SELECT * FROM knowledge_gaps WHERE workspace_id = ? AND status = ? ORDER BY rowid',
            )
            .all(workspace_id, filter.status) as GapRow[])
    return rows.map(rowToGap)
  }

  getGap(id: string): KnowledgeGap | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_gaps WHERE id = ?').get(id) as
      | GapRow
      | undefined
    return row === undefined ? undefined : rowToGap(row)
  }

  requireGap(id: string): KnowledgeGap {
    const gap = this.getGap(id)
    if (gap === undefined) throw notFound(`缺口不存在：${id}`, { id })
    return gap
  }

  /**
   * 有人答了。**答完就不再是 open**（下一次同问题会开一条新的），
   * 但答案本身不写进知识库——那是 `approval_item_id` 指向的那张卡的事。
   */
  answerGap(id: string, input: AnswerGapInput): KnowledgeGapAnswer {
    const gap = this.requireGap(id)
    if (gap.status !== 'open') throw invalidInput(`缺口已经是 ${gap.status}，不能再答一次`)
    const answer = EXTERNAL_FENCE.sanitizeText(input.answer, MAX_ANSWER_CHARS).trim()
    if (answer === '') throw invalidInput('答案不能为空')
    const at = input.at ?? this.clock.now()
    this.db
      .prepare(
        `UPDATE knowledge_gaps
            SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?,
                approval_item_id = ?
          WHERE id = ?`,
      )
      .run(answer, input.by, at, input.approval_item_id ?? null, id)
    const next = this.requireGap(id)
    this.fire('knowledge.gap.answered', next.workspace_id, {
      gap_id: next.id,
      subject_key: next.subject.key,
      answered_by: input.by,
      ...(next.approval_item_id === undefined ? {} : { approval_item_id: next.approval_item_id }),
    })
    return {
      gap: next,
      ...(next.approval_item_id === undefined ? {} : { approval_item_id: next.approval_item_id }),
    }
  }

  /** 问错了 / 不用答了：留痕不删（19 §4 的队列要能回看）。 */
  dismissGap(id: string): KnowledgeGap {
    const gap = this.requireGap(id)
    if (gap.status !== 'open') throw invalidInput(`缺口已经是 ${gap.status}，不能再关一次`)
    this.db.prepare("UPDATE knowledge_gaps SET status = 'dismissed' WHERE id = ?").run(id)
    return this.requireGap(id)
  }
}
