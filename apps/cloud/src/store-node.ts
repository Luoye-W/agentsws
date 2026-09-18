/**
 * 云侧账号库的**开库那一跳**（Node / Compose 形态）。
 *
 * `better-sqlite3` 在云侧账号层只出现在这一个文件里：路径怎么算、WAL 与外键
 * 怎么开、连接怎么拿。表结构、SQL 与全部语义在 `store.ts`，它只认一张
 * 同步 SQL 口（`@agentsws/core/sql/sync-db` 的 `SyncDb`）——Workers 形态把这一跳
 * 换成 `AccountsDO` 自己的 SQLite，`store.ts` 一个字都不用改（WP114）。
 *
 * 签名没动：`createCloudStore({ dbPath, clock, randomBytes? })` 与
 * `cloudDbPath(dataDir)` 原样在，调用方（`server.ts`）也原样。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import { type SyncDb, syncDbFromBetterSqlite } from '@agentsws/core/sql/sync-db'
import Database from 'better-sqlite3'
import { CloudStore } from './store.js'

export interface CloudStoreOptions {
  /** `cloud.sqlite` 的路径；`:memory:` = 不落盘（测试）。 */
  dbPath: string
  clock: Clock
  /** 随机源注入点（测试用）。默认 `node:crypto` 的 randomBytes。 */
  randomBytes?: (n: number) => Buffer
}

/** `AGENTSWS_CLOUD_DATA_DIR` → `cloud.sqlite` 的路径；不给就内存档。 */
export function cloudDbPath(dataDir: string | undefined): string {
  if (dataDir === undefined || dataDir.trim() === '') return ':memory:'
  mkdirSync(dataDir, { recursive: true })
  return join(dataDir, 'cloud.sqlite')
}

/** 开一张云侧账号库（WAL + 外键），包成同步 SQL 口。 */
export function openCloudDb(dbPath: string): SyncDb {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return syncDbFromBetterSqlite(db)
}

export function createCloudStore(options: CloudStoreOptions): CloudStore {
  return new CloudStore({
    db: openCloudDb(options.dbPath),
    clock: options.clock,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  })
}
