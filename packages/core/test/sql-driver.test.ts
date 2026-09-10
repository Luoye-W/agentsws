/**
 * SQL 驱动抽象的一致性套件（WP40 §1）。
 *
 * 同一份用例对 SQLite 与 Postgres 各跑一遍——这就是「换存储后端不改服务进程」的
 * 最小可证明单位。Postgres 起不来就整段跳过并说明（见 `postgresTestUrl`）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  describeUrl,
  dialectOf,
  dialectRules,
  jsonExtract,
  type Migration,
  mapCode,
  migrate,
  openSqliteDriver,
  rewritePlaceholders,
  type SqlDriver,
  schemaVersion,
  splitStatements,
  sqlitePath,
  translateSql,
  upsert,
} from '../src/sql/index.js'
import { openScratchPostgres, postgresTestUrl } from '../src/sql/testing.js'

describe('占位符改写', () => {
  it('`?` 变 `$n`，字面量与注释里的问号不动', () => {
    expect(rewritePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    )
    expect(rewritePlaceholders("SELECT '? ?' , ? FROM t")).toBe("SELECT '? ?' , $1 FROM t")
    expect(rewritePlaceholders('-- ? \nSELECT ?')).toBe('-- ? \nSELECT $1')
    expect(rewritePlaceholders('/* ? */ SELECT ?')).toBe('/* ? */ SELECT $1')
    expect(rewritePlaceholders('SELECT "a?b" , ?')).toBe('SELECT "a?b" , $1')
  })

  it("`''` 是转义的单引号，不是字符串结束", () => {
    expect(rewritePlaceholders("SELECT 'it''s ?' , ?")).toBe("SELECT 'it''s ?' , $1")
  })
})

describe('方言表', () => {
  it('SQLite 是规范形态：一个字都不翻', () => {
    const ddl = 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, b BLOB) STRICT;'
    expect(translateSql(ddl, 'sqlite')).toBe(ddl)
  })

  it('Postgres：自增主键 / BLOB / INTEGER / STRICT / datetime', () => {
    const out = translateSql(
      `CREATE TABLE t (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  n   INTEGER NOT NULL,
  b   BLOB,
  at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;`,
      'postgres',
    )
    expect(out).toContain('BIGSERIAL PRIMARY KEY')
    expect(out).toContain('n   BIGINT NOT NULL')
    expect(out).toContain('b   BYTEA')
    expect(out).toContain("now() at time zone 'utc'")
    expect(out).not.toContain('STRICT')
  })

  it('字符串字面量里的类型名不被改写', () => {
    expect(translateSql("INSERT INTO t (k) VALUES ('INTEGER BLOB')", 'postgres')).toBe(
      "INSERT INTO t (k) VALUES ('INTEGER BLOB')",
    )
  })

  it('类型名规则只在 DDL 里跑：DML 里的同名列不被改成类型名', () => {
    expect(translateSql('INSERT INTO t (blob, n) VALUES (?, ?)', 'postgres')).toBe(
      'INSERT INTO t (blob, n) VALUES (?, ?)',
    )
    expect(translateSql('SELECT blob FROM t', 'postgres')).toBe('SELECT blob FROM t')
  })

  it('方言表每条都有一句为什么（文档即测试）', () => {
    for (const rule of dialectRules()) expect(rule.why.length).toBeGreaterThan(0)
  })

  it('json 取字段两边各一套写法；字段名非法直接抛', () => {
    expect(jsonExtract('sqlite', 'body', 'city')).toBe("json_extract(body, '$.city')")
    expect(jsonExtract('postgres', 'body', 'city')).toBe("(body::jsonb ->> 'city')")
    expect(() => jsonExtract('postgres', 'body', "a'; DROP")).toThrow(/illegal json field/)
  })

  it('upsert 用两边都懂的 ON CONFLICT', () => {
    expect(upsert('t', ['id', 'v'], ['id'])).toBe(
      'INSERT INTO t ("id", "v") VALUES (?, ?) ON CONFLICT ("id") DO UPDATE SET "v" = excluded."v"',
    )
  })
})

describe('URL 解析', () => {
  it('认得出方言', () => {
    expect(dialectOf('postgres://u:p@h/db')).toBe('postgres')
    expect(dialectOf('postgresql://u:p@h/db')).toBe('postgres')
    expect(dialectOf('/var/lib/agentsws/kernel.db')).toBe('sqlite')
    expect(dialectOf('sqlite:/tmp/a.db')).toBe('sqlite')
    expect(() => dialectOf('mysql://h/db')).toThrow(/unsupported storage url scheme/)
  })

  it('SQLite 路径', () => {
    expect(sqlitePath('sqlite:/tmp/a.db')).toBe('/tmp/a.db')
    expect(sqlitePath('/tmp/a.db')).toBe('/tmp/a.db')
    expect(sqlitePath(':memory:')).toBe(':memory:')
  })

  it('后端描述不含凭据', () => {
    const d = describeUrl('postgres://user:hunter2@db.example.com:5432/agentsws')
    expect(d.display).toBe('db.example.com:5432/agentsws')
    expect(d.display).not.toContain('hunter2')
    expect(d.display).not.toContain('user')
  })
})

describe('语句切分', () => {
  it('分号在字面量与美元引号里不算数', () => {
    expect(splitStatements("SELECT ';' ; SELECT 2")).toEqual(["SELECT ';'", 'SELECT 2'])
    expect(
      splitStatements('CREATE FUNCTION f() AS $$ BEGIN; END; $$ LANGUAGE plpgsql; SELECT 1'),
    ).toHaveLength(2)
  })

  it('mapCode 只碰代码段', () => {
    expect(mapCode("a 'b' c", (s) => s.toUpperCase())).toBe("A 'b' C")
  })
})

