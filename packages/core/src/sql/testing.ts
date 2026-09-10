/**
 * 双方言一致性套件的接线（35 §3：同一份用例跑两遍）。
 *
 * 纪律：**Postgres 起不来就跳过，绝不假绿**。跳过时打一行为什么跳过，
 * 免得 CI 上「全绿」其实是「一半没跑」。CI 里 service container 一定在，
 * 所以那边跳过 = 配置坏了，看得见。
 */
import { randomBytes } from 'node:crypto'
import { openPostgresDriver, type PostgresDriver } from './pg-driver.js'

/** CI 与本机 docker 都用这个环境变量；没有就试本机默认端口。 */
export const TEST_DATABASE_URL_ENV = 'AGENTSWS_TEST_DATABASE_URL'

const FALLBACK_URLS = [
  'postgres://agentsws:agentsws@127.0.0.1:55432/agentsws_test',
  'postgres://postgres:postgres@127.0.0.1:5432/postgres',
]

let probe: Promise<string | undefined> | undefined

/** 能连上的 Postgres URL；一个都连不上返回 undefined（调用方跳过）。 */
export async function postgresTestUrl(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  probe ??= (async () => {
    const configured = env[TEST_DATABASE_URL_ENV]
    for (const url of configured === undefined ? FALLBACK_URLS : [configured]) {
      try {
        const driver = await openPostgresDriver({ url, max: 1, connectTimeout: 3 })
        await driver.close()
        return url
      } catch {
        // 下一个
      }
    }
    return undefined
  })()
  return probe
}

/**
 * 一次性 schema 里的驱动：同一个库上并行跑好几个套件也不打架，
 * `dispose` 把 schema 连表一起删掉。
 */
export interface ScratchPostgres {
  driver: PostgresDriver
  schema: string
  dispose(): Promise<void>
}

export async function openScratchPostgres(url: string, prefix = 'test'): Promise<ScratchPostgres> {
  const schema = `${prefix}_${randomBytes(6).toString('hex')}`
  const driver = await openPostgresDriver({ url, schema, max: 4 })
  return {
    driver,
    schema,
    async dispose(): Promise<void> {
      try {
        await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      } finally {
        await driver.close()
      }
    },
  }
}
