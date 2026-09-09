/**
 * 28 §2 API 网关：唯一入口、统一信封、鉴权 / 幂等 / 急停 / 限流四道中间件。
 * 网关里不写业务——每条路由都只是某个已合并模块方法的投影。
 */

import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { ApiError, errorBody, normalizeError } from './errors.js'
import { DEFAULT_IDEMPOTENCY_TTL_MS, fingerprint, MemoryIdempotencyStore } from './idempotency.js'
import { readCookie, SESSION_COOKIE } from './identity.js'
import { buildOpenApi, type OpenApiDocument } from './openapi.js'
import { TokenBucketLimiter } from './rate-limit.js'
import type { GatewayEnv, Route, RouteSpec } from './route-spec.js'
import { approvalRoutes } from './routes/approvals.js'
import { askRoutes } from './routes/ask.js'
import { assignmentRoutes } from './routes/assignments.js'
import { changeRoutes } from './routes/changes.js'
import { connectionRoutes } from './routes/connections.js'
import { eventRoutes } from './routes/events.js'
import { haltRoutes } from './routes/halt.js'
import { healthRoutes } from './routes/health.js'
import { identityRoutes } from './routes/identity.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { meetingRoutes } from './routes/meetings.js'
import { modelRoutes } from './routes/models.js'
import { orgRoutes } from './routes/org.js'
import { privacyRoutes } from './routes/privacy.js'
import { scheduleRoutes } from './routes/schedules.js'
import { secretRoutes } from './routes/secrets.js'
import { skillRoutes } from './routes/skills.js'
import { workRoutes } from './routes/work.js'
import { workstationRoutes } from './routes/workstation.js'
import type { GatewayDeps } from './types.js'

export interface Gateway {
  app: Hono<GatewayEnv>
  /** 全部路由声明（鉴权元组、是否需要 Assignment、是否 send/apply 类）。 */
  specs: RouteSpec[]
  openapi: OpenApiDocument
  /** 实际注册的路径（不含中间件），用于「工作台只经 /v1」的断言。 */
  paths(): { method: string; path: string }[]
  fetch: (request: Request) => Response | Promise<Response>
}

/** 网关自身的元数据路径，唯一不在 /v1 之下的东西（服务发现，非工作台功能）。 */
export const OPENAPI_PATH = '/openapi.json'

export function collectRoutes(): Route[] {
  return [
    ...healthRoutes(),
    // 28 §1 运行期急停（13 §5 托盘的「暂停」）；与 /v1/health 一样不受 all 急停拦截
    ...haltRoutes(),
    ...identityRoutes(),
    // batch 必须排在 :id 之前，否则 `/v1/approvals/batch/decide` 会被当成 id=batch
    ...approvalRoutes(),
    ...changeRoutes(),
    // WP20 连接面：`providers` / `runtime` / `requests/:id` 是定值段，与 `/v1/connections/:service/...` 不撞
    ...connectionRoutes(),
    // WP31 本机秘密库密钥轮换（owner）；`/v1/secrets/rotate` 与连接面不撞
    ...secretRoutes(),
    // WP34 21 §4「删这个人」（owner）：三个库一次清掉，独立路径不与别处撞
    ...privacyRoutes(),
    ...knowledgeRoutes(),
    // 37 §4 会议面：`/v1/meetings/:id/records/:rid/process` 与 `/v1/meetings/:id/records` 路径不同，顺序无所谓
    ...meetingRoutes(),
    ...modelRoutes(),
    ...skillRoutes(),
    // 25 定时与流程；`/v1/schedules/:id/run-now` 是定值段，与 `:id` 不撞
    ...scheduleRoutes(),
    ...assignmentRoutes(),
    // WP28 制度面：职责 / 岗位 / 分配 / 策略层 / 成员与邀请。
    // 必须排在 assignmentRoutes 之后：`GET /v1/assignments` 与这里的 POST 是同一条路径的两个方法
    ...orgRoutes(),
    ...eventRoutes(),
    // 36 工作台面：首页 / 岗位 / 积木；`/v1/positions/:id/...` 里的 id 就是 assignment_id
    ...workstationRoutes(),
    // 37 工作模型：事项 / 目标 / 待办 / 日历 / 计划 / 复盘
    ...workRoutes(),
    // 36 §3 对话入口之二：问 AI（单轮、只你可见）
    ...askRoutes(),
  ]
}