// ── 两个方言各跑一遍的驱动一致性套件 ────────────────────────────────────

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS things (
  id    TEXT PRIMARY KEY NOT NULL,
  n     INTEGER NOT NULL,
  blob  BLOB,
  body  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS things_by_n ON things (n);`,
  },
  {
    version: 2,
    sql: `CREATE TABLE IF NOT EXISTS more (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  v  TEXT NOT NULL
) STRICT;`,
  },
]

const pgUrl = await postgresTestUrl()
const disposers: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const dispose of disposers) await dispose()
})

async function sqliteDriver(): Promise<SqlDriver> {
  return openSqliteDriver({ path: ':memory:' })
}

async function pgDriver(): Promise<SqlDriver> {
  const scratch = await openScratchPostgres(pgUrl as string, 'coresql')
  disposers.push(() => scratch.dispose())
  return scratch.driver
}

const BACKENDS: { name: string; open: () => Promise<SqlDriver>; skip: boolean }[] = [
  { name: 'sqlite', open: sqliteDriver, skip: false },
  { name: 'postgres', open: pgDriver, skip: pgUrl === undefined },
]

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`驱动一致性 · ${backend.name}`, () => {
    it('迁移：幂等、一次一事务、版本号可读', async () => {
      const driver = await backend.open()
      expect(await schemaVersion(driver)).toBe(0)
      expect(await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')).toEqual([1, 2])
      expect(await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')).toEqual([])
      expect(await schemaVersion(driver)).toBe(2)
      if (backend.name === 'sqlite') await driver.close()
    })

    it('参数化读写：占位符、字节列、changes', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')
      const insert = driver.prepare('INSERT INTO things (id, n, blob, body) VALUES (?, ?, ?, ?)')
      const written = await insert.run('a', 42, new Uint8Array([1, 2, 3]), '{"city":"深圳"}')
      expect(written.changes).toBe(1)

      const row = await driver
        .prepare<{ id: string; n: number; blob: Uint8Array; body: string }>(
          'SELECT id, n, blob, body FROM things WHERE id = ?',
        )
        .get('a')
      expect(row?.n).toBe(42)
      expect([...(row?.blob ?? [])]).toEqual([1, 2, 3])
      expect(JSON.parse(row?.body ?? '{}')).toEqual({ city: '深圳' })

      const updated = await driver.prepare('UPDATE things SET n = ? WHERE id = ?').run(7, 'a')
      expect(updated.changes).toBe(1)
      const missed = await driver.prepare('UPDATE things SET n = ? WHERE id = ?').run(7, 'nope')
      expect(missed.changes).toBe(0)
      if (backend.name === 'sqlite') await driver.close()
    })

    it('JSON 过滤：同一段业务代码，两边各自的写法', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')
      await driver
        .prepare('INSERT INTO things (id, n, body) VALUES (?, ?, ?)')
        .run('b', 1, JSON.stringify({ city: '广州' }))
      const rows = await driver
        .prepare<{ id: string }>(
          `SELECT id FROM things WHERE ${jsonExtract(driver.dialect, 'body', 'city')} = ?`,
        )
        .all('广州')
      expect(rows.map((r) => r.id)).toEqual(['b'])
      if (backend.name === 'sqlite') await driver.close()
    })

    it('事务：回调抛错整段回滚', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')
      await expect(
        driver.transaction(async (tx) => {
          await tx.prepare('INSERT INTO things (id, n, body) VALUES (?, ?, ?)').run('t1', 1, '{}')
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      const after = await driver.prepare<{ id: string }>('SELECT id FROM things').all()
      expect(after.map((r) => r.id)).not.toContain('t1')

      await driver.transaction(async (tx) => {
        await tx.prepare('INSERT INTO things (id, n, body) VALUES (?, ?, ?)').run('t2', 1, '{}')
      })
      expect(
        (await driver.prepare<{ id: string }>('SELECT id FROM things').all()).map((r) => r.id),
      ).toContain('t2')
      if (backend.name === 'sqlite') await driver.close()
    })

    it('自增主键在两边都自增', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')
      await driver.prepare('INSERT INTO more (v) VALUES (?)').run('x')
      await driver.prepare('INSERT INTO more (v) VALUES (?)').run('y')
      const rows = await driver
        .prepare<{ id: number; v: string }>('SELECT id, v FROM more ORDER BY id')
        .all()
      expect(rows.map((r) => r.v)).toEqual(['x', 'y'])
      expect(Number(rows[1]?.id)).toBeGreaterThan(Number(rows[0]?.id))
      if (backend.name === 'sqlite') await driver.close()
    })

    it('upsert 两边同一句', async () => {
      const driver = await backend.open()
      await migrate(driver, MIGRATIONS, '2026-09-10T00:00:00.000Z')
      const sql = upsert('things', ['id', 'n', 'body'], ['id'])
      await driver.prepare(sql).run('u', 1, '{}')
      await driver.prepare(sql).run('u', 2, '{}')
      const row = await driver.prepare<{ n: number }>('SELECT n FROM things WHERE id = ?').get('u')
      expect(Number(row?.n)).toBe(2)
      if (backend.name === 'sqlite') await driver.close()
    })
  })
}

if (pgUrl === undefined) {
  console.warn(
    `[WP40] Postgres 用例已跳过：没有可连的库。设 ${'AGENTSWS_TEST_DATABASE_URL'} 或起 docker compose --profile postgres。`,
  )
}
