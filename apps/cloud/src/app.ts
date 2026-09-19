/**
 * 云侧那个 Hono 应用的**装配**——路由表、三档鉴权、幂等、两页网页、错误信封。
 *
 * 为什么与 `server.ts` 分开（WP114）：这个文件里**没有一样 Node 专有的东西**
 * （不开库、不监听端口、不读文件），所以同一份装配能装在两个地方：
 *
 * - `server.ts`：开 sqlite、`@hono/node-server` 监听端口（Compose / 自建形态）；
 * - `apps/cloud-worker` 的 `AccountsDO`：库是 Durable Object 自己的 SQLite，
 *   请求由 Worker 转进来（官方托管形态）。
 *
 * 两个形态**跑的是同一段鉴权与同一份路由表**——这是"Workers 形态与 Compose
 * 形态行为一致"唯一可执行的形式。
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
  type IdempotencyStore,
  normalizeError,
  type OpenApiDocument,
  toRouteSpec,
} from '@agentsws/api'
import { type Clock, type CloudTokenVerifier, emailDomain } from '@agentsws/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { cloudIdempotency, type MagicLinkLimiter } from './guards.js'
import type { MailSender } from './mail.js'
import { indexPage, loginPage } from './pages.js'
import { authRoutes } from './routes/auth.js'
import { type CloudHealthState, cloudHealthRoutes } from './routes/health.js'
import { linkRoutes } from './routes/links.js'
import type { SignupBonusHooks } from './signup-bonus.js'
import type { CloudStore } from './store.js'

/** magic link 点开之后的落地页（WP110 之前这条路由不存在，信里那条链接点开是 404）。 */
export const LOGIN_PATH = '/login'
/** WP58 那一版拼出来的旧落点。留着当别名，免得已经发出去的信点开 404。 */
export const LEGACY_LOGIN_PATH = '/cloud/auth/callback'

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
    /** WP121（70 §2）：注册赠送 10 积分；不给就不送。 */
    signupBonus?: SignupBonusHooks
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
      ...(deps.signupBonus === undefined ? {} : { signupBonus: deps.signupBonus }),
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

export interface CloudAppDeps {
  store: CloudStore
  clock: Clock
  mail: MailSender
  baseUrl: string
  version: string
  /** 活的健康状态；装配方挂完模块之后往里写 true。 */
  health: CloudHealthState
  limiter: MagicLinkLimiter
  idempotency: IdempotencyStore
  /** 49 M3：别的能力以路由包形式挂进来。 */
  modules?: CloudRoute[][]
  /** WP121（70 §2）：注册赠送 10 积分；不给就不送。 */
  signupBonus?: SignupBonusHooks
  /**
   * 验工作区服务令牌用哪一个。不给就是账号库那个。
   * （WP60 把它串成两个：先账号库，再值守的子进程令牌。）
   */
  verifyToken?: CloudTokenVerifier
}

export interface CloudApp {
  app: Hono<CloudEnv>
  routes: CloudRoute[]
  openapi: OpenApiDocument
  verifyToken: CloudTokenVerifier
}

/**
 * 一个装好了**追踪号、404 与错误信封**的空 Hono 应用。
 *
 * 单独抽出来是因为 Workers 形态有第二个应用（`WalletDO` 里那个：入口路由 +
 * 管理员充值），它得与这个长得一模一样——错误信封写两遍，迟早有一遍会在
 * 某个边界上端出内部细节。
 */
export function createCloudHono(): Hono<CloudEnv> {
  const app = new Hono<CloudEnv>()

  const trace: MiddlewareHandler<CloudEnv> = async (c, next) => {
    c.set('cctx', { trace_id: `tr_${randomUUID()}` })
    await next()
    c.header('X-Trace-Id', c.get('cctx').trace_id)
  }
  app.use('*', trace)

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

  return app
}

/** 装一个云侧应用。**不碰任何 Node 专有的东西**——库与监听由调用方给。 */
export function buildCloudApp(deps: CloudAppDeps): CloudApp {
  const { store, clock, mail, baseUrl, version, health, limiter, idempotency } = deps
  const routes = collectCloudRoutes(
    {
      store,
      clock,
      mail,
      baseUrl,
      version,
      health,
      limiter,
      ...(deps.signupBonus === undefined ? {} : { signupBonus: deps.signupBonus }),
    },
    deps.modules,
  )
  const openapi = buildCloudOpenApi(routes, version)
  const verifyToken = deps.verifyToken ?? store.verifyToken

  const app = createCloudHono()

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

  app.get('/', () => html(indexPage({ version, baseUrl, modules: { ...health.modules } })))

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

  return { app, routes, openapi, verifyToken }
}
