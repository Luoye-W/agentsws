/**
 * 49 M3「一个薄网关」的装配。
 *
 * 这个进程只有两件事是自己的：**账号层**（账号 / 隐式组织 / magic link / 会话）
 * 与**工作区关联**（签发 / 续期 / 撤销 / 列表 / 验证）。别的能力——WP59 的
 * `/v1/ai/*` 与 `/v1/wallet/*`、WP60 的 `/v1/standby`——以**路由包**形式挂进来：
 *
 * ```ts
 * createCloudServer({ modules: [entryRoutes({ wallet, pricing })] })
 * ```
 *
 * 所以这里留了一个显式的挂载点 `modules: CloudRoute[][]`，默认只挂自己那几条。
 * 网关不认识任何模块的形状（路由包自己把依赖闭包进去），于是"合并时挂进来"
 * 真的只是往数组里多塞一个元素。
 *
 * 鉴权三档（`cloud-route.ts` 的 `CloudAuth`）在这里落地：
 * - `public`：什么都不看；
 * - `session`：`Authorization: Bearer cs_…` → 账号 + 组织；
 * - `workspace_token`：`Authorization: Bearer wst_…` → `CloudTokenVerifier`，
 *   再按路由声明的 `scopes` 逐个比对（18 §1 最小动作集：差一个就 403）。
 */

