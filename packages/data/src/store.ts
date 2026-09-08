import type {
  Clock,
  DataRecord,
  DataStore,
  Operation,
  RangeRef,
  Sensitivity,
} from '@agentsws/contracts'
import { SENSITIVITY_ORDER } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import {
  accessWhere,
  admittingGrants,
  type DataActor,
  fieldCeiling,
  READ_OPS,
  WRITE_OPS,
} from './authz.js'
import { CasbinGate } from './casbin-gate.js'
import {
  type CollectionDef,
  ENVELOPE_KEYS,
  fieldSpec,
  isLegalFieldName,
  piiFields,
} from './collection.js'
import { decryptValue, ERASED, encryptValue, isEncryptedField } from './crypto.js'
import { conflict, forbidden, invalidInput, notFound } from './errors.js'
import { SubjectKeyring } from './keyring.js'
import { sensitivityRank } from './sensitivity.js'
import { EVENT_SCHEMA_VERSION, type PrivacyErasedEvent } from './tombstone.js'

interface Row {
  id: string
  schema_version: number
  workspace_id: string
  owners: string
  scope: string
  sensitivity: string
  source: string | null
  created_at: string
  updated_at: string
  version: string
  body: string
}

interface TombstoneRow {
  subject_id: string
  collection: string
  record_id: string
  workspace_id: string
  at: string
  event: string
}

/** 信封里可直接当过滤条件用的列。owners / scope / source 是 JSON，不开放为等值过滤。 */
const FILTERABLE_ENVELOPE: ReadonlySet<string> = new Set([
  'id',
  'schema_version',
  'workspace_id',
  'sensitivity',
  'version',
  'created_at',
  'updated_at',
])

export interface DataStoreOptions {
  /** SQLite 文件路径；测试用 ':memory:'。 */
  dbPath: string
  /** 25 §4：所有 now() 经注入的时钟。 */
  clock: Clock
  collections?: readonly CollectionDef[]
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export class SqliteDataStore implements DataStore {
  readonly #db: Db
  readonly #clock: Clock
  readonly #collections = new Map<string, CollectionDef>()
  readonly #keys: SubjectKeyring
  readonly #gate = new CasbinGate()

  constructor(opts: DataStoreOptions) {
    this.#db = new Database(opts.dbPath)
    this.#db.pragma('journal_mode = WAL')
    this.#clock = opts.clock
    this.#keys = new SubjectKeyring(this.#db, opts.clock)
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS _tombstones (
        subject_id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        record_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event TEXT NOT NULL
      )`,
    )
    for (const def of opts.collections ?? []) this.register(def)
  }

  /** 每个 collection 一张表（21 §2 信封列 + body JSON）。 */
  register(def: CollectionDef): this {
    const existing = this.#collections.get(def.name)
    if (existing !== undefined && existing !== def)
      throw invalidInput(`collection already registered: ${def.name}`)
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS "${def.name}" (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        owners TEXT NOT NULL,
        scope TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "${def.name}_ws" ON "${def.name}" (workspace_id);`,
    )
    this.#collections.set(def.name, def)
    return this
  }

  collections(): CollectionDef[] {
    return [...this.#collections.values()]
  }

  close(): void {
    this.#db.close()
  }

  #def(collection: string): CollectionDef {
    const def = this.#collections.get(collection)
    if (def === undefined) throw invalidInput(`unknown collection: ${collection}`)
    return def
  }

