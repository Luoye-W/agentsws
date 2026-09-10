/**
 * 迁移器：WP40 起**用共用的那一份**（`@agentsws/core/sql`），本文件只剩转接。
 *
 * 共用之后多了两件事，行为上都更好：
 * - 版本表与待跑计算与 kernel / data 同一套，三个包不会各写各的
 * - **一次一事务**（原来是全部一个事务）：第 3 版失败不会把已经成功的第 1、2 版回滚掉，
 *   也不会留下半张表
 *
 * 仍然是**每个包一张自己的 `_migrations`**（35 §2）：SQLite 档下一个包一个库文件，
 * Postgres 档下一个包一个 schema，表名逐字相同。
 */
import type { Migration, SyncSqlDriver } from '@agentsws/core/sql'
import { migrateSync, schemaVersionSync } from '@agentsws/core/sql'

export type { Migration } from '@agentsws/core/sql'

/** 跑到最新版；返回本次实际补跑的版本号（已是最新则空数组）。 */
export function migrate(
  driver: SyncSqlDriver,
  migrations: readonly Migration[],
  at: string,
): number[] {
  return migrateSync(driver, migrations, at)
}

/** 已应用的最高版本（0 = 空库）。 */
export function schemaVersion(driver: SyncSqlDriver): number {
  return schemaVersionSync(driver)
}