import { join } from 'node:path'
import {
  type CloudEnv,
  type CloudRoute,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  MemoryIdempotencyStore,
  type OpenApiDocument,
  SqliteIdempotencyStore,
  type SweepableIdempotencyStore,
} from '@agentsws/api'
import { type Clock, type CloudTokenVerifier, cloudBaseUrl } from '@agentsws/contracts'
import { type ServerType, serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { buildCloudApp } from './app.js'
import { createMagicLinkLimiter, type MagicLinkLimiter } from './guards.js'
import type { MailSender } from './mail.js'
import { mailSenderFromEnv } from './mail-smtp.js'
import type { CloudHealthState } from './routes/health.js'
import type { CloudStore } from './store.js'
import { cloudDbPath, createCloudStore } from './store-node.js'

/** 云侧默认端口。与本地服务进程（3000 档）离得远，同机跑两个不打架。 */
export const DEFAULT_CLOUD_PORT = 4400
export const CLOUD_PORT_ENV = 'AGENTSWS_CLOUD_PORT'
export const CLOUD_DATA_DIR_ENV = 'AGENTSWS_CLOUD_DATA_DIR'
/** 幂等表的库文件（与账号 / 钱包 / 值守 / 红人库各开各的）。 */
export const IDEMPOTENCY_DB_FILE = 'idempotency.sqlite'
/**
 * 云的对外地址与它的环境变量名。**定义在 `@agentsws/contracts`**（WP110 收成一处），
 * 这里只转出去——`apps/cloud` 的调用方一直是从这个模块 import 的，签名不动。
 */
export { CLOUD_BASE_URL_ENV, DEFAULT_CLOUD_BASE_URL } from '@agentsws/contracts'
/**
 * 路由表、鉴权与两页网页的装配搬去了 `app.ts`（WP114：Workers 形态要用同一份）。
 * 这几个名字从这里原样转出去——调用方一直是从 `server.ts` import 的。
 */
export {
  buildCloudApp,
  buildCloudOpenApi,
  type CloudApp,
  type CloudAppDeps,
  collectCloudRoutes,
  createCloudHono,
  LEGACY_LOGIN_PATH,
  LOGIN_PATH,
} from './app.js'
export const HOST = '0.0.0.0'

export interface CloudServerOptions {
  /** SQLite 目录（`AGENTSWS_CLOUD_DATA_DIR`）；不给就内存档。**与本地服务进程完全分开。** */
  dataDir?: string
  env?: Record<string, string | undefined>
  clock?: Clock
  port?: number
  quiet?: boolean
  /** 邮件投递；不给按环境变量选（开发档 = 打到 stdout）。 */
  mail?: MailSender
  /**
   * 49 M3：别的能力以路由包形式挂进来（WP59 的服务入口、WP60 的值守）。
   * 默认空——这个进程只做账号与令牌。
   */
  modules?: CloudRoute[][]
  /** 随机源注入（测试用；同一个种子跑出同一串 id）。 */
  randomBytes?: (n: number) => Buffer
  version?: string
  /**
   * WP110 幂等表。不给就按 `dataDir` 选：有目录 = sqlite（重启之后重放还认），
   * 没目录 = 内存（测试）。
   */
  idempotencyStore?: SweepableIdempotencyStore
  idempotencyTtlMs?: number
  /** WP110 magic-link 限流；不给就是每邮箱 5 次 / 小时、每 IP 20 次 / 小时。 */
  limiter?: MagicLinkLimiter
}

export interface CloudServer {
  app: Hono<CloudEnv>
  store: CloudStore
  /** 49 M3 的服务入口只依赖这一个纯函数。 */
  verifyToken: CloudTokenVerifier
  routes: CloudRoute[]
  openapi: OpenApiDocument
  baseUrl: string
  /** 已监听时的 URL（listen 之后才有）。 */
  url?: string | undefined
  fetch: (request: Request) => Response | Promise<Response>
  /**
   * WP110：这个节点挂了哪些模块、上游通不通。装配方（`index.ts`）挂完模块之后
   * 往里写，`/v1/cloud/health` 与首页读同一个对象——**不是快照**，因为路由是在
   * 挂模块之前就收集好的。
   */
  health: CloudHealthState
  /** WP110：幂等表（定时清理要它）。 */
  idempotency: SweepableIdempotencyStore
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

export function createCloudServer(options: CloudServerOptions = {}): CloudServer {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const version = options.version ?? env.AGENTSWS_VERSION ?? '0.1.0'
  const dataDir = options.dataDir ?? env[CLOUD_DATA_DIR_ENV]
  const baseUrl = cloudBaseUrl(env)
  const store = createCloudStore({
    dbPath: cloudDbPath(dataDir),
    clock,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  })
  const mail = options.mail ?? mailSenderFromEnv(env)
  /*
   * 健康状态是一个**活对象**：路由在这里就收集完了，而模块（入口 / 值守 / 红人库）
   * 要等 `index.ts` 往 `server.app` 上挂。挂完之后往这个对象里写一个 true，
   * `/v1/cloud/health` 与首页当场就看得见。
   */
  const health: CloudHealthState = { modules: {} }
  const limiter = options.limiter ?? createMagicLinkLimiter()
  const idempotency =
    options.idempotencyStore ??
    (dataDir === undefined || dataDir.trim() === ''
      ? new MemoryIdempotencyStore(options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS)
      : new SqliteIdempotencyStore({
          dbPath: join(dataDir, IDEMPOTENCY_DB_FILE),
          ttlMs: options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
          clock,
        }))

  const { app, routes, openapi, verifyToken } = buildCloudApp({
    store,
    clock,
    mail,
    baseUrl,
    version,
    health,
    limiter,
    idempotency,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  })

  let httpServer: ServerType | undefined
  let boundUrl: string | undefined
  let closed = false

  const server: CloudServer = {
    app,
    store,
    verifyToken,
    routes,
    openapi,
    baseUrl,
    health,
    idempotency,
    get url() {
      return boundUrl
    },
    fetch: (request: Request) => app.fetch(request),
    async listen(port?: number) {
      const wanted =
        port ??
        options.port ??
        Number(env[CLOUD_PORT_ENV] ?? DEFAULT_CLOUD_PORT) ??
        DEFAULT_CLOUD_PORT
      const bound = await new Promise<number>((resolve) => {
        httpServer = serve({ fetch: app.fetch, hostname: HOST, port: wanted }, (info) => {
          resolve(info.port)
        })
      })
      boundUrl = `http://${HOST}:${String(bound)}`
      if (options.quiet !== true)
        process.stdout.write(`agentsws cloud 起来了：${boundUrl}/v1/cloud/health\n`)
      return { url: boundUrl, port: bound }
    },
    async close() {
      if (closed) return
      closed = true
      if (httpServer !== undefined)
        await new Promise<void>((resolve) => {
          httpServer?.close(() => {
            resolve()
          })
        })
      store.close()
      if (idempotency instanceof SqliteIdempotencyStore) idempotency.close()
    },
  }
  return server
}
