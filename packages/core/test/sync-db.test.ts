/**
 * WP114：同步 SQL 口（`SyncDb`）的契约一致性套件，**better-sqlite3 这一份**。
 *
 * 同一份用例在 `apps/cloud-worker/test/do-sql.test.ts` 里对 Durable Object 的
 * SQLite 再跑一遍。两边都过，才有资格说"钱包与账号库的 SQL 只写一遍"。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { type SyncDb, syncDbFromBetterSqlite } from '../src/sql/sync-db.js'
import { SYNC_DB_CONTRACT } from '../src/sql/sync-db-contract.js'

const open = (): SyncDb => syncDbFromBetterSqlite(new Database(':memory:'))

describe('SyncDb 契约 · better-sqlite3 档', () => {
  for (const c of SYNC_DB_CONTRACT) {
    it(c.name, () => {
      const db = open()
      try {
        expect(() => {
          c.run(db)
        }).not.toThrow()
      } finally {
        db.close()
      }
    })
  }

  it('布尔绑定值转 0 / 1（better-sqlite3 自己不吃布尔）', () => {
    const db = open()
    db.exec('CREATE TABLE flags (k TEXT PRIMARY KEY NOT NULL, on_off INTEGER NOT NULL) STRICT;')
    db.prepare('INSERT INTO flags (k, on_off) VALUES (?, ?)').run('a', true)
    db.prepare('INSERT INTO flags (k, on_off) VALUES (?, ?)').run('b', false)
    const rows = db.prepare<{ k: string; on_off: number }>('SELECT * FROM flags ORDER BY k').all()
    expect(rows.map((r) => r.on_off)).toEqual([1, 0])
    db.close()
  })

  it('嵌套 transaction 不炸（外层已经保证原子性）', () => {
    const db = open()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT;')
    db.transaction(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO t (id) VALUES (?)').run('a')
      })
    })
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(1)
    db.close()
  })
})
