/**
 * 事件日志：SQLite 与 Postgres 各跑一遍同一份一致性套件（WP40 §2）。
 *
 * Postgres 起不来就整段跳过并打一行为什么——「全绿」不能是「一半没跑」。
 */

import { openSqliteDriver, type SqlDriver } from '@agentsws/core/sql'
import { openScratchPostgres, postgresTestUrl } from '@agentsws/core/sql/testing'
import { afterAll } from 'vitest'
import { SqlEventLog } from '../src/sql-event-log.js'
import { deps, runEventLogConformance } from './event-log-conformance.js'

const pgUrl = await postgresTestUrl()
const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup()
})

runEventLogConformance({
  name: 'SqlEventLog · sqlite',
  open: async (schemaVersion?: number) => {
    const driver = openSqliteDriver({ path: ':memory:' })
    const log = await SqlEventLog.open({
      driver,
      ...deps(),
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
    })
    return { log, driver: driver as SqlDriver }
  },
  dispose: async ({ log }) => {
    await log.close()
  },
})

runEventLogConformance({
  name: 'SqlEventLog · postgres',
  skip: pgUrl === undefined,
  open: async (schemaVersion?: number) => {
    const scratch = await openScratchPostgres(pgUrl as string, 'kernel')
    cleanups.push(() => scratch.dispose())
    const log = await SqlEventLog.open({
      driver: scratch.driver,
      ...deps(),
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
    })
    return { log, driver: scratch.driver as SqlDriver }
  },
  dispose: async () => {
    // schema 在 afterAll 里连表一起删
  },
})

if (pgUrl === undefined) {
  console.warn(
    '[WP40] kernel 的 Postgres 一致性用例已跳过：没有可连的库（设 AGENTSWS_TEST_DATABASE_URL，或 docker compose --profile postgres up -d）。',
  )
}
