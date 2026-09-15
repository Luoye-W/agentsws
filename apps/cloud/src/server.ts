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

import { randomUUID } from 'node:crypto'
import {
  ApiError,
  buildOpenApi,
  type CloudEnv,
  type CloudRoute,
  errorBody,
  normalizeError,
  type OpenApiDocument,
  toRouteSpec,
} from '@agentsws/api'
import type { Clock, CloudTokenVerifier } from '@agentsws/contracts'
import { type ServerType, serve } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { type MailSender, mailSenderFromEnv } from './mail.js'
import { authRoutes } from './routes/auth.js'
import { cloudHealthRoutes } from './routes/health.js'
import { linkRoutes } from './routes/links.js'
import { type CloudStore, cloudDbPath, createCloudStore } from './store.js'

/** 云侧默认端口。与本地服务进程（3000 档）离得远，同机跑两个不打架。 */
export const DEFAULT_CLOUD_PORT = 4400
export const CLOUD_PORT_ENV = 'AGENTSWS_CLOUD_PORT'
export const CLOUD_DATA_DIR_ENV = 'AGENTSWS_CLOUD_DATA_DIR'
export const CLOUD_BASE_URL_ENV = 'AGENTSWS_CLOUD_BASE_URL'
/** 云的对外地址。现在还不存在——本地测试用 `createCloudServer` 起一个内存版。 */
export const DEFAULT_CLOUD_BASE_URL = 'https://cloud.agentsws.app'
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
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

/** 云侧的全部路由声明（账号 + 关联 + 挂进来的模块）。OpenAPI 与中间件读同一份。 */
export function collectCloudRoutes(
  deps: { store: CloudStore; clock: Clock; mail: MailSender; baseUrl: string; version: string },
  modules: CloudRoute[][] = [],
): CloudRoute[] {
  return [
    ...cloudHealthRoutes({ clock: deps.clock, version: deps.version }),
    ...authRoutes({ store: deps.store, clock: deps.clock, mail: deps.mail, baseUrl: deps.baseUrl }),
    ...linkRoutes({ store: deps.store, clock: deps.clock }),
    ...modules.flat(),
  ]
}

export function buildCloudOpenApi(routes: CloudRoute[], version: string): OpenApiDocument {
  const doc = buildOpenApi(
    routes.map((r) => ({
      spec: toRouteSpec(r.spec),
      // OpenAPI 只读声明，不碰处理器；给一个永远不会被调用的占位
      handler: async () => new Response(null, { status: 501 }),
    })),
    version,
  )
  return {
    ...doc,
    info: {
      ...doc.info,
      title: 'agentsws cloud',
      description:
        '49 M1 / M3：云账号、云侧组织、工作区服务令牌，以及服务入口的挂载点。所有令牌只存 sha256，明文只在签发那一刻返回一次。',
    },
  }
}

export function createCloudServer(options: CloudServerOptions = {}): CloudServer {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const version = options.version ?? env.AGENTSWS_VERSION ?? '0.1.0'
  const dataDir = options.dataDir ?? env[CLOUD_DATA_DIR_ENV]
  const baseUrl = (env[CLOUD_BASE_URL_ENV] ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '')
  const store = createCloudStore({
    dbPath: cloudDbPath(dataDir),
    clock,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  })
  const mail = options.mail ?? mailSenderFromEnv(env)
  const routes = collectCloudRoutes({ store, clock, mail, baseUrl, version }, options.modules)
  const openapi = buildCloudOpenApi(routes, version)
  const verifyToken = store.verifyToken

  const app = new Hono<CloudEnv>()

  const trace: MiddlewareHandler<CloudEnv> = async (c, next) => {
    c.set('cctx', { trace_id: `tr_${randomUUID()}` })
    await next()
    c.header('X-Trace-Id', c.get('cctx').trace_id)
  }
  app.use('*', trace)

  const bearer = (c: {
    req: { header: (n: string) => string | undefined }
  }): string | undefined => {
    const raw = c.req.header('Authorization')
    if (raw === undefined) return undefined
    const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
    return value === '' ? undefined : value
  }

  const sessionAuth: MiddlewareHandler<CloudEnv> = async (c, next) => {
    const token = bearer(c)
    if (token === undefined) throw new ApiError('unauthenticated', '缺少凭据')
    const session = store.session(token)
    if (session === undefined) throw new ApiError('unauthenticated', '会话无效或已过期')
    // 上下文里**不存 token 明文**：没有一条会话路由需要它（注销那条自己从头里取）
    c.set('cctx', {
      ...c.get('cctx'),
      account_id: session.account_id,
      org_id: session.org_id,
    })
    await next()
  }

  const tokenAuth = (route: CloudRoute): MiddlewareHandler<CloudEnv> => {
    return async (c, next) => {
      const raw = bearer(c)
      if (raw === undefined) throw new ApiError('unauthenticated', '缺少工作区服务令牌')
      const verified = await verifyToken(raw)
      // 撤销 / 过期 / 不存在，对外一律同一句话（不给探测口）
      if (verified === undefined) throw new ApiError('unauthenticated', '令牌无效、已过期或已撤销')
      const required = route.spec.scopes ?? []
      const missing = required.filter((s) => !verified.scopes.includes(s))
      if (missing.length > 0)
        throw new ApiError('forbidden', `这把令牌不能做：${missing.join(' / ')}`, {
          // details 里只有动作名，没有令牌、没有哈希、没有组织
          details: { missing },
        })
      const link = store.activeLinkOfWorkspace(verified.workspace_id)
      c.set('cctx', {
        ...c.get('cctx'),
        token: verified,
        ...(link === undefined ? {} : { link_id: link.id }),
      })
      await next()
    }
  }

  for (const r of routes) {
    const chain: MiddlewareHandler<CloudEnv>[] = []
    if (r.spec.auth === 'session') chain.push(sessionAuth)
    if (r.spec.auth === 'workspace_token') chain.push(tokenAuth(r))
    app.on(r.spec.method.toUpperCase(), [r.spec.path], ...chain, (c) => r.handler(c))
  }

  app.get('/openapi.json', (c) => c.json(openapi))
  app.get('/v1/openapi.json', (c) => c.json(openapi))

  app.notFound((c) =>
    c.json(
      errorBody(
        new ApiError('not_found', `没有这个入口：${c.req.method} ${c.req.path}`),
        c.get('cctx')?.trace_id ?? '',
      ),
      404,
    ),
  )

  app.onError((err, c) => {
    const e = normalizeError(err)
    const trace_id = c.get('cctx')?.trace_id ?? ''
    for (const [k, v] of Object.entries(e.headers)) c.header(k, v)
    return c.json(errorBody(e, trace_id), e.status as 400)
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
    },
  }
  return server
}
