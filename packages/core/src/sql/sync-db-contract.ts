/**
 * {@link SyncDb} 的**契约一致性套件**（WP114）。
 *
 * 一份用例，两份实现各跑一遍：better-sqlite3（`packages/core/test/sync-db.test.ts`）
 * 与 Cloudflare Durable Object 的 SQLite（`apps/cloud-worker/test/do-sql.test.ts`）。
 * 两边都过，才有资格说"业务 SQL 只写一遍"。
 *
 * 断言用的是裸 `throw`，不是某个测试框架的 `expect`——这个文件要能被
 * Workers 那一头 import，而那边跑的是另一个 runner。
 */

import type { SyncDb } from './sync-db.js'

function assert(ok: boolean, what: string): void {
  if (!ok) throw new Error(`SyncDb 契约不满足：${what}`)
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${what}（拿到 ${a}，期望 ${b}）`)
}

export interface SyncDbContractCase {
  name: string
  run(db: SyncDb): void
}

/** 建一张只给这套用例用的表。每条用例自己建自己的，互不干扰。 */
function fresh(db: SyncDb, table: string, columns: string): void {
  db.exec(`DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table} (${columns}) STRICT;`)
}

export const SYNC_DB_CONTRACT: readonly SyncDbContractCase[] = [
  {
    name: 'exec 能一次跑多条语句（建表 + 建索引）',
    run(db) {
      db.exec(`
