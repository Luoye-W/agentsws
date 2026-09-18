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
import { join } from 'node:path'
import {
  ApiError,
  buildOpenApi,
  type CloudEnv,
  type CloudRoute,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  errorBody,
  MemoryIdempotencyStore,
  normalizeError,
  type OpenApiDocument,
  SqliteIdempotencyStore,
  type SweepableIdempotencyStore,
  toRouteSpec,
} from '@agentsws/api'
import { type Clock, type CloudTokenVerifier, cloudBaseUrl, emailDomain } from '@agentsws/contracts'
import { type ServerType, serve } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { cloudIdempotency, createMagicLinkLimiter, type MagicLinkLimiter } from './guards.js'
import { type MailSender, mailSenderFromEnv } from './mail.js'
import { indexPage, loginPage } from './pages.js'
import { authRoutes } from './routes/auth.js'
import { type CloudHealthState, cloudHealthRoutes } from './routes/health.js'
import { linkRoutes } from './routes/links.js'
import { type CloudStore, cloudDbPath, createCloudStore } from './store.js'

/** 云侧默认端口。与本地服务进程（3000 档）离得远，同机跑两个不打架。 */
export const DEFAULT_CLOUD_PORT = 4400
export const CLOUD_PORT_ENV = 'AGENTSWS_CLOUD_PORT'
export const CLOUD_DATA_DIR_ENV = 'AGENTSWS_CLOUD_DATA_DIR'
/** 幂等表的库文件（与账号 / 钱包 / 值守 / 红人库各开各的）。 */
export const IDEMPOTENCY_DB_FILE = 'idempotency.sqlite'
/** magic link 点开之后的落地页（WP110 之前这条路由不存在，信里那条链接点开是 404）。 */
export const LOGIN_PATH = '/login'
/** WP58 那一版拼出来的旧落点。留着当别名，免得已经发出去的信点开 404。 */
export const LEGACY_LOGIN_PATH = '/cloud/auth/callback'
/**
 * 云的对外地址与它的环境变量名。**定义在 `@agentsws/contracts`**（WP110 收成一处），
 * 这里只转出去——`apps/cloud` 的调用方一直是从这个模块 import 的，签名不动。
 */
export { CLOUD_BASE_URL_ENV, DEFAULT_CLOUD_BASE_URL } from '@agentsws/contracts'
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

/** 云侧的全部路由声明（账号 + 关联 + 挂进来的模块）。OpenAPI 与中间件读同一份。 */
export function collectCloudRoutes(
  deps: {
    store: CloudStore
    clock: Clock
    mail: MailSender
    baseUrl: string
    version: string
    /** WP110：活的健康状态；不给就退回 WP58 那一版只有 status / version / at 的 health。 */
    health?: CloudHealthState
    /** WP110：magic-link 限流；不给就不限（`gen-cloud-openapi.mjs` 这类只读声明的场合）。 */
    limiter?: MagicLinkLimiter
  },
  modules: CloudRoute[][] = [],
): CloudRoute[] {
  return [
    ...cloudHealthRoutes({
      clock: deps.clock,
      version: deps.version,
      ...(deps.health === undefined ? {} : { state: deps.health }),
    }),
    ...authRoutes({
      store: deps.store,
      clock: deps.clock,
      mail: deps.mail,
      baseUrl: deps.baseUrl,
      ...(deps.limiter === undefined ? {} : { limiter: deps.limiter }),
    }),
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
  const routes = collectCloudRoutes(
    { store, clock, mail, baseUrl, version, health, limiter },
    options.modules,
  )
  const openapi = buildCloudOpenApi(routes, version)
  const verifyToken = store.verifyToken
  const idempotency =
    options.idempotencyStore ??
    (dataDir === undefined || dataDir.trim() === ''
      ? new MemoryIdempotencyStore(options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS)
      : new SqliteIdempotencyStore({
          dbPath: join(dataDir, IDEMPOTENCY_DB_FILE),
          ttlMs: options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
          clock,
        }))

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

  /*
   * 28 §2 幂等：所有 POST 认 `Idempotency-Key`。
   *
   * **只给 `CloudRoute` 那几条**——`/v1/ai/*` 是流式的，把它缓进幂等表等于把
   * "流式"变成"假流式"（而且它自己有预扣 → 结算那一套幂等语义）。
   * 装在鉴权之后：作用域要按凭据算，凭据还没验出来的时候算不出作用域。
   */
  const idempotent = cloudIdempotency({ store: idempotency, clock })

  for (const r of routes) {
    const chain: MiddlewareHandler<CloudEnv>[] = []
    if (r.spec.auth === 'session') chain.push(sessionAuth)
    if (r.spec.auth === 'workspace_token') chain.push(tokenAuth(r))
    // `admin` 档网关不装中间件：那把钥匙只有路由包自己知道（见 CloudAuth 的注释）
    if (r.spec.method === 'post') chain.push(idempotent)
    app.on(r.spec.method.toUpperCase(), [r.spec.path], ...chain, (c) => r.handler(c))
  }

  /*
   * WP110 的两页网页。纯服务端渲染，没有前端构建（见 `pages.ts` 的头注释）。
   * 放在路由表之外是有意的：它们不是 API，不该进 OpenAPI，也不该被 SDK 生成器看见。
   */
  const html = (body: string, status = 200): Response =>
    new Response(body, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 这两页上没有任何可缓存的东西（登录结果尤其不该被中间层存下来）
        'cache-control': 'no-store',
      },
    })

  app.get('/', (c) => html(indexPage({ version, baseUrl, modules: { ...health.modules } })))

  const loginHandler = (c: { req: { query: (k: string) => string | undefined } }): Response => {
    const token = c.req.query('token')
    if (token === undefined || token.trim() === '') return html(loginPage({ kind: 'missing' }), 400)
    const verified = store.verifyLogin(token.trim())
    // 用过 / 过期 / 不存在一律同一句话（与 `POST /v1/cloud/auth/verify` 同一条纪律）
    if (verified === undefined) return html(loginPage({ kind: 'invalid' }), 401)
    /*
     * 会话 token **不印在页面上**：这一页只回答"你这个邮箱收得到信、链接有效"。
     * 本地关联那条路走的是回环回调，token 直接进本机服务进程，不经浏览器。
     */
    return html(loginPage({ kind: 'ok', email_domain: emailDomain(verified.account.email) }))
  }
  app.get(LOGIN_PATH, loginHandler)
  app.get(LEGACY_LOGIN_PATH, loginHandler)

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
