/**
 * 48 §5.3 / 49 §6 WP61：把公共红人库（`packages/kol-public`）挂进这个进程。
 *
 * 写法照着 `standby.ts` —— 公共库也有自己的一套鉴权（工作区令牌 + `data` 动作集，
 * 外加插件那把 `plg_…`）与错误码表（402 钱不够 / 429 配额到顶 / 404 库里还没有这个人），
 * 与账号层的 `CloudRoute` 形状不同。
 *
 * 这个文件负责三件"只有装配方知道"的事：
 *
 * 1. **库开在哪**：`<AGENTSWS_CLOUD_DATA_DIR>/kol-public.sqlite`，
 *    与账号库、钱包库、值守库各开各的文件（同一个目录，互不写对方的表）；
 * 2. **密钥从哪来**：邮箱密文那把只从环境变量读（`AGENTSWS_KOL_EMAIL_KEY`），
 *    而且是在 `nodeKolSecrets` 里取一次就不再露面——它不进配置对象、不进日志；
 * 3. **外部源配了哪几个**：有 `AGENTSWS_YOUTUBE_API_KEY` 才有官方口，
 *    有 `APIFY_TOKEN` 才有降级。**一个都没有也要能起**——那就是"只查库"。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Clock, CloudTokenVerifier, Pricing } from '@agentsws/contracts'
import {
  apifySource,
  createQuotaPool,
  KOL_ENV,
  type KolEnv,
  KolPublicService,
  type KolSecrets,
  type KolSource,
  type KolStore,
  MemoryKolStore,
  mountKolPublicRoutes,
  nodeKolSecrets,
  type SourceLookup,
  SqliteKolStore,
  sourcePoolFromParts,
  youtubeSource,
} from '@agentsws/kol-public'
import type { Wallet } from '@agentsws/metering'
import type { Database } from 'better-sqlite3'
import type { Hono } from 'hono'
import type { CloudServer } from './server.js'

/** 公共库的库文件名（与账号 / 钱包 / 值守各开各的）。 */
export const KOL_DB_FILE = 'kol-public.sqlite'

export interface MountKolPublicOptions {
  env?: Record<string, string | undefined>
  clock?: Clock
  wallet: Wallet
  pricing: Pricing
  /** 云侧数据目录；不给就内存档（测试）。 */
  dataDir?: string
  /** 已有的库（测试注入内存版）。给了就不按 `dataDir` 开库。 */
  store?: KolStore
  /** 哈希 / 随机 / 加密那一跳；不给就按环境变量拼一个。 */
  secrets?: KolSecrets
  /** 外部源；不给就按环境变量拼（一个都没配就是"只查库"）。 */
  sources?: SourceLookup
  /** 验令牌用哪一个。不给就是 WP58 的账号库那个。 */
  verifier?: CloudTokenVerifier
  newId?: (prefix: string) => string
}

export interface MountedKolPublic {
  service: KolPublicService
  store: KolStore
  close(): void
}

/** better-sqlite3 只在这一处出现（`packages/kol-public` 自己不依赖它）。 */
function openKolDb(path: string): Database {
  const require = createRequire(import.meta.url)
  const Ctor = require('better-sqlite3') as new (p: string) => Database
  const db = new Ctor(path)
  db.pragma('journal_mode = WAL')
  return db
}

export function kolDbPath(dataDir: string | undefined): string | undefined {
  if (dataDir === undefined || dataDir.trim() === '') return undefined
  return join(dataDir, KOL_DB_FILE)
}

/**
 * 按环境变量拼外部源。
 *
 * 没有 key 就**没有那个源**，而不是一个会在运行时报错的空壳——
 * "今天配额用完了"与"这个功能没配"是两句不同的人话，用户要能分得开。
 */
export function sourcesFromEnv(
  env: Record<string, string | undefined>,
  store: KolStore,
): SourceLookup {
  const unitsRaw = Number(env[KOL_ENV.youtubeUnitsPerDay])
  const quota = createQuotaPool({
    store,
    ...(Number.isFinite(unitsRaw) && unitsRaw > 0 ? { unitsPerDay: unitsRaw } : {}),
  })
  const youtube: KolSource | undefined =
    env[KOL_ENV.youtubeApiKey] === undefined
      ? undefined
      : youtubeSource({ apiKey: () => env[KOL_ENV.youtubeApiKey] })
  const apify: KolSource | undefined =
    env[KOL_ENV.apifyToken] === undefined
      ? undefined
      : apifySource({ token: () => env[KOL_ENV.apifyToken] })
  return sourcePoolFromParts({
    quota,
    ...(youtube === undefined ? {} : { youtube }),
    ...(apify === undefined ? {} : { apify }),
  })
}

/** 把公共红人库挂到 `server.app` 上。 */
export function mountKolPublic(
  server: CloudServer,
  options: MountKolPublicOptions,
): MountedKolPublic {
  const env = options.env ?? process.env
  const now = (): string => (options.clock ?? { now: () => new Date().toISOString() }).now()
  const dbPath = options.store === undefined ? kolDbPath(options.dataDir) : undefined
  const db = dbPath === undefined ? undefined : openKolDb(dbPath)
  const store: KolStore =
    options.store ?? (db === undefined ? new MemoryKolStore() : new SqliteKolStore(db))
  const secrets = options.secrets ?? nodeKolSecrets({ env })
  let seq = 0
  const service = new KolPublicService({
    store,
    wallet: options.wallet,
    pricing: options.pricing,
    secrets,
    now,
    newId:
      options.newId ??
      ((prefix) => `${prefix}_${now().replace(/\D/g, '').slice(0, 14)}_${String(++seq)}`),
    sources: options.sources ?? sourcesFromEnv(env, store),
  })

  // 两个 Hono 环境只差 `Variables` 的形状；各自的中间件只读自己 set 的那几个键
  mountKolPublicRoutes(server.app as unknown as Hono<KolEnv>, {
    service,
    verifier: options.verifier ?? server.verifyToken,
  })

  return {
    service,
    store,
    close() {
      store.close?.()
    },
  }
}
