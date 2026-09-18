/**
 * WP114：同步 SQL 口（`SyncDb`）的契约一致性套件，**Durable Object 这一份**。
 *
 * 与 `packages/core/test/sync-db.test.ts` 跑的是**同一份用例**（`SYNC_DB_CONTRACT`）。
 * 两边都过，才有资格说"钱包与账号库的 SQL 只写一遍"。
 *
 * 这一份跑在假的 DO 存储上（见 `helpers.ts` 的诚实声明）：`doSyncDb` 那一层的
 * 全部逻辑——多语句 exec 要切开、游标当场消费、`rowsWritten` 当 changes、
 * 绑定值转换、嵌套 transaction——都是真的在测。
 */

import { SYNC_DB_CONTRACT } from '@agentsws/core/sql'
import { describe, expect, it } from 'vitest'
import { doSyncDb } from '../src/do-sql.js'
import { FakeDoStorage } from './helpers.js'

describe('SyncDb 契约 · Durable Object SQLite 档', () => {
  for (const c of SYNC_DB_CONTRACT) {
    it(c.name, () => {
      const db = doSyncDb(new FakeDoStorage())
      expect(() => {
        c.run(db)
      }).not.toThrow()
    })
  }

  it('exec 里的多条语句被切开一条一条跑（DO 的 exec 跑不了 BEGIN）', () => {
    const storage = new FakeDoStorage()
    const seen: string[] = []
    const original = storage.sql.exec.bind(storage.sql)
    // biome-ignore lint/suspicious/noExplicitAny: 测试里把 exec 包一层记账
    ;(storage.sql as any).exec = (query: string, ...bindings: unknown[]) => {
      seen.push(query.trim().split(/\s+/).slice(0, 2).join(' '))
      return original(query, ...bindings)
    }
    doSyncDb(storage).exec(`
CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS a_id ON a (id);
`)
    expect(seen).toEqual(['CREATE TABLE', 'CREATE INDEX'])
  })

  it('布尔绑定值转 0 / 1（DO 的绑定不吃布尔）', () => {
    const db = doSyncDb(new FakeDoStorage())
    db.exec('CREATE TABLE flags (k TEXT PRIMARY KEY NOT NULL, on_off INTEGER NOT NULL) STRICT;')
    db.prepare('INSERT INTO flags (k, on_off) VALUES (?, ?)').run('a', true)
    db.prepare('INSERT INTO flags (k, on_off) VALUES (?, ?)').run('b', false)
    expect(
      db
        .prepare<{ on_off: number }>('SELECT on_off FROM flags ORDER BY k')
        .all()
        .map((r) => r.on_off),
    ).toEqual([1, 0])
  })

  it('嵌套 transaction 只开最外面那一层（DO 的 transactionSync 不重入）', () => {
    const storage = new FakeDoStorage()
    let opened = 0
    const original = storage.transactionSync.bind(storage)
    storage.transactionSync = <T>(closure: () => T): T => {
      opened += 1
      return original(closure)
    }
    const db = doSyncDb(storage)
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT;')
    db.transaction(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO t (id) VALUES (?)').run('a')
      })
    })
    expect(opened).toBe(1)
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(1)
  })

  it('close() 是空的——DO 的库与对象同生共死，没有"关掉"这回事', () => {
    const db = doSyncDb(new FakeDoStorage())
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT;')
    db.close()
    // 关完还能用（正是想要的：调用方不必知道自己拿的是哪一份）
    expect(() => db.prepare('INSERT INTO t (id) VALUES (?)').run('a')).not.toThrow()
  })
})
