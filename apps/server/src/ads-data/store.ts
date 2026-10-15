/**
 * WP315：看数据的库（每品牌一份 `<品牌目录>/ads-data.sqlite`；没有目录 = 内存）。
 *
 * 三张表：按天的表现行（`rows`）、每次导入的记录（`imports`）、这个品牌的看数据状态（`state`：账户、
 * 「工坊日报」建没建、今天导出没有、邮箱里读过哪几封）。
 *
 * 行的身份 = 平台 | 账户 | 日期 | 对象键（`adsRowKey`）：同一天同一对象再导一次就覆盖（平台会回补转化）；
 * 一次导入覆盖的那几天、那一层，先清掉旧的再写（导出里没了的对象不该还挂着）。只留最近 90 天。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { AdsReportLevel, AdsReportRow } from '@agentsws/ads-core'
import type BetterSqlite3 from 'better-sqlite3'

/** 看数据只管两家（插件 / 邮箱拿得到导出的那两家）。 */
export type AdsDataPlatform = 'google' | 'meta'
export const ADS_DATA_PLATFORMS: readonly AdsDataPlatform[] = ['google', 'meta']

/** 存下来的一行（多了平台、账户、对象键、出自哪次导入）。`day` 一定有（表里没按天拆的按导入那天记）。 */
export interface AdsDataRow extends AdsReportRow {
  platform: AdsDataPlatform
  account: string
  day: string
  key: string
  import_id: string
}

export type AdsDataSource = 'plugin' | 'email' | 'manual'

export interface AdsDataImport {
  id: string
  platform: AdsDataPlatform
  account: string
  source: AdsDataSource
  /** 文件名（不存路径）。 */
  name: string
  level?: AdsReportLevel
  rows: number
  days: string[]
  at: string
  /** 认不出 / 跳过了什么（照实说）。 */
  notes: string[]
  job_id?: string
  message_id?: string
}

export interface AdsDataStore {
  /** 写一次导入：同平台同账户同层的那几天先清再写。 */
  replace(input: { import: AdsDataImport; rows: AdsDataRow[] }): void
  rows(filter: {
    since: string
    until: string
    platform?: AdsDataPlatform
    levels?: readonly AdsReportLevel[]
  }): AdsDataRow[]
  imports(filter?: { platform?: AdsDataPlatform; limit?: number }): AdsDataImport[]
  getState<T>(key: string): T | undefined
  setState(key: string, value: unknown): void
  /** 删掉某天之前的行（保留期）。 */
  prune(beforeDay: string): void
  close(): void
}

export const ADS_DATA_KEEP_DAYS = 90

const rowId = (r: AdsDataRow): string => `${r.platform}|${r.account}|${r.day}|${r.key}`

export function createAdsDataStore(options: { dbDir?: string }): AdsDataStore {
  return options.dbDir === undefined
    ? memoryStore()
    : sqliteStore(join(options.dbDir, 'ads-data.sqlite'))
}

function memoryStore(): AdsDataStore {
  const rows = new Map<string, AdsDataRow>()
  const imports: AdsDataImport[] = []
  const state = new Map<string, unknown>()
  return {
    replace({ import: imp, rows: list }) {
      const levels = new Set(list.map((r) => r.level))
      for (const [id, r] of rows)
        if (
          r.platform === imp.platform &&
          r.account === imp.account &&
          levels.has(r.level) &&
          imp.days.includes(r.day)
        )
          rows.delete(id)
      for (const r of list) rows.set(rowId(r), structuredClone(r))
      imports.push(structuredClone(imp))
    },
    rows: (f) =>
      [...rows.values()]
        .filter((r) => r.day >= f.since && r.day <= f.until)
        .filter((r) => f.platform === undefined || r.platform === f.platform)
        .filter((r) => f.levels === undefined || f.levels.includes(r.level))
        .map((r) => structuredClone(r)),
    imports: (f) =>
      imports
        .filter((i) => f?.platform === undefined || i.platform === f.platform)
        .slice()
        .reverse()
        .slice(0, f?.limit ?? 50),
    getState: <T>(key: string) => structuredClone(state.get(key)) as T | undefined,
    setState: (key, value) => {
      state.set(key, structuredClone(value))
    },
    prune(beforeDay) {
      for (const [id, r] of rows) if (r.day < beforeDay) rows.delete(id)
    },
    close() {},
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ads_data_rows (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, day TEXT NOT NULL,
  level TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ads_data_rows_day ON ads_data_rows (day);
CREATE TABLE IF NOT EXISTS ads_data_imports (id TEXT PRIMARY KEY, platform TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ads_data_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);
`

function sqliteStore(path: string): AdsDataStore {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const del = db.prepare(
    'DELETE FROM ads_data_rows WHERE platform = ? AND account = ? AND level = ? AND day = ?',
  )
  const put = db.prepare(
    `INSERT INTO ads_data_rows (id, platform, account, day, level, json) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, level = excluded.level`,
  )
  const putImport = db.prepare(
    'INSERT OR REPLACE INTO ads_data_imports (id, platform, at, json) VALUES (?,?,?,?)',
  )
  const replace = db.transaction((imp: AdsDataImport, list: AdsDataRow[]) => {
    const levels = [...new Set(list.map((r) => r.level))]
    for (const level of levels)
      for (const day of imp.days) del.run(imp.platform, imp.account, level, day)
    for (const r of list)
      put.run(rowId(r), r.platform, r.account, r.day, r.level, JSON.stringify(r))
    putImport.run(imp.id, imp.platform, imp.at, JSON.stringify(imp))
  })
  return {
    replace: ({ import: imp, rows }) => {
      replace(imp, rows)
    },
    rows(f) {
      const where = ['day >= ?', 'day <= ?']
      const args: string[] = [f.since, f.until]
      if (f.platform !== undefined) {
        where.push('platform = ?')
        args.push(f.platform)
      }
      if (f.levels !== undefined && f.levels.length > 0) {
        where.push(`level IN (${f.levels.map(() => '?').join(',')})`)
        args.push(...f.levels)
      }
      return (
        db
          .prepare(`SELECT json FROM ads_data_rows WHERE ${where.join(' AND ')} ORDER BY id`)
          .all(...args) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as AdsDataRow)
    },
    imports(f) {
      const sql =
        f?.platform === undefined
          ? 'SELECT json FROM ads_data_imports ORDER BY at DESC, id DESC LIMIT ?'
          : 'SELECT json FROM ads_data_imports WHERE platform = ? ORDER BY at DESC, id DESC LIMIT ?'
      const args: (string | number)[] =
        f?.platform === undefined ? [f?.limit ?? 50] : [f.platform, f.limit ?? 50]
      return (db.prepare(sql).all(...args) as { json: string }[]).map(
        (r) => JSON.parse(r.json) as AdsDataImport,
      )
    },
    getState<T>(key: string): T | undefined {
      const row = db.prepare('SELECT json FROM ads_data_state WHERE key = ?').get(key) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    setState(key, value) {
      db.prepare(
        'INSERT INTO ads_data_state (key, json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
      ).run(key, JSON.stringify(value))
    },
    prune(beforeDay) {
      db.prepare('DELETE FROM ads_data_rows WHERE day < ?').run(beforeDay)
    },
    close() {
      db.close()
    },
  }
}
