/**
 * `TxnStore` 的 SQLite 档（WP18）。接口与 {@link MemoryTxnStore} 逐字一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * 落盘的东西（14 §存储 / 15 §5）：
 * - 审批项与它的决定历史（revision 链）、发过的事件 id
 * - decision_token 台账（一次性、可撤销）
 * - 变更账本、生效额度、审批上下文、宿主写的批准标记
 * - 预占额度（held / committed / released）
 * - apply 三态里最要紧的 `unknown` 与它的**对账游标**：重启后 `reconcile()` 接着处理
 *
 * 纪律：
 * - 所有 SQL 参数化，没有一处字符串拼值
 * - `better-sqlite3` 同步 API —— `TxnStore` 全同步，天然对上
 * - 时间经注入的 Clock（只有迁移记时间；行里的时间戳都来自调用方写进 JSON 的字段）
 * - 只用自己这张库里的表，不共享其他包的表（35 §2）
 */

import type {
  ApprovalItem,
  Clock,
  Mandate,
  ProvenanceState,
  RunId,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { openSqliteDriver, type SqliteDriver } from '@agentsws/core/sql'
import type { Database as Db } from 'better-sqlite3'
import { migrate, schemaVersion } from './migrations.js'
import { MIGRATIONS } from './schema.js'
import type {
  AcquireApplyLockInput,
  ApplyLock,
  ApprovalContext,
  ApprovalFilter,
  ChangeFilter,
  Reservation,
  TokenRecord,
  TxnStore,
} from './types.js'
import { ms, refKey } from './util.js'

export interface SqliteTxnStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`（测试与一次性任务）。 */
  dbPath?: string
  /** 迁移记时间用；不给则用一个固定占位时刻（不裸调 Date.now）。 */
  clock?: Clock
}

interface JsonRow {
  json: string
}
interface ApplyLockRow {
  key: string
  holder: string
  token: number
  acquired_at: string
  expires_at: string
  expires_ms: number
}
interface TokenRow {
  token: string
  item_id: string
  revision: number
  snapshot_hash: string
  person: string
  issued_at: string
  revoked: number
  used: string | null
}

const EPOCH = '1970-01-01T00:00:00.000Z'

/** JSON 列的解析：写进去的就是 `JSON.stringify(值)`，读出来必然是同一形状。 */
const parse = <T>(row: JsonRow | undefined): T | undefined =>
  row === undefined ? undefined : (JSON.parse(row.json) as T)

export class SqliteTxnStore implements TxnStore {
  readonly #driver: SqliteDriver
  readonly #db: Db
  #closed = false

  constructor(options: SqliteTxnStoreOptions = {}) {
    // 崩溃中途不能留下半个事务（15 §5.8 的 unknown 要靠状态本身可信）→ synchronous = FULL
    this.#driver = openSqliteDriver({ path: options.dbPath ?? ':memory:', fullSync: true })
    this.#db = this.#driver.database
    migrate(this.#driver, MIGRATIONS, options.clock?.now() ?? EPOCH)
  }

  /** 已应用的最高迁移版本；同一个库开两次不重跑（幂等）。 */
  get schemaVersion(): number {
    return schemaVersion(this.#driver)
  }

  /** 底层连接；只给同包测试用（断言迁移与并发），业务代码不得直连 SQL。 */
  get database(): Db {
    return this.#db
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#driver.closeSync()
  }

  transaction<T>(fn: () => T): T {
    // 已在事务里（嵌套调用）就直接执行：SQLite 没有真嵌套事务，
    // better-sqlite3 的 savepoint 语义足够，但外层已经保证了原子性。
    if (this.#db.inTransaction) return fn()
    return this.#db.transaction(fn)()
  }

  // ───────────────────────────── 审批项

  putApproval(item: ApprovalItem): void {
    this.#db
      .prepare(
        `INSERT INTO approvals (id, workspace_id, kind, role_id, state, dedupe_key, json)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           kind         = excluded.kind,
           role_id      = excluded.role_id,
           state        = excluded.state,
           dedupe_key   = excluded.dedupe_key,
           json         = excluded.json`,
      )
      .run(
        item.id,
        item.workspace_id,
        item.kind,
        item.role_id ?? null,
        item.state,
        item.dedupe_key ?? null,
        JSON.stringify(item),
      )
  }

  getApproval(id: string): ApprovalItem | undefined {
    return parse<ApprovalItem>(
      this.#db.prepare<[string], JsonRow>('SELECT json FROM approvals WHERE id = ?').get(id),
    )
  }

  listApprovals(filter: ApprovalFilter = {}): ApprovalItem[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (filter.workspace_id !== undefined) {
      where.push('workspace_id = ?')
      args.push(filter.workspace_id)
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?')
      args.push(filter.kind)
    }
    if (filter.role_id !== undefined) {
      where.push('role_id = ?')
      args.push(filter.role_id)
    }
    if (filter.dedupe_key !== undefined) {
      where.push('dedupe_key = ?')
      args.push(filter.dedupe_key)
    }
    if (filter.state !== undefined) {
      // 空数组 → 谁都不匹配（与内存档 `includes` 一致）
      where.push(`state IN (${filter.state.map(() => '?').join(',') || 'NULL'})`)
      args.push(...filter.state)
    }
    const sql = `SELECT json FROM approvals${
      where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY rowid`
    return this.#db
      .prepare<(string | number)[], JsonRow>(sql)
      .all(...args)
      .map((r) => JSON.parse(r.json) as ApprovalItem)
  }

  pushRevision(item: ApprovalItem): void {
    this.#db
      .prepare('INSERT INTO approval_revisions (item_id, json) VALUES (?,?)')
      .run(item.id, JSON.stringify(item))
  }

  revisions(id: string): ApprovalItem[] {
    return this.#db
      .prepare<[string], JsonRow>(
        'SELECT json FROM approval_revisions WHERE item_id = ? ORDER BY rowid',
      )
      .all(id)
      .map((r) => JSON.parse(r.json) as ApprovalItem)
  }

  pushEventId(item_id: string, event_id: string): void {
    this.#db
      .prepare('INSERT INTO approval_events (item_id, event_id) VALUES (?,?)')
      .run(item_id, event_id)
  }

  eventIds(item_id: string): string[] {
    return this.#db
      .prepare<[string], { event_id: string }>(
        'SELECT event_id FROM approval_events WHERE item_id = ? ORDER BY rowid',
      )
      .all(item_id)
      .map((r) => r.event_id)
  }

  // ───────────────────────────── decision_token 台账（14 §7）

  putToken(t: TokenRecord): void {
    this.#db
      .prepare(
        `INSERT INTO tokens (token, item_id, revision, snapshot_hash, person, issued_at, revoked, used)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET
           item_id       = excluded.item_id,
           revision      = excluded.revision,
           snapshot_hash = excluded.snapshot_hash,
           person        = excluded.person,
           issued_at     = excluded.issued_at,
           revoked       = excluded.revoked,
           used          = excluded.used`,
      )
      .run(
        t.token,
        t.item_id,
        t.revision,
        t.snapshot_hash,
        t.person,
        t.issued_at,
        t.revoked ? 1 : 0,
        t.used === undefined ? null : JSON.stringify(t.used),
      )
  }

  #token(row: TokenRow): TokenRecord {
    return {
      token: row.token,
      item_id: row.item_id,
      revision: row.revision,
      snapshot_hash: row.snapshot_hash,
      person: row.person,
      issued_at: row.issued_at,
      revoked: row.revoked === 1,
      ...(row.used === null
        ? {}
        : { used: JSON.parse(row.used) as NonNullable<TokenRecord['used']> }),
    }
  }

  getToken(token: string): TokenRecord | undefined {
    const row = this.#db
      .prepare<[string], TokenRow>('SELECT * FROM tokens WHERE token = ?')
      .get(token)
    return row === undefined ? undefined : this.#token(row)
  }

  tokensFor(item_id: string): TokenRecord[] {
    return this.#db
      .prepare<[string], TokenRow>('SELECT * FROM tokens WHERE item_id = ? ORDER BY rowid')
      .all(item_id)
      .map((r) => this.#token(r))
  }

  revokeTokensFor(item_id: string): void {
    this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE item_id = ?').run(item_id)
  }

  // ───────────────────────────── 变更账本

  putChange(c: StagedChange): void {
    this.#db
      .prepare(
        `INSERT INTO changes (id, workspace_id, kind, run_id, assignment_id, change_set_id,
                              status, target_key, created_ms, json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id  = excluded.workspace_id,
           kind          = excluded.kind,
           run_id        = excluded.run_id,
           assignment_id = excluded.assignment_id,
           change_set_id = excluded.change_set_id,
           status        = excluded.status,
           target_key    = excluded.target_key,
           created_ms    = excluded.created_ms,
           json          = excluded.json`,
      )
      .run(
        c.id,
        c.workspace_id,
        c.kind,
        c.run_id ?? null,
        c.assignment_id ?? null,
        c.change_set_id ?? null,
        c.status,
        refKey(c.target),
        ms(c.created_at),
        JSON.stringify(c),
      )
  }

  getChange(id: string): StagedChange | undefined {
    return parse<StagedChange>(
      this.#db.prepare<[string], JsonRow>('SELECT json FROM changes WHERE id = ?').get(id),
    )
  }

  listChanges(filter: ChangeFilter = {}): StagedChange[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (filter.workspace_id !== undefined) {
      where.push('workspace_id = ?')
      args.push(filter.workspace_id)
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?')
      args.push(filter.kind)
    }
    if (filter.run_id !== undefined) {
      where.push('run_id = ?')
      args.push(filter.run_id)
    }
    if (filter.assignment_id !== undefined) {
      where.push('assignment_id = ?')
      args.push(filter.assignment_id)
    }
    if (filter.change_set_id !== undefined) {
      where.push('change_set_id = ?')
      args.push(filter.change_set_id)
    }
    if (filter.status !== undefined) {
      where.push(`status IN (${filter.status.map(() => '?').join(',') || 'NULL'})`)
      args.push(...filter.status)
    }
    if (filter.target !== undefined) {
      where.push('target_key = ?')
      args.push(refKey(filter.target))
    }
    if (filter.since !== undefined) {
      where.push('created_ms >= ?')
      args.push(ms(filter.since))
    }
    const sql = `SELECT json FROM changes${
      where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY rowid`
    return this.#db
      .prepare<(string | number)[], JsonRow>(sql)
      .all(...args)
      .map((r) => JSON.parse(r.json) as StagedChange)
  }

  putMandate(change_id: string, m: Mandate): void {
    this.#db
      .prepare(
        `INSERT INTO mandates (change_id, json) VALUES (?,?)
         ON CONFLICT(change_id) DO UPDATE SET json = excluded.json`,
      )
      .run(change_id, JSON.stringify(m))
  }

  getMandate(change_id: string): Mandate | undefined {
    return parse<Mandate>(
      this.#db
        .prepare<[string], JsonRow>('SELECT json FROM mandates WHERE change_id = ?')
        .get(change_id),
    )
  }

  putContext(item_id: string, ctx: ApprovalContext): void {
    this.#db
      .prepare(
        `INSERT INTO contexts (item_id, json) VALUES (?,?)
         ON CONFLICT(item_id) DO UPDATE SET json = excluded.json`,
      )
      .run(item_id, JSON.stringify(ctx))
  }

  getContext(item_id: string): ApprovalContext | undefined {
    return parse<ApprovalContext>(
      this.#db
        .prepare<[string], JsonRow>('SELECT json FROM contexts WHERE item_id = ?')
        .get(item_id),
    )
  }

  // ───────────────────────────── 批准标记（15 §5.2）

  markApproved(change_id: string): void {
    this.#db
      .prepare('INSERT INTO approved_changes (change_id) VALUES (?) ON CONFLICT DO NOTHING')
      .run(change_id)
  }

  isApproved(change_id: string): boolean {
    return (
      this.#db
        .prepare<[string], { one: number }>(
          'SELECT 1 AS one FROM approved_changes WHERE change_id = ?',
        )
        .get(change_id) !== undefined
    )
  }

  // ───────────────────────────── 施行锁 + 围栏号（15 §apply / 31 §3.2）

  /**
   * 跨进程的那一档。整件事在**一个立即写事务**里做完——
   * `IMMEDIATE` 让两个进程里只有一个能进来，另一个要么等要么当场 `SQLITE_BUSY`，
   * 不会出现两边都读到「没人持锁」然后都写进去。
   */
  acquireApplyLock(input: AcquireApplyLockInput): ApplyLock | undefined {
    const nowMs = ms(input.now)
    const run = this.#db.transaction((): ApplyLock | undefined => {
      const held = this.#db
        .prepare<[string], ApplyLockRow>('SELECT * FROM apply_locks WHERE key = ?')
        .get(input.key)
      if (held !== undefined && held.expires_ms > nowMs) return undefined
      const last =
        this.#db
          .prepare<[string], { token: number }>('SELECT token FROM apply_lock_tokens WHERE key = ?')
          .get(input.key)?.token ?? 0
      const token = last + 1
      const expires_at = new Date(nowMs + input.leaseMs).toISOString()
      this.#db
        .prepare(
          `INSERT INTO apply_lock_tokens (key, token) VALUES (?,?)
           ON CONFLICT(key) DO UPDATE SET token = excluded.token`,
        )
        .run(input.key, token)
      this.#db
        .prepare(
          `INSERT INTO apply_locks (key, holder, token, acquired_at, expires_at, expires_ms)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             holder = excluded.holder, token = excluded.token,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at, expires_ms = excluded.expires_ms`,
        )
        .run(input.key, input.holder, token, input.now, expires_at, nowMs + input.leaseMs)
      return {
        key: input.key,
        holder: input.holder,
        token,
        acquired_at: input.now,
        expires_at,
      }
    })
    // 已经在外层事务里（同进程嵌套）就直接跑；否则用 IMMEDIATE 抢写锁。
    return this.#db.inTransaction ? run() : run.immediate()
  }

  releaseApplyLock(key: string, token: number): void {
    this.#db
      .prepare<[string, number]>('DELETE FROM apply_locks WHERE key = ? AND token = ?')
      .run(key, token)
  }

  applyLockOf(key: string): ApplyLock | undefined {
    const row = this.#db
      .prepare<[string], ApplyLockRow>('SELECT * FROM apply_locks WHERE key = ?')
      .get(key)
    return row === undefined
      ? undefined
      : {
          key: row.key,
          holder: row.holder,
          token: row.token,
          acquired_at: row.acquired_at,
          expires_at: row.expires_at,
        }
  }

  // ───────────────────────────── 预占额度（31 §3.2）

  reserve(counter: string, change_id: string, amount: number): Reservation {
    const r: Reservation = { counter, change_id, amount, state: 'held' }
    this.#db
      .prepare(
        `INSERT INTO reservations (change_id, counter, amount, state) VALUES (?,?,?,?)
         ON CONFLICT(change_id) DO UPDATE SET
           counter = excluded.counter, amount = excluded.amount, state = excluded.state`,
      )
      .run(change_id, counter, amount, 'held')
    return r
  }

  reservationOf(change_id: string): Reservation | undefined {
    const row = this.#db
      .prepare<[string], { change_id: string; counter: string; amount: number; state: string }>(
        'SELECT * FROM reservations WHERE change_id = ?',
      )
      .get(change_id)
    if (row === undefined) return undefined
    return {
      counter: row.counter,
      change_id: row.change_id,
      amount: row.amount,
      state: row.state as Reservation['state'],
    }
  }

  countReserved(counter: string): number {
    const row = this.#db
      .prepare<[string], { total: number | null }>(
        `SELECT SUM(amount) AS total FROM reservations WHERE counter = ? AND state != 'released'`,
      )
      .get(counter)
    return row?.total ?? 0
  }

  commitReservation(change_id: string): void {
    this.#db
      .prepare(`UPDATE reservations SET state = 'committed' WHERE change_id = ?`)
      .run(change_id)
  }

  releaseReservation(change_id: string): void {
    this.#db
      .prepare(`UPDATE reservations SET state = 'released' WHERE change_id = ?`)
      .run(change_id)
  }

  // ───────────────────────────── provenance（15 §6）

  putProvenance(state: ProvenanceState): void {
    this.#db
      .prepare(
        `INSERT INTO provenance (run_id, json) VALUES (?,?)
         ON CONFLICT(run_id) DO UPDATE SET json = excluded.json`,
      )
      .run(state.run_id, JSON.stringify(state))
  }

  getProvenance(run_id: RunId): ProvenanceState | undefined {
    return parse<ProvenanceState>(
      this.#db
        .prepare<[string], JsonRow>('SELECT json FROM provenance WHERE run_id = ?')
        .get(run_id),
    )
  }

  // ───────────────────────────── 对账（15 §5.8）

  getCursor(name: string): string | undefined {
    return this.#db
      .prepare<[string], { value: string }>('SELECT value FROM cursors WHERE name = ?')
      .get(name)?.value
  }

  setCursor(name: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO cursors (name, value) VALUES (?,?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, value)
  }

  pendingReconcile(workspace_id?: WorkspaceId): StagedChange[] {
    return this.listChanges({
      status: ['unknown'],
      ...(workspace_id === undefined ? {} : { workspace_id }),
    })
  }
}

export function createSqliteTxnStore(options: SqliteTxnStoreOptions = {}): SqliteTxnStore {
  return new SqliteTxnStore(options)
}