  #subject(collection: string, id: string): string {
    return `${collection}:${id}`
  }

  // ── 读 ─────────────────────────────────────────────────────────────────

  async get<T>(
    collection: string,
    id: string,
    actor: DataActor,
  ): Promise<DataRecord<T> | undefined> {
    const def = this.#def(collection)
    const where = accessWhere(def.name, actor, def.domain, READ_OPS)
    // 没有任何可能命中的 grant（含空 ranges 的 assigned）→ 空，不抛错
    if (where === undefined) return undefined
    if (!(await this.#gate.allows(actor, def.domain, READ_OPS))) return undefined
    const row = this.#db
      .prepare<unknown[], Row>(
        `SELECT * FROM "${def.name}" WHERE workspace_id = ? AND id = ? AND ${where.sql}`,
      )
      .get(actor.workspace_id, id, ...where.params)
    if (row === undefined) return undefined
    return this.#hydrate<T>(def, row, actor)
  }

  async query<T>(
    collection: string,
    filter: Record<string, unknown>,
    actor: DataActor,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: DataRecord<T>[]; cursor?: string }> {
    const def = this.#def(collection)
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const where = accessWhere(def.name, actor, def.domain, READ_OPS)
    if (where === undefined) return { items: [] }
    if (!(await this.#gate.allows(actor, def.domain, READ_OPS))) return { items: [] }

    const clauses = [`"${def.name}".workspace_id = ?`, where.sql]
    const params: unknown[] = [actor.workspace_id, ...where.params]

    // 过滤条件也受字段分级约束：不能拿看不到的字段当探针
    const probeCeiling = maxGrantSensitivity(actor, def, READ_OPS)
    for (const [key, value] of Object.entries(filter)) {
      if (FILTERABLE_ENVELOPE.has(key)) {
        clauses.push(`"${def.name}"."${key}" = ?`)
        params.push(value as string | number)
        continue
      }
      if (ENVELOPE_KEYS.has(key)) throw invalidInput(`envelope field is not filterable: ${key}`)
      if (!isLegalFieldName(key)) throw invalidInput(`illegal field name: ${key}`)
      const spec = fieldSpec(def, key)
      if (spec.pii === true)
        throw invalidInput(`personal-data field is encrypted and not filterable: ${key}`)
      if (
        probeCeiling === undefined ||
        sensitivityRank(spec.sensitivity) > sensitivityRank(probeCeiling)
      )
        throw forbidden(`field above max_sensitivity: ${def.name}.${key}`)
      clauses.push(`json_extract("${def.name}".body, '$.${key}') = ?`)
      params.push(value as string | number)
    }
    if (opts?.cursor !== undefined) {
      clauses.push(`"${def.name}".id > ?`)
      params.push(opts.cursor)
    }

    const rows = this.#db
      .prepare<unknown[], Row>(
        `SELECT * FROM "${def.name}" WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`,
      )
      .all(...params, limit)
    const items: DataRecord<T>[] = []
    for (const row of rows) {
      const rec = this.#hydrate<T>(def, row, actor)
      if (rec !== undefined) items.push(rec)
    }
    const last = rows[rows.length - 1]
    return rows.length === limit && last !== undefined ? { items, cursor: last.id } : { items }
  }

  /** SQL 之后、返回之前：解密 PII，删掉高于 actor 密级的字段（21 §2 字段分级）。 */
  #hydrate<T>(def: CollectionDef, row: Row, actor: DataActor): DataRecord<T> | undefined {
    const owners = JSON.parse(row.owners) as string[]
    const scope = JSON.parse(row.scope) as RangeRef[]
    const sensitivity = row.sensitivity as Sensitivity
    const ceiling = fieldCeiling(actor, def.domain, READ_OPS, { owners, scope, sensitivity })
    if (ceiling === undefined) return undefined
    const ceilingRank = sensitivityRank(ceiling)

    const stored = JSON.parse(row.body) as Record<string, unknown>
    const key = this.#keys.get(this.#subject(def.name, row.id))
    const body: Record<string, unknown> = {}
    for (const [field, raw] of Object.entries(stored)) {
      if (sensitivityRank(fieldSpec(def, field).sensitivity) > ceilingRank) continue
      if (isEncryptedField(raw)) {
        body[field] = key === undefined ? ERASED : decryptValue(key, raw)
        continue
      }
      body[field] = raw
    }
    const envelope = {
      id: row.id,
      schema_version: row.schema_version,
      workspace_id: row.workspace_id,
      owners,
      scope,
      sensitivity,
      ...(row.source === null ? {} : { source: JSON.parse(row.source) as object }),
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
    }
    return { ...envelope, ...body } as DataRecord<T>
  }

  // ── 写 ─────────────────────────────────────────────────────────────────

  async put<T>(
    collection: string,
    rec: Omit<DataRecord<T>, 'created_at' | 'updated_at' | 'version'> & { version?: string },
    actor: DataActor,
  ): Promise<DataRecord<T>> {
    const def = this.#def(collection)
    const input = rec as unknown as Record<string, unknown>

    const id = input.id
    if (typeof id !== 'string' || id.length === 0) throw invalidInput('id is required')
    // 21 §6 用例 3：无 workspace_id 的记录写入被拒
    const workspaceId = input.workspace_id
    if (typeof workspaceId !== 'string' || workspaceId.length === 0)
      throw invalidInput('workspace_id is required')
    if (workspaceId !== actor.workspace_id)
      throw forbidden(`workspace mismatch: ${workspaceId} != ${actor.workspace_id}`)

    // 21 §6 用例 2：写入旧版 schema 的记录被拒
    const schemaVersion = input.schema_version
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion))
      throw invalidInput('schema_version must be an integer')
    if (schemaVersion < def.schema_version)
      throw invalidInput(
        `stale schema_version ${schemaVersion} < ${def.schema_version} for ${def.name}`,
      )
    if (schemaVersion > def.schema_version)
      throw invalidInput(
        `unknown schema_version ${schemaVersion} > ${def.schema_version} for ${def.name}`,
      )

    const owners = asStringArray(input.owners, 'owners')
    const scope = asRangeArray(input.scope)
    const sensitivity = input.sensitivity
    if (typeof sensitivity !== 'string' || !SENSITIVITY_ORDER.includes(sensitivity as Sensitivity))
      throw invalidInput(`invalid sensitivity: ${String(sensitivity)}`)
    const facts = { owners, scope, sensitivity: sensitivity as Sensitivity }

    // 完整元组判权（主门）+ Casbin（二道门）
    const grants = admittingGrants(actor, def.domain, WRITE_OPS, facts)
    if (grants.length === 0)
      throw forbidden(`no write grant for ${def.domain} on ${def.name}:${id}`)
    if (!(await this.#gate.allows(actor, def.domain, WRITE_OPS)))
      throw forbidden(`casbin denied ${def.domain} write for ${actor.assignment_id}`)
    const ceiling = fieldCeiling(actor, def.domain, WRITE_OPS, facts)
    if (ceiling === undefined) throw forbidden(`no write grant for ${def.name}:${id}`)
    const ceilingRank = sensitivityRank(ceiling)

    const body: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(input)) {
      if (ENVELOPE_KEYS.has(field)) continue
      if (!isLegalFieldName(field)) throw invalidInput(`illegal field name: ${field}`)
      const spec = fieldSpec(def, field)
      // 字段级写入同样受限：写高于权限的字段 → forbidden
      if (sensitivityRank(spec.sensitivity) > ceilingRank)
        throw forbidden(`field above max_sensitivity: ${def.name}.${field}`)
      body[field] = value
    }

    const subject = this.#subject(def.name, id)
    const pii = piiFields(def).filter((f) => f in body)
    if (pii.length > 0) {
      const key = this.#keys.ensure(subject)
      for (const field of pii) body[field] = encryptValue(key, subject, body[field])
    }

    const now = this.#clock.now()
    const expected = input.version
    if (expected !== undefined && typeof expected !== 'string')
      throw invalidInput('version must be a string')
    const source = input.source === undefined ? null : JSON.stringify(input.source)

    const written = this.#db.transaction((): Row => {
      const existing = this.#db
        .prepare<[string], Row>(`SELECT * FROM "${def.name}" WHERE id = ?`)
        .get(id)
      if (existing === undefined) {
        if (expected !== undefined)
          throw conflict(`record does not exist, cannot match version ${expected}`)
        const row: Row = {
          id,
          schema_version: schemaVersion,
          workspace_id: workspaceId,
          owners: JSON.stringify(owners),
          scope: JSON.stringify(scope),
          sensitivity,
          source,
          created_at: now,
          updated_at: now,
          version: '1',
          body: JSON.stringify(body),
        }
        this.#db
          .prepare(
            `INSERT INTO "${def.name}"
             (id, schema_version, workspace_id, owners, scope, sensitivity, source,
              created_at, updated_at, version, body)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.schema_version,
            row.workspace_id,
            row.owners,
            row.scope,
            row.sensitivity,
            row.source,
            row.created_at,
            row.updated_at,
            row.version,
            row.body,
          )
        return row
      }
      // 21 §6 用例 6：乐观锁，并发写同一记录第二个 conflict
      if (expected === undefined)
        throw conflict(`record exists; version is required (current ${existing.version})`)
      if (expected !== existing.version)
        throw conflict(`version mismatch: ${expected} != ${existing.version}`)
      if (existing.workspace_id !== workspaceId)
        throw forbidden(`cannot move a record across workspaces: ${def.name}:${id}`)
      const next = String(Number(existing.version) + 1)
      const res = this.#db
        .prepare(
          `UPDATE "${def.name}" SET schema_version = ?, owners = ?, scope = ?, sensitivity = ?,
             source = ?, updated_at = ?, version = ?, body = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          schemaVersion,
          JSON.stringify(owners),
          JSON.stringify(scope),
          sensitivity,
          source,
          now,
          next,
          JSON.stringify(body),
          id,
          expected,
        )
      if (res.changes !== 1) throw conflict(`version mismatch: ${expected}`)
      return {
        ...existing,
        schema_version: schemaVersion,
        owners: JSON.stringify(owners),
        scope: JSON.stringify(scope),
        sensitivity,
        source,
        updated_at: now,
        version: next,
        body: JSON.stringify(body),
      }
    })()

    const plain: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(input))
      if (!ENVELOPE_KEYS.has(field)) plain[field] = value
    return {
      id,
      schema_version: schemaVersion,
      workspace_id: workspaceId,
      owners,
      scope,
      sensitivity: sensitivity as Sensitivity,
      ...(input.source === undefined ? {} : { source: input.source as object }),
      created_at: written.created_at,
      updated_at: written.updated_at,
      version: written.version,
      ...plain,
    } as DataRecord<T>
  }

  // ── 删除与遗忘（21 §4）────────────────────────────────────────────────

  /** 契约签名（返回 void）。要拿墓碑事件写日志请用 `eraseSubject`。 */
  async erase(subject: { collection: string; id: string }, actor: DataActor): Promise<void> {
    await this.eraseSubject(subject, actor)
  }

  /**
   * 销毁主体密钥 + 写墓碑；**不删记录、不删事件**。返回 `privacy.erased` 事件对象，
   * 由调用方写进事件日志（本包不依赖 kernel）。
   */
  async eraseSubject(
    subject: { collection: string; id: string },
    actor: DataActor,
  ): Promise<PrivacyErasedEvent> {
    const def = this.#def(subject.collection)
    const row = this.#db
      .prepare<[string, string], Row>(
        `SELECT * FROM "${def.name}" WHERE workspace_id = ? AND id = ?`,
      )
      .get(actor.workspace_id, subject.id)
    if (row === undefined) throw notFound(`${def.name}:${subject.id}`)
    const facts = {
      owners: JSON.parse(row.owners) as string[],
      scope: JSON.parse(row.scope) as RangeRef[],
      sensitivity: row.sensitivity as Sensitivity,
    }
    if (admittingGrants(actor, def.domain, WRITE_OPS, facts).length === 0)
      throw forbidden(`no erase grant for ${def.name}:${subject.id}`)
    if (!(await this.#gate.allows(actor, def.domain, WRITE_OPS)))
      throw forbidden(`casbin denied erase on ${def.domain}`)

    const subjectKey = this.#subject(def.name, subject.id)
    const stored = JSON.parse(row.body) as Record<string, unknown>
    const erasedFields = Object.keys(stored).filter((f) => isEncryptedField(stored[f]))
    const at = this.#keys.destroy(subjectKey, this.#clock.now())
    const event: PrivacyErasedEvent = {
      schema_version: EVENT_SCHEMA_VERSION,
      workspace_id: row.workspace_id,
      type: 'privacy.erased',
      at,
      actor: { kind: 'person', id: actor.person_id },
      subject: { type: def.name, id: subject.id },
      correlation: { trace_id: `erase:${subjectKey}` },
      payload: {
        subject: { collection: def.name, id: subject.id },
        key_id: subjectKey,
        destroyed_at: at,
        erased_fields: erasedFields,
      },
    }
    this.#writeTombstone(event)
    return event
  }

  #writeTombstone(event: PrivacyErasedEvent): void {
    this.#db
      .prepare(
        `INSERT INTO _tombstones (subject_id, collection, record_id, workspace_id, at, event)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_id) DO NOTHING`,
      )
      .run(
        event.payload.key_id,
        event.payload.subject.collection,
        event.payload.subject.id,
        event.workspace_id,
        event.at,
        JSON.stringify(event),
      )
  }

  tombstones(): PrivacyErasedEvent[] {
    return this.#db
      .prepare<[], TombstoneRow>('SELECT * FROM _tombstones ORDER BY at ASC, subject_id ASC')
      .all()
      .map((r) => JSON.parse(r.event) as PrivacyErasedEvent)
  }

  /** 21 §4：备份恢复后重放墓碑——再销毁一次密钥。幂等；返回实际处理条数。 */
  replayTombstones(list: readonly PrivacyErasedEvent[]): number {
    let applied = 0
    const run = this.#db.transaction(() => {
      for (const event of list) {
        this.#keys.destroy(event.payload.key_id, event.payload.destroyed_at)
        this.#writeTombstone(event)
        applied += 1
      }
    })
    run()
    return applied
  }
}

function maxGrantSensitivity(
  actor: DataActor,
  def: CollectionDef,
  ops: readonly Operation[],
): Sensitivity | undefined {
  let best: Sensitivity | undefined
  for (const g of actor.grants) {
    if (g.domain !== def.domain || !g.ops.some((o) => ops.includes(o))) continue
    if (g.range === 'assigned' && actor.ranges.length === 0) continue
    if (best === undefined || sensitivityRank(g.max_sensitivity) > sensitivityRank(best))
      best = g.max_sensitivity
  }
  return best
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw invalidInput(`${label} must be a string[]`)
  return [...(value as string[])]
}

function asRangeArray(value: unknown): RangeRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidInput('scope must be a RangeRef[]')
  return value.map((v) => {
    const r = v as { kind?: unknown; id?: unknown }
    if (typeof r.kind !== 'string' || typeof r.id !== 'string')
      throw invalidInput('scope entries must be { kind, id }')
    return { kind: r.kind, id: r.id } as RangeRef
  })
}

export function createDataStore(opts: DataStoreOptions): SqliteDataStore {
  return new SqliteDataStore(opts)
}