DROP TABLE IF EXISTS c_multi;
CREATE TABLE c_multi (id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS c_multi_n ON c_multi (n);
`)
      db.prepare('INSERT INTO c_multi (id, n) VALUES (?, ?)').run('a', 1)
      assertEqual(db.prepare<{ n: number }>('SELECT n FROM c_multi').get()?.n, 1, '多语句 exec')
    },
  },
  {
    name: 'run 回受影响行数；insert / update / delete 都算数',
    run(db) {
      fresh(db, 'c_changes', 'id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL')
      const ins = db.prepare('INSERT INTO c_changes (id, n) VALUES (?, ?)')
      assertEqual(ins.run('a', 1).changes, 1, 'insert 一行')
      ins.run('b', 2)
      assertEqual(db.prepare('UPDATE c_changes SET n = n + 1').run().changes, 2, 'update 两行')
      assertEqual(db.prepare('DELETE FROM c_changes WHERE n >= ?').run(2).changes, 2, 'delete 两行')
    },
  },
  {
    name: 'get 没命中回 undefined，不是 null、也不抛',
    run(db) {
      fresh(db, 'c_get', 'id TEXT PRIMARY KEY NOT NULL')
      const row = db.prepare<{ id: string }>('SELECT id FROM c_get WHERE id = ?').get('nope')
      assert(row === undefined, 'get 没命中要回 undefined')
    },
  },
  {
    name: 'all 回行对象数组，顺序按 ORDER BY',
    run(db) {
      fresh(db, 'c_all', 'id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL')
      const ins = db.prepare('INSERT INTO c_all (id, n) VALUES (?, ?)')
      ins.run('b', 2)
      ins.run('a', 1)
      const rows = db.prepare<{ id: string; n: number }>('SELECT id, n FROM c_all ORDER BY n').all()
      assertEqual(
        rows.map((r) => r.id),
        ['a', 'b'],
        'all 的顺序',
      )
      assertEqual(rows[0]?.n, 1, 'all 的列值')
    },
  },
  {
    name: '同一条 prepare 能反复用，参数每次重新绑',
    run(db) {
      fresh(db, 'c_reuse', 'id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL')
      const ins = db.prepare('INSERT INTO c_reuse (id, n) VALUES (?, ?)')
      for (let i = 0; i < 5; i += 1) ins.run(`k${String(i)}`, i)
      const sel = db.prepare<{ n: number }>('SELECT n FROM c_reuse WHERE id = ?')
      assertEqual(sel.get('k3')?.n, 3, '第一次查')
      assertEqual(sel.get('k1')?.n, 1, '同一条语句再查一次')
    },
  },
  {
    name: 'NULL 进得去也出得来（可空列）',
    run(db) {
      fresh(db, 'c_null', 'id TEXT PRIMARY KEY NOT NULL, note TEXT')
      db.prepare('INSERT INTO c_null (id, note) VALUES (?, ?)').run('a', null)
      const row = db
        .prepare<{ note: string | null }>('SELECT note FROM c_null WHERE id = ?')
        .get('a')
      assert(row?.note === null, 'NULL 读回来要是 null')
    },
  },
  {
    name: 'REAL 列不被取整（积分要留小数）',
    run(db) {
      fresh(db, 'c_real', 'id TEXT PRIMARY KEY NOT NULL, credits REAL NOT NULL')
      db.prepare('INSERT INTO c_real (id, credits) VALUES (?, ?)').run('a', 1.2345)
      const row = db.prepare<{ credits: number }>('SELECT credits FROM c_real').get()
      assertEqual(row?.credits, 1.2345, 'REAL 原样')
    },
  },
  {
    name: 'transaction 抛错要整笔回滚',
    run(db) {
      fresh(db, 'c_tx', 'id TEXT PRIMARY KEY NOT NULL')
      const ins = db.prepare('INSERT INTO c_tx (id) VALUES (?)')
      ins.run('kept')
      let threw = false
      try {
        db.transaction(() => {
          ins.run('rolled-back')
          throw new Error('boom')
        })
      } catch {
        threw = true
      }
      assert(threw, 'transaction 里的错要原样抛出来')
      const n = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM c_tx').get()?.n
      assertEqual(n, 1, '回滚之后只剩事务之前那一行')
    },
  },
  {
    name: 'transaction 正常跑完要提交，并把回调的返回值带出来',
    run(db) {
      fresh(db, 'c_tx_ok', 'id TEXT PRIMARY KEY NOT NULL')
      const out = db.transaction(() => {
        db.prepare('INSERT INTO c_tx_ok (id) VALUES (?)').run('a')
        return 'done'
      })
      assertEqual(out, 'done', 'transaction 的返回值')
      assertEqual(
        db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM c_tx_ok').get()?.n,
        1,
        '提交了',
      )
    },
  },
  {
    name: '唯一键冲突要抛（幂等靠它）',
    run(db) {
      fresh(db, 'c_uniq', 'id TEXT PRIMARY KEY NOT NULL, ref TEXT')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS c_uniq_ref ON c_uniq (ref) WHERE ref IS NOT NULL;')
      const ins = db.prepare('INSERT INTO c_uniq (id, ref) VALUES (?, ?)')
      ins.run('a', 'order-1')
      let threw = false
      try {
        ins.run('b', 'order-1')
      } catch {
        threw = true
      }
      assert(threw, '同一个 source_ref 第二次入账要抛')
    },
  },
  {
    name: 'ON CONFLICT DO UPDATE（幂等表 put 靠它）',
    run(db) {
      fresh(db, 'c_upsert', 'k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL')
      const put = db.prepare(
        'INSERT INTO c_upsert (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      )
      put.run('a', 'one')
      put.run('a', 'two')
      assertEqual(
        db.prepare<{ v: string }>('SELECT v FROM c_upsert WHERE k = ?').get('a')?.v,
        'two',
        'upsert 覆盖',
      )
    },
  },
  {
    name: 'INTEGER PRIMARY KEY AUTOINCREMENT 能用（计量事件那张表）',
    run(db) {
      db.exec(`
DROP TABLE IF EXISTS c_auto;
CREATE TABLE c_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL);
`)
      const ins = db.prepare('INSERT INTO c_auto (v) VALUES (?)')
      ins.run('a')
      ins.run('b')
      const ids = db
        .prepare<{ id: number }>('SELECT id FROM c_auto ORDER BY id')
        .all()
        .map((r) => r.id)
      assertEqual(ids, [1, 2], '自增主键')
    },
  },
  {
    name: 'MAX(0, x - y) 与聚合（扣费与余额靠它）',
    run(db) {
      fresh(db, 'c_agg', 'id TEXT PRIMARY KEY NOT NULL, remaining REAL NOT NULL')
      const ins = db.prepare('INSERT INTO c_agg (id, remaining) VALUES (?, ?)')
      ins.run('a', 5)
      ins.run('b', 3)
      db.prepare('UPDATE c_agg SET remaining = MAX(0, remaining - ?) WHERE id = ?').run(9, 'a')
      assertEqual(
        db.prepare<{ s: number }>('SELECT SUM(remaining) AS s FROM c_agg').get()?.s,
        3,
        '扣不成负数',
      )
    },
  },
]

/** 跑一遍全套；每条用例失败时把名字带上。 */
export function runSyncDbContract(open: () => SyncDb): void {
  for (const c of SYNC_DB_CONTRACT) {
    const db = open()
    try {
      c.run(db)
    } catch (err) {
      throw new Error(`[${c.name}] ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
