/**
 * 共用迁移器（21 §5 / 35 §2「每个包一张自己的 `_migrations`」）。
 *
 * 与各包原来内嵌的那份行为一致，只多了两件事：
 * - 跑在 {@link SqlDriver} 上，SQLite / Postgres 同一份迁移集（DDL 经方言表翻译）
 * - **一次一事务**：第 3 版失败不会把第 4 版的半张表留在库里，
 *   也不会把已经成功的第 1、2 版回滚掉（原来的做法是全部一个事务）
 */
import { translateSql } from './dialect.js'
import type { SqlDriver } from './driver.js'

export interface Migration {
  version: number
  sql: string
}

export interface MigrateOptions {
  /** 版本表名；默认 `_migrations`。Postgres 档下靠 schema 隔离，名字不用改。 */
  table?: string
}

const DEFAULT_TABLE = '_migrations'

function versionTable(table: string): string {
  return `CREATE TABLE IF NOT EXISTS "${table}" (
  version    INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT`
}

/** 跑到最新版；返回本次实际补跑的版本号（已是最新则空数组）。幂等。 */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly Migration[],
  at: string,
  options: MigrateOptions = {},
): Promise<number[]> {
  const table = options.table ?? DEFAULT_TABLE
  await driver.exec(translateSql(versionTable(table), driver.dialect))
  const done = new Set(
    (await driver.prepare<{ version: number }>(`SELECT version FROM "${table}"`).all()).map((r) =>
      Number(r.version),
    ),
  )
  const pending = [...migrations]
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version)

  const applied: number[] = []
  for (const m of pending) {
    // 一次一事务：中途失败不留半张表，已成功的版本也不回头
    await driver.transaction(async (tx) => {
      await tx.exec(m.sql)
      await tx
        .prepare(`INSERT INTO "${table}" (version, applied_at) VALUES (?, ?)`)
        .run(m.version, at)
    })
    applied.push(m.version)
  }
  return applied
}

/** 已应用的最高版本（0 = 空库）。 */
export async function schemaVersion(
  driver: SqlDriver,
  options: MigrateOptions = {},
): Promise<number> {
  const table = options.table ?? DEFAULT_TABLE
  await driver.exec(translateSql(versionTable(table), driver.dialect))
  const row = await driver
    .prepare<{ v: number | null }>(`SELECT MAX(version) AS v FROM "${table}"`)
    .get()
  return row?.v === null || row?.v === undefined ? 0 : Number(row.v)
}
