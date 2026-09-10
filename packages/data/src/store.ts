/**
 * 共享数据层（21 §2 / §3 / §4）：信封列 + body JSON、乐观锁、Casbin 过滤下推、
 * 加密分片删除。
 *
 * WP40 起这一层跑在 {@link SqlDriver} 上，**同一个类**同时是 SQLite 档与 Postgres 档：
 * `DataStore` 契约本来就是异步的，所以换后端只换驱动，业务代码一个字不用改（21 §3）。
 * 方言差异只有两处，都在驱动层兜住：DDL 的类型名，以及 JSON 字段过滤的写法
 * （`json_extract` ←→ `->>`，见 `jsonExtract`）。
 *
 * {@link SqliteDataStore} 是它的 SQLite 特化：构造同步（文件档不需要握手）、
 * 另外露出同步的 {@link SubjectKeyring} 给受控原始材料区当 `RawCipher` 用。
 */
import type {
  Clock,
  DataRecord,
  DataStore,
  Operation,
  RangeRef,
  Sensitivity,
} from '@agentsws/contracts'
import { SENSITIVITY_ORDER } from '@agentsws/contracts'
import {
  jsonExtract,
  openSqliteDriver,
  type SqlDriver,
  type SqliteDriver,
} from '@agentsws/core/sql'
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
import {
  DATA_KEY_ENV,
  decryptValue,
  ERASED,
  encryptValue,
  isEncryptedField,
  parseDataKey,
} from './crypto.js'
import { conflict, forbidden, invalidInput, notFound } from './errors.js'
import { asKeyringPort, type KeyringPort, SubjectKeyring } from './keyring.js'
import { sensitivityRank } from './sensitivity.js'
import { SqlSubjectKeyring } from './sql-keyring.js'
import {
  COUNT_TOMBSTONE_SQL,
  collectionDdl,
  INSERT_TOMBSTONE_SQL,
  insertRecordSql,
  type Row,
  SELECT_TOMBSTONES_SQL,
  selectOneSql,
  TOMBSTONES_DDL,
  type TombstoneRow,
  updateRecordSql,
} from './store-sql.js'
import { EVENT_SCHEMA_VERSION, type PrivacyErasedEvent } from './tombstone.js'

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
  /**
   * 只传环境变量表；根密钥（`AGENTSWS_DATA_KEY`）由本模块自己取（35 §2：秘密只从环境变量读）。
   * 有根密钥就把主体密钥包一层再落盘；没有也照常跑（主体密钥本来就是每主体一把独立随机的）。
   */
  env?: Record<string, string | undefined>
}

export interface SqlDataStoreOptions {
  driver: SqlDriver
  clock: Clock
  collections?: readonly CollectionDef[]
  /** 密钥环端口；不给就在同一个驱动上开一个双方言档。 */
  keyring?: KeyringPort
  env?: Record<string, string | undefined>
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export class SqlDataStore implements DataStore {
  protected readonly driver: SqlDriver
  protected readonly clock: Clock
  protected readonly collectionMap = new Map<string, CollectionDef>()
  protected readonly keys: KeyringPort
  readonly #gate = new CasbinGate()

  protected constructor(driver: SqlDriver, clock: Clock, keys: KeyringPort) {
    this.driver = driver
    this.clock = clock
    this.keys = keys
  }

  /** Postgres（或任意驱动）档的入口：建表、注册 collection 后返回。 */
  static async open(opts: SqlDataStoreOptions): Promise<SqlDataStore> {
    const rootKey = parseDataKey((opts.env ?? process.env)[DATA_KEY_ENV])
    const keys =
      opts.keyring ??
      (await SqlSubjectKeyring.open(opts.driver, opts.clock, {
        ...(rootKey === undefined ? {} : { rootKey }),
      }))
    const store = new SqlDataStore(opts.driver, opts.clock, keys)
    await opts.driver.exec(TOMBSTONES_DDL)
    for (const def of opts.collections ?? []) await store.registerCollection(def)
    return store
  }

  /** 每个 collection 一张表（21 §2 信封列 + body JSON）。 */
  async registerCollection(def: CollectionDef): Promise<this> {
    this.#claim(def)
    await this.driver.exec(collectionDdl(def.name))
    this.collectionMap.set(def.name, def)
    return this
  }

  #claim(def: CollectionDef): void {
    const existing = this.collectionMap.get(def.name)
    if (existing !== undefined && existing !== def)
      throw invalidInput(`collection already registered: ${def.name}`)
  }

  /** 已注册的 collection（子类建表时也走这个登记口）。 */
  protected remember(def: CollectionDef): void {
    this.#claim(def)
    this.collectionMap.set(def.name, def)
  }

  collections(): CollectionDef[] {
    return [...this.collectionMap.values()]
  }

  close(): void | Promise<void> {
    return this.driver.close()
  }

  protected def(collection: string): CollectionDef {
    const def = this.collectionMap.get(collection)
    if (def === undefined) throw invalidInput(`unknown collection: ${collection}`)
    return def
  }

