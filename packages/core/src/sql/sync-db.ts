/**
 * **同步** SQL 口（WP114）。
 *
 * 为什么在已经有 {@link SqlDriver}（异步）之后还要这一个：云侧的钱包与账号库
 * 是**刻意全同步**的——`WalletStore` 那行注释写得很清楚，"钱的读写要么成要么不成，
 * 中间不该有一个 await 让别的请求插进来"。异步口会把那条纪律变成一句愿望：
 * 只要签名里有 Promise，迟早有人在 reserve 与 settle 中间 await 一下，
 * 并发扣款的窗口就开了。
 *
 * 所以这一个口是**同步子集**，只有四件事：
 *
 * | | |
 * |---|---|
 * | `exec(sql)` | 跑一段 DDL（可以有多条语句） |
 * | `prepare(sql)` → `run / get / all` | 带参数的一条语句 |
 * | `transaction(fn)` | 一个原子边界，回调**必须同步** |
 * | `close()` | 关掉 |
 *
 * 两份实现：
 *
 * 1. `better-sqlite3`（本机 / Compose 形态）——{@link syncDbFromBetterSqlite}；
 * 2. Cloudflare Durable Object 的 `ctx.storage.sql`（Workers 形态，见
 *    `apps/cloud-worker/src/do-sql.ts`）。DO 的 SQL 也是同步的、单对象单线程，
 *    所以这条纪律在云上原样成立——这正是 WP114 选 DO 而不选 D1 / Supabase 的理由
 *    （那两个都是异步口，会逼着把钱包改成 async）。
 *
 * **业务 SQL 与迁移只写一遍**：两份实现之间差的只有绑定值的转换与游标的取法。
 */

export { splitStatements } from './driver.js'

/** 能进出 SQL 的标量。布尔在 SQLite 里没有原生类型，由实现转成 0 / 1。 */
export type SyncDbValue = string | number | bigint | boolean | null | Uint8Array

/** `run` 的返回：受影响行数。两份实现都保证这个数字可信（幂等与清理靠它）。 */
export interface SyncDbRunResult {
  changes: number
}

export interface SyncDbStatement<R = Record<string, unknown>> {
  run(...params: readonly SyncDbValue[]): SyncDbRunResult
  get(...params: readonly SyncDbValue[]): R | undefined
  all(...params: readonly SyncDbValue[]): R[]
}

/**
 * 一张库。
 *
 * 占位符一律写 `?`（两份实现都认），**不写任何命名参数**（`@id` / `$id`）——
 * DO 那一头只有位置参数，写了命名参数就等于把业务 SQL 分成两份。
 */
export interface SyncDb {
  /** 多条语句（建表、建索引）。不带参数。 */
  exec(sql: string): void
  prepare<R = Record<string, unknown>>(sql: string): SyncDbStatement<R>
  /**
   * 一个原子边界。回调**同步**执行，抛错回滚。
   * 已经在事务里（嵌套）由实现决定：直接跑，或者开一个 savepoint。
   */
  transaction<T>(fn: () => T): T
  close(): void
}

/**
 * `better-sqlite3` 的那一点点面。
 *
 * 写成结构类型而不是 `import type { Database } from 'better-sqlite3'`：
 * 这个文件要能被 Workers 那一头 import（那里根本没有这个原生模块），
 * 而结构类型不产生任何 import。
 */
export interface BetterSqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  transaction(fn: () => unknown): () => unknown
  readonly inTransaction: boolean
  close(): unknown
}

/** better-sqlite3 只吃这几种绑定值；布尔要转 0 / 1，Uint8Array 要是 Buffer 形状。 */
function bindNode(params: readonly SyncDbValue[]): unknown[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))
}

/** 把一个 better-sqlite3 连接包成 {@link SyncDb}。行为一比一，不加任何缓存。 */
export function syncDbFromBetterSqlite(db: BetterSqliteLike): SyncDb {
  return {
    exec(sql) {
      db.exec(sql)
    },
    prepare<R>(sql: string): SyncDbStatement<R> {
      // 语句只编译一次（better-sqlite3 自己也缓存，但这里显式拿住，
      // 调用方那种"建 store 时 prepare 一批"的写法才不会每次重编）
      const stmt = db.prepare(sql)
      return {
        run: (...params) => ({ changes: stmt.run(...bindNode(params)).changes }),
        get: (...params) => stmt.get(...bindNode(params)) as R | undefined,
        all: (...params) => stmt.all(...bindNode(params)) as R[],
      }
    },
    transaction<T>(fn: () => T): T {
      // 已经在事务里（嵌套）就直接跑：外层已经保证了原子性。
      if (db.inTransaction) return fn()
      return db.transaction(fn as () => unknown)() as T
    },
    close() {
      db.close()
    },
  }
}