export function createGateway(deps: GatewayDeps): Gateway {
  const app = new Hono<GatewayEnv>()
  const routes = collectRoutes()
  const version = deps.options?.version ?? '0.0.0'
  const limiter = new TokenBucketLimiter(deps.options?.rateLimit ?? {})
  const idempotency =
    deps.options?.idempotencyStore ??
    new MemoryIdempotencyStore(deps.options?.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS)
  const openapi = buildOpenApi(routes, version)
  const nowMs = (): number => Date.parse(deps.clock.now())

  // ── trace：每个请求一个 trace_id，放进异步上下文，事件日志写同一个（28 §1）
  app.use('*', async (c, next) => {
    const incoming = c.req.header('X-Trace-Id')?.trim()
    const trace_id = incoming !== undefined && incoming !== '' ? incoming : deps.trace.newTraceId()
    c.set('rctx', { trace_id })
    c.header('X-Trace-Id', trace_id)
    await deps.traceScope.run(trace_id, () => next())
  })

  const haltAll: MiddlewareHandler<GatewayEnv> = async (_c, next) => {
    if (deps.halt.isHalted('all'))
      throw new ApiError('halted', '系统已急停（AGENTSWS_HALT=all）', {
        details: deps.halt.state().all,
      })
    await next()
  }

  const haltOutbound: MiddlewareHandler<GatewayEnv> = async (_c, next) => {
    if (deps.halt.isHalted('outbound'))
      throw new ApiError('halted', '对外发送与施行已急停（AGENTSWS_HALT=outbound）；读照常', {
        details: deps.halt.state().outbound,
      })
    await next()
  }

  const cookieName = deps.options?.sessionCookieName ?? SESSION_COOKIE

  /**
   * 20 §3 / 13 §5：**cookie 或 bearer，二选一**。
   *
   * 浏览器（工作台、桌面壳窗口）靠 HttpOnly + SameSite=Strict 的会话 cookie；
   * SDK / CLI / 插件靠 `Authorization: Bearer`。两个都在时以 bearer 为准——
   * 显式给的凭据优先于浏览器自动带上的那个。
   */
  const auth: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const header = c.req.header('Authorization')
    const cookie =
      header === undefined || header.trim() === ''
        ? readCookie(c.req.header('Cookie'), cookieName)
        : undefined
    if ((header === undefined || header.trim() === '') && cookie === undefined)
      throw new ApiError('unauthenticated', '缺少 Authorization: Bearer <token> 或会话 cookie')
    const principal = await deps.identity.authenticate(header ?? (cookie as string))
    if (!principal) throw new ApiError('unauthenticated', '凭据无效或已过期')
    // 20 §3：所有 token 绑 workspace_id；跨工作区一律显式切换。
    const explicit = c.req.header('X-Workspace')?.trim()
    if (explicit !== undefined && explicit !== '' && explicit !== principal.workspace_id)
      throw new ApiError('forbidden', '凭据不属于 X-Workspace 指定的工作区')
    c.set('rctx', { ...c.get('rctx'), principal })
    await next()
  }

  const rateLimit: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const p = c.get('rctx').principal
    if (!p) return next()
    const verdict = limiter.take(p.workspace_id, p.kind, nowMs())
    if (!verdict.allowed)
      throw new ApiError('budget_exhausted', '请求过于频繁', {
        status: 429,
        headers: { 'Retry-After': String(verdict.retry_after) },
        details: { scope: `${p.workspace_id}|${p.kind}` },
      })
    c.header('X-RateLimit-Remaining', String(verdict.remaining))
    await next()
  }

  /** 31 §3.1：一次请求绑定一个 Assignment；判定用完整元组。 */
  const bindAssignment = (spec: RouteSpec): MiddlewareHandler<GatewayEnv> => {
    return async (c, next) => {
      const rctx = c.get('rctx')
      const p = rctx.principal
      if (!p) throw new ApiError('unauthenticated', '缺少凭据')
      const id = c.req.header('X-Assignment')?.trim()
      if (id === undefined || id === '')
        throw new ApiError(
          'invalid_input',
          '缺少 X-Assignment 头（31 §3.1 一次请求一个 Assignment）',
        )
      const assignment = deps.roles.getAssignment(id)
      if (
        !assignment ||
        assignment.revoked_at !== undefined ||
        assignment.person_id !== p.person_id ||
        assignment.workspace_id !== p.workspace_id
      )
        throw new ApiError('forbidden', 'X-Assignment 不属于当前主体或已撤销')
      const next_ctx = { ...rctx, assignment }
      c.set('rctx', next_ctx)
      if (spec.authz && !(spec.authzBypass?.(c, next_ctx) ?? false)) {
        const { domain, op, range, sensitivity } = spec.authz
        if (!deps.roles.can(assignment.id, domain, op, { range, sensitivity }))
          throw new ApiError('forbidden', `无权限：${domain}.${op}（range=${range}）`, {
            details: { assignment_id: assignment.id, domain, op, range, sensitivity },
          })
      }
      await next()
    }
  }

  /**
   * 28 §2 幂等：同键 24h 重放原响应；同键不同请求 → idempotency_conflict。
   *
   * 作用域是 (workspace, person)：同工作区两个人各自的键互不可见，否则 A 用 B 猜到的键
   * 就能把 B 的响应体（含 decision_token 之类）读走。抛出的错误不入表——失败的请求可以重试。
   */
  const idempotent: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const key = c.req.header('Idempotency-Key')?.trim()
    if (key === undefined || key === '') return next()
    const rctx = c.get('rctx')
    if (!rctx.principal) return next()
    const scope = `${rctx.principal.workspace_id}|${rctx.principal.person_id}`
    const text = await c.req.text()
    const fp = fingerprint(c.req.method, c.req.path, text)
    const stored = idempotency.get(scope, key, nowMs())
    if (stored) {
      if (stored.fingerprint !== fp)
        throw new ApiError('idempotency_conflict', '同一 Idempotency-Key 用于了不同的请求')
      return new Response(stored.body, {
        status: stored.status,
        headers: {
          'content-type': stored.content_type,
          'X-Trace-Id': rctx.trace_id,
          'Idempotent-Replay': 'true',
        },
      })
    }
    await next()
    const res = c.res
    // 5xx 视为未定结果，不缓存；正常产出的响应（含处理器自己返回的 4xx）重放同一份。
    if (res.status < 500) {
      idempotency.put(scope, key, {
        fingerprint: fp,
        status: res.status,
        body: await res.clone().text(),
        content_type: res.headers.get('content-type') ?? 'application/json',
        stored_at: nowMs(),
      })
    }
    return undefined
  }

  for (const { spec, handler } of routes) {
    const chain: MiddlewareHandler<GatewayEnv>[] = []
    // /v1/health 是诊断入口、/v1/halt 是解停入口：急停时这两条也必须能用（28 §4 用例 2 / 3）
    if (spec.path !== '/v1/health' && spec.path !== '/v1/halt') chain.push(haltAll)
    if (spec.auth === 'bearer') chain.push(auth, rateLimit)
    if (spec.outbound) chain.push(haltOutbound)
    if (spec.assignment) chain.push(bindAssignment(spec))
    if (spec.method === 'post') chain.push(idempotent)
    app.on(spec.method.toUpperCase(), [spec.path], ...chain, (c) => handler(c, deps))
  }

  const openapiHandler = (c: { json: (v: unknown) => Response }): Response => c.json(openapi)
  app.get(OPENAPI_PATH, openapiHandler)
  app.get(`/v1${OPENAPI_PATH}`, openapiHandler)

  app.notFound((c) =>
    c.json(
      errorBody(
        new ApiError('not_found', `没有这个入口：${c.req.method} ${c.req.path}`),
        c.get('rctx')?.trace_id ?? '',
      ),
      404,
    ),
  )

  app.onError((err, c) => {
    const e = normalizeError(err)
    const trace_id = c.get('rctx')?.trace_id ?? ''
    for (const [k, v] of Object.entries(e.headers)) c.header(k, v)
    return c.json(errorBody(e, trace_id), e.status as 400)
  })

  return {
    app,
    specs: routes.map((r) => r.spec),
    openapi,
    paths: () =>
      app.routes.filter((r) => r.method !== 'ALL').map((r) => ({ method: r.method, path: r.path })),
    fetch: (request: Request) => app.fetch(request),
  }
}
