/**
 * Durable Object 的 SQLite → {@link SyncDb}（WP114）。
 *
 * 这是整个 Workers 形态的地基。Cloudflare 的 DO 有一个 SQLite 存储后端，
 * 它的 `ctx.storage.sql.exec(query, ...bindings)` 是**同步**的，而且一个 DO
 * 同一时刻只有一个线程在跑——所以"钱的读写中间不该有一个 await"这条纪律
 * （见 `packages/metering/src/wallet.ts`）在云上原样成立。
 *
 * 这也正是 WP114 不用 D1 / Supabase 的原因：那两个都是异步口，用它们就得把
 * `WalletStore` 与账号库整片改成 async，而只要签名里有 Promise，迟早有人在
 * reserve 与 settle 中间 await 一下——并发扣款的窗口就开了。
 *
 * 按 2026-09 的官方文档（`developers.cloudflare.com/durable-objects/api/sql-storage/`）：
 *
 * - `exec(query, ...bindings)` 回一个游标：`toArray()` / `one()` / `raw()` /
 *   `columnNames` / `rowsRead` / `rowsWritten`；
 * - 游标**要在下一个 await 之前同步消费完**，否则没有快照隔离保证。
 *   这里每条语句当场 `toArray()`，不把游标留过任何 await；
 * - `exec()` **跑不了** `BEGIN TRANSACTION` / `SAVEPOINT`；事务要用
 *   `ctx.storage.transactionSync(cb)`（同步回调）；
 * - 数字受 JS 的 52 位精度限制——我们这几张表里最大的数是毫秒时间戳与积分，
 *   都远在安全范围内。
 *
 * 一条与 better-sqlite3 的差别：**DO 没有 prepare**。所以这里的 `prepare(sql)`
 * 只是把 SQL 文本记下来，每次 run / get / all 都调一次 `exec`——语义一样，
 * 少一层编译缓存（DO 内部自己有语句缓存）。
 */

import type { SyncDb, SyncDbStatement, SyncDbValue } from '@agentsws/core/sql/sync-db'
import { splitStatements } from '@agentsws/core/sql/sync-db'

/** `ctx.storage.sql` 的那一点点面（写成结构类型，测试里能塞一个假的）。 */
export interface DoSqlCursor<R> {
  toArray(): R[]
  readonly rowsWritten: number
}

export interface DoSqlStorage {
  exec<R = Record<string, unknown>>(query: string, ...bindings: unknown[]): DoSqlCursor<R>
}

/** `ctx.storage` 里我们用到的那两样。 */
export interface DoStorageLike {
  readonly sql: DoSqlStorage
  transactionSync<T>(closure: () => T): T
}

/**
 * DO 的 SQL 绑定值只吃 string / number / null / ArrayBuffer。
 * 布尔转 0 / 1（与 better-sqlite3 那一份同一条规则），bigint 转 number。
 */
function bind(params: readonly SyncDbValue[]): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0
    if (typeof p === 'bigint') return Number(p)
    if (p instanceof Uint8Array) {
      // ArrayBuffer 才是 DO 认的那一种；Uint8Array 的视图可能只是一段
      return p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)
    }
    return p
  })
}

/** 把一个 DO 的 `ctx.storage` 包成 {@link SyncDb}。 */
export function doSyncDb(storage: DoStorageLike): SyncDb {
  let depth = 0
  return {
    exec(sql) {
      /*
       * DDL 常常是好几条语句一串。DO 的 `exec` 在同一次调用里能跑多条，
       * 但**一条都不能是 BEGIN / SAVEPOINT**；这里显式切开一条一条跑，
       * 既躲开那条限制，报错时也看得出是哪一条建表语句坏了。
       */
      for (const one of splitStatements(sql)) storage.sql.exec(one)
    },

    prepare<R>(sql: string): SyncDbStatement<R> {
      return {
        run(...params) {
          const cursor = storage.sql.exec(sql, ...bind(params))
          // 游标当场消费干净：DO 的 rowsWritten 要遍历完才是最终值
          cursor.toArray()
          return { changes: cursor.rowsWritten }
        },
        get(...params) {
          const rows = storage.sql.exec<R>(sql, ...bind(params)).toArray()
          // 没命中回 undefined（不是 null），与 better-sqlite3 那一份一致
          return rows.length === 0 ? undefined : rows[0]
        },
        all(...params) {
          return storage.sql.exec<R>(sql, ...bind(params)).toArray()
        },
      }
    },

    transaction<T>(fn: () => T): T {
      // 嵌套就直接跑：外层那个 transactionSync 已经保证了原子性
      if (depth > 0) return fn()
      depth += 1
      try {
        return storage.transactionSync(fn)
      } finally {
        depth -= 1
      }
    },

    close() {
      // DO 的库与这个对象同生共死，没有"关掉"这回事。
      // 留着这个空实现是为了口子一致——调用方不必知道自己拿的是哪一份。
    },
  }
}
