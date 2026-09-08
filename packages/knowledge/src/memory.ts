import type {
  Clock,
  MemoryFactRecord,
  MemoryStore,
  ObjectRef,
  WorkspaceId,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import type { Database } from 'better-sqlite3'
import { detectSecret, jaccard } from './text.js'

/** 19 §1.2 / Commerce Agents A7 纪律。 */
export const MEMORY_KEY_MAX = 64
export const MEMORY_VALUE_MAX = 200
/** 每次 write 最多写 3 条，多余的拒。 */
export const MEMORY_WRITE_CAP = 3
/** recall 默认上限；constraint 不受它约束，其余按新近度填到 cap。 */
export const MEMORY_RECALL_CAP = 8
/** 与同 subject 已有条目的 Jaccard 相似度超过它即视为重复。 */
export const MEMORY_JACCARD_MAX = 0.8

const CATEGORIES = new Set(['constraint', 'preference', 'context'])
const RUN_HASH = /^[0-9a-f]{12}$/

interface MemoryRow {
  seq: number
  workspace_id: string
  subject_type: string
  subject_id: string
  key: string
  value: string
  category: string
  source_run_hash: string
  expires_at: string
  written_at: string
  state: string
}

const rowToFact = (r: MemoryRow): MemoryFactRecord => ({
  key: r.key,
  value: r.value,
  category: r.category as MemoryFactRecord['category'],
  subject: { type: r.subject_type as ObjectRef['type'], id: r.subject_id },
  source_run_hash: r.source_run_hash,
  expires_at: r.expires_at,
  workspace_id: r.workspace_id,
})

export interface MemoryStoreOptions {
  clock: Clock
  /** 单工作区本地档的缺省；契约的 recall / forget 不带 workspace_id（见报告 §4）。 */
  workspace_id?: WorkspaceId
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database
  private readonly clock: Clock
  private readonly defaultWorkspace: WorkspaceId | undefined

  constructor(db: Database, opts: MemoryStoreOptions) {
    this.db = db
    this.clock = opts.clock
    this.defaultWorkspace = opts.workspace_id
  }

  private liveRows(subject: ObjectRef, workspace_id: string | undefined, now: string): MemoryRow[] {
    const where = ['subject_type = ?', 'subject_id = ?', "state = 'live'", 'expires_at > ?']
    const params: string[] = [subject.type, subject.id, now]
    if (workspace_id !== undefined) {
      where.push('workspace_id = ?')
      params.push(workspace_id)
    }
    return this.db
      .prepare(
        `SELECT * FROM memory_facts WHERE ${where.join(' AND ')} ORDER BY written_at DESC, seq DESC`,
      )
      .all(...params) as MemoryRow[]
  }

  /**
   * 写过滤（19 §1.2）：长度上限、秘密形态（邮箱 / IBAN / 卡号 / ≥9 位连续数字）、
   * 每次 ≤3 条、Jaccard 去重。被拒的条目连原因一起回给调用方，不静默丢弃。
   */
  async write(facts: MemoryFactRecord[]): Promise<{
    accepted: MemoryFactRecord[]
    rejected: { fact: MemoryFactRecord; reason: string }[]
  }> {
    const now = this.clock.now()
    const accepted: MemoryFactRecord[] = []
    const rejected: { fact: MemoryFactRecord; reason: string }[] = []
    const reject = (fact: MemoryFactRecord, reason: string) => {
      rejected.push({ fact, reason })
    }

    for (const [i, fact] of facts.entries()) {
      if (i >= MEMORY_WRITE_CAP) {
        reject(fact, `per_write_cap_exceeded: 每次 write 最多 ${MEMORY_WRITE_CAP} 条`)
        continue
      }
      const key = EXTERNAL_FENCE.sanitizeText(fact.key, MEMORY_KEY_MAX + 1)
      const value = EXTERNAL_FENCE.sanitizeText(fact.value, MEMORY_VALUE_MAX + 1)
      if ([...key].length === 0) {
        reject(fact, 'key_empty: key 不能为空')
        continue
      }
      if ([...key].length > MEMORY_KEY_MAX) {
        reject(fact, `key_too_long: key 上限 ${MEMORY_KEY_MAX} 字`)
        continue
      }
      if ([...value].length > MEMORY_VALUE_MAX) {
        reject(fact, `value_too_long: value 上限 ${MEMORY_VALUE_MAX} 字`)
        continue
      }
      if (!CATEGORIES.has(fact.category)) {
        reject(fact, `invalid_category: ${fact.category}`)
        continue
      }
      if (!RUN_HASH.test(fact.source_run_hash)) {
        reject(fact, 'invalid_source_run_hash: 需要 SHA-256 前 12 位小写十六进制')
        continue
      }
      const secret = detectSecret(key) ?? detectSecret(value)
      if (secret !== undefined) {
        reject(fact, `write_filter:${secret}: 运行记忆不收秘密形态的文本`)
        continue
      }
      if (Number.isNaN(Date.parse(fact.expires_at))) {
        reject(fact, 'invalid_expires_at: 需要 ISO-8601 时间')
        continue
      }
      if (Date.parse(fact.expires_at) <= Date.parse(now)) {
        reject(fact, 'already_expired: expires_at 不能是过去')
        continue
      }

      const ws = fact.workspace_id === '' ? undefined : fact.workspace_id
      const existing = this.liveRows(fact.subject, ws, now)
      const probe = `${key} ${value}`
      const dup =
        existing.some(
          (r) => r.key !== key && jaccard(probe, `${r.key} ${r.value}`) > MEMORY_JACCARD_MAX,
        ) ||
        existing.some((r) => r.key === key && r.value === value) ||
        accepted.some(
          (a) =>
            a.subject.type === fact.subject.type &&
            a.subject.id === fact.subject.id &&
            jaccard(probe, `${a.key} ${a.value}`) > MEMORY_JACCARD_MAX,
        )
      if (dup) {
        reject(fact, `duplicate: 与同 subject 已有条目相似度 > ${MEMORY_JACCARD_MAX}`)
        continue
      }

      // 同 key 视为更新：旧行标 superseded，不删（可撤销、可审计）
      this.db
        .prepare(
          "UPDATE memory_facts SET state = 'superseded' WHERE workspace_id = ? AND subject_type = ?" +
            " AND subject_id = ? AND key = ? AND state = 'live'",
        )
        .run(fact.workspace_id, fact.subject.type, fact.subject.id, key)
      this.db
        .prepare(
          'INSERT INTO memory_facts (workspace_id, subject_type, subject_id, key, value, category,' +
            " source_run_hash, expires_at, written_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')",
        )
        .run(
          fact.workspace_id,
          fact.subject.type,
          fact.subject.id,
          key,
          value,
          fact.category,
          fact.source_run_hash,
          fact.expires_at,
          now,
        )
      accepted.push({ ...fact, key, value })
    }
    return { accepted, rejected }
  }

  /** constraint 全量注入，其余按新近度补到 cap；过期与已撤销的不返回。 */
  async recall(
    subject: ObjectRef,
    opts?: { cap?: number; workspace_id?: WorkspaceId },
  ): Promise<MemoryFactRecord[]> {
    const now = this.clock.now()
    const cap = opts?.cap ?? MEMORY_RECALL_CAP
    const rows = this.liveRows(subject, opts?.workspace_id ?? this.defaultWorkspace, now)
    const constraints = rows.filter((r) => r.category === 'constraint')
    const others = rows.filter((r) => r.category !== 'constraint')
    const room = Math.max(0, cap - constraints.length)
    return [...constraints, ...others.slice(0, room)].map(rowToFact)
  }

  /**
   * 覆写式撤销：既有行标 forgotten，并落一条 `[forgotten]` 墓碑行（如实说明"被忘了"），
   * 之后 recall 不再返回该 key。
   */
  async forget(
    subject: ObjectRef,
    key: string,
    opts?: { workspace_id?: WorkspaceId },
  ): Promise<void> {
    const now = this.clock.now()
    const ws = opts?.workspace_id ?? this.defaultWorkspace
    const where = ['subject_type = ?', 'subject_id = ?', 'key = ?', "state = 'live'"]
    const params: string[] = [subject.type, subject.id, key]
    if (ws !== undefined) {
      where.push('workspace_id = ?')
      params.push(ws)
    }
    const victims = this.db
      .prepare(`SELECT * FROM memory_facts WHERE ${where.join(' AND ')}`)
      .all(...params) as MemoryRow[]
    this.db
      .prepare(`UPDATE memory_facts SET state = 'forgotten' WHERE ${where.join(' AND ')}`)
      .run(...params)
    const first = victims[0]
    this.db
      .prepare(
        'INSERT INTO memory_facts (workspace_id, subject_type, subject_id, key, value, category,' +
          " source_run_hash, expires_at, written_at, state) VALUES (?, ?, ?, ?, '[forgotten]', 'context'," +
          " ?, ?, ?, 'forgotten')",
      )
      .run(
        first?.workspace_id ?? ws ?? '',
        subject.type,
        subject.id,
        key,
        first?.source_run_hash ?? '000000000000',
        now,
        now,
      )
  }

  /** 撤销记录（给"如实说明"用）：哪些 key 在什么时候被忘掉了。 */
  async revocations(
    subject: ObjectRef,
    opts?: { workspace_id?: WorkspaceId },
  ): Promise<{ key: string; at: string }[]> {
    const ws = opts?.workspace_id ?? this.defaultWorkspace
    const where = [
      'subject_type = ?',
      'subject_id = ?',
      "state = 'forgotten'",
      "value = '[forgotten]'",
    ]
    const params: string[] = [subject.type, subject.id]
    if (ws !== undefined) {
      where.push('workspace_id = ?')
      params.push(ws)
    }
    const rows = this.db
      .prepare(`SELECT key, written_at FROM memory_facts WHERE ${where.join(' AND ')} ORDER BY seq`)
      .all(...params) as { key: string; written_at: string }[]
    return rows.map((r) => ({ key: r.key, at: r.written_at }))
  }
}