  protected subjectOf(collection: string, id: string): string {
    return `${collection}:${id}`
  }

  // ── 读 ─────────────────────────────────────────────────────────────────

  async get<T>(
    collection: string,
    id: string,
    actor: DataActor,
  ): Promise<DataRecord<T> | undefined> {
    const def = this.def(collection)
    const where = accessWhere(def.name, actor, def.domain, READ_OPS, this.driver.dialect)
    // 没有任何可能命中的 grant（含空 ranges 的 assigned）→ 空，不抛错
    if (where === undefined) return undefined
    if (!(await this.#gate.allows(actor, def.domain, READ_OPS))) return undefined
    const row = await this.driver
      .prepare<Row>(selectOneSql(def.name, where.sql))
      .get(actor.workspace_id, id, ...(where.params as string[]))
    if (row === undefined) return undefined
    return this.#hydrate<T>(def, row, actor)
  }

  async query<T>(
    collection: string,
    filter: Record<string, unknown>,
    actor: DataActor,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: DataRecord<T>[]; cursor?: string }> {
    const def = this.def(collection)
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const where = accessWhere(def.name, actor, def.domain, READ_OPS, this.driver.dialect)
    if (where === undefined) return { items: [] }
    if (!(await this.#gate.allows(actor, def.domain, READ_OPS))) return { items: [] }

    const clauses = [`"${def.name}".workspace_id = ?`, where.sql]
    const params: (string | number)[] = [actor.workspace_id, ...(where.params as string[])]

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
      // 21 §3：过滤在数据层下推，不在应用层过滤。两个方言各自的 JSON 取值写法。
      clauses.push(`${jsonExtract(this.driver.dialect, `"${def.name}".body`, key)} = ?`)
      params.push(value as string | number)
    }
    if (opts?.cursor !== undefined) {
      clauses.push(`"${def.name}".id > ?`)
      params.push(opts.cursor)
    }

    const rows = await this.driver
      .prepare<Row>(
        `SELECT * FROM "${def.name}" WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`,
      )
      .all(...params, limit)
    const items: DataRecord<T>[] = []
    for (const row of rows) {
      const rec = await this.#hydrate<T>(def, row, actor)
      if (rec !== undefined) items.push(rec)
    }
    const last = rows[rows.length - 1]
    return rows.length === limit && last !== undefined ? { items, cursor: last.id } : { items }
  }

  /** SQL 之后、返回之前：解密 PII，删掉高于 actor 密级的字段（21 §2 字段分级）。 */
  async #hydrate<T>(
    def: CollectionDef,
    row: Row,
    actor: DataActor,
  ): Promise<DataRecord<T> | undefined> {
    const owners = JSON.parse(row.owners) as string[]
    const scope = JSON.parse(row.scope) as RangeRef[]
    const sensitivity = row.sensitivity as Sensitivity
    const ceiling = fieldCeiling(actor, def.domain, READ_OPS, { owners, scope, sensitivity })
    if (ceiling === undefined) return undefined
    const ceilingRank = sensitivityRank(ceiling)

    const stored = JSON.parse(row.body) as Record<string, unknown>
    const body: Record<string, unknown> = {}
    let key: Buffer | undefined
    let keyLoaded = false
    for (const [field, raw] of Object.entries(stored)) {
      if (sensitivityRank(fieldSpec(def, field).sensitivity) > ceilingRank) continue
      if (isEncryptedField(raw)) {
        if (!keyLoaded) {
          // 只有真有密文字段时才去取密钥：一页 50 条明文记录不该打 50 次密钥表
          key = await this.keys.get(this.subjectOf(def.name, row.id))
          keyLoaded = true
        }
        body[field] = key === undefined ? ERASED : decryptValue(key, raw)
        continue
      }
      body[field] = raw
    }
    const envelope = {
      id: row.id,
      schema_version: Number(row.schema_version),
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
    const def = this.def(collection)
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

    const subject = this.subjectOf(def.name, id)
    const pii = piiFields(def).filter((f) => f in body)
    if (pii.length > 0) {
      const key = await this.keys.ensure(subject)
      for (const field of pii) body[field] = encryptValue(key, subject, body[field])
    }

    const now = this.clock.now()
    const expected = input.version
    if (expected !== undefined && typeof expected !== 'string')
      throw invalidInput('version must be a string')
    const source = input.source === undefined ? null : JSON.stringify(input.source)

    const written = await this.driver.transaction(async (tx): Promise<Row> => {
      const existing = await tx.prepare<Row>(`SELECT * FROM "${def.name}" WHERE id = ?`).get(id)
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
        await tx
          .prepare(insertRecordSql(def.name))
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
      const res = await tx
        .prepare(updateRecordSql(def.name))
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
    })

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

  /** 契约：返回墓碑事件，由调用方写事件日志。 */
  async erase(
    subject: { collection: string; id: string },
    actor: DataActor,
  ): Promise<PrivacyErasedEvent> {
    return this.eraseSubject(subject, actor)
  }

  /** 21 §4 可携带权：该主体的记录（按 actor 权限过滤；v1 = 单条记录）。 */
  async exportSubject(
    subject: { collection: string; id: string },
    actor: DataActor,
  ): Promise<DataRecord<unknown>[]> {
    const rec = await this.get<unknown>(subject.collection, subject.id, actor)
    return rec === undefined ? [] : [rec]
  }

  /**
   * 销毁主体密钥 + 写墓碑；**不删记录、不删事件**。返回 `privacy.erased` 事件对象，
   * 由调用方写进事件日志（本包不依赖 kernel）。
   */
  async eraseSubject(
    subject: { collection: string; id: string },
    actor: DataActor,
  ): Promise<PrivacyErasedEvent> {
    const def = this.def(subject.collection)
    const row = await this.driver
      .prepare<Row>(`SELECT * FROM "${def.name}" WHERE workspace_id = ? AND id = ?`)
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

    const subjectKey = this.subjectOf(def.name, subject.id)
    const stored = JSON.parse(row.body) as Record<string, unknown>
    const erasedFields = Object.keys(stored).filter((f) => isEncryptedField(stored[f]))
    const at = await this.keys.destroy(subjectKey, this.clock.now())
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
    await this.writeTombstone(event)
    return event
  }

  protected async writeTombstone(event: PrivacyErasedEvent): Promise<void> {
    await this.driver
      .prepare(INSERT_TOMBSTONE_SQL)
      .run(
        event.payload.key_id,
        event.payload.subject.collection,
        event.payload.subject.id,
        event.workspace_id,
        event.at,
        JSON.stringify(event),
      )
  }

  async listTombstones(): Promise<PrivacyErasedEvent[]> {
    const rows = await this.driver.prepare<TombstoneRow>(SELECT_TOMBSTONES_SQL).all()
    return rows.map((r) => JSON.parse(r.event) as PrivacyErasedEvent)
  }

  /** 21 §4：备份恢复后重放墓碑——再销毁一次密钥。幂等：已有墓碑的计 skipped。 */
  async replayTombstones(
    list: readonly PrivacyErasedEvent[],
  ): Promise<{ applied: number; skipped: number }> {
    let applied = 0
    let skipped = 0
    for (const event of list) {
      const row = await this.driver
        .prepare<{ n: number }>(COUNT_TOMBSTONE_SQL)
        .get(event.payload.key_id)
      const had = Number(row?.n ?? 0) > 0
      await this.keys.destroy(event.payload.key_id, event.payload.destroyed_at)
      await this.writeTombstone(event)
      if (had) skipped += 1
      else applied += 1
    }
    return { applied, skipped }
  }
}

/**
 * SQLite 档。与 {@link SqlDataStore} 是同一套逻辑，只多两件 SQLite 才有的事：
 * 构造与建表同步（`createDataStore` 一直是同步的，模拟世界靠它），
 * 以及露出同步的 {@link SubjectKeyring} 当 `RawCipher`（18 §2.1 的跨包接线）。
 */
export class SqliteDataStore extends SqlDataStore {
  readonly #sqlite: SqliteDriver
  readonly #keys: SubjectKeyring

  constructor(opts: DataStoreOptions) {
    const driver = openSqliteDriver({ path: opts.dbPath })
    const rootKey = parseDataKey((opts.env ?? process.env)[DATA_KEY_ENV])
    const keys = new SubjectKeyring(driver.database, opts.clock, {
      ...(rootKey === undefined ? {} : { rootKey }),
    })
    super(driver, opts.clock, asKeyringPort(keys))
    this.#sqlite = driver
    this.#keys = keys
    driver.execSync(TOMBSTONES_DDL)
    for (const def of opts.collections ?? []) this.register(def)
  }

  /**
   * 主体密钥环（21 §4）。**受控原始材料区的加密就接这里**：
   * `@agentsws/channels` 与 `@agentsws/meetings` 拿它当 `RawCipher` 用，
   * 于是「随主体删除」在数据层、邮件原文区、录音区是同一次 `shred`（WP18 的跨包接线遗留）。
   */
  get keyring(): SubjectKeyring {
    return this.#keys
  }

  /** 同步建表（SQLite 档专有）。双方言档用 `registerCollection`。 */
  register(def: CollectionDef): this {
    this.remember(def)
    this.#sqlite.execSync(collectionDdl(def.name))
    return this
  }

  /** 墓碑清单（同步；SQLite 档专有）。双方言档用 `listTombstones`。 */
  tombstones(): PrivacyErasedEvent[] {
    return this.#sqlite
      .prepareSync<TombstoneRow>(SELECT_TOMBSTONES_SQL)
      .allSync()
      .map((r) => JSON.parse(r.event) as PrivacyErasedEvent)
  }

  override close(): void {
    this.#sqlite.closeSync()
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
