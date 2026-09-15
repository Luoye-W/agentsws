/**
 * 49 M3「一个薄网关」那一侧的路由声明（云上，不是本机）。
 *
 * 为什么不直接复用本包的 `Route`：本地网关的每条路由都带 05 的鉴权元组
 * （domain / op / range / sensitivity）与 `X-Assignment`——那是**工作区里的人**
 * 在做事。云侧不认识职责，也不该认识：它只认两种凭据——云账号的会话，
 * 与一把**工作区服务令牌**；令牌能做什么由 18 §1 的最小动作集（`scopes`）说了算。
 *
 * 之所以放在 `packages/api` 而不是 `apps/cloud`：WP59 的服务入口以**路由包**
 * 形式交付（`packages/cloud-entry` 导出一组 `CloudRoute`），包不能依赖 app。
 * 本包只出类型与一个 `cloudRoute()`，不出实现——网关装配在 `apps/cloud`。
 */

import type { CloudScope, VerifiedCloudToken } from '@agentsws/contracts'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from './errors.js'
import type { HttpMethod, ParamSpec, RouteSpec } from './route-spec.js'

/**
 * 云侧一次请求的上下文。
 *
 * **没有 token 明文这一格**：与本地网关不同，云侧没有任何一条路由需要把调用方
 * 那串令牌再拿出来用，所以干脆不带——带了就迟早会被谁 `JSON.stringify` 进日志。
 * 自撤销那条路要的是"这把令牌属于哪条关联"，`link_id` 就够了。
 */
export interface CloudRequestContext {
  trace_id: string
  /** 会话（`auth: 'session'`）：这是谁、他的组织是哪个。 */
  account_id?: string
  org_id?: string
  /** 工作区服务令牌（`auth: 'workspace_token'`）验过之后的样子。 */
  token?: VerifiedCloudToken
  /** 令牌属于哪条关联（自撤销用）。 */
  link_id?: string
}

export type CloudEnv = { Variables: { cctx: CloudRequestContext } }

/**
 * 云侧只有三种鉴权：
 * - `public`：magic link 那两条与 health；
 * - `session`：云账号自己在管关联（签发 / 续期 / 撤销 / 列表）；
 * - `workspace_token`：一台机器上的工作区在用服务（WP59 的 `/v1/ai/*`、`/v1/wallet/*`）。
 */
export type CloudAuth = 'public' | 'session' | 'workspace_token'

export interface CloudRouteSpec {
  method: HttpMethod
  path: string
  operationId: string
  summary: string
  tag: string
  auth: CloudAuth
  /**
   * 18 §1 最小动作集：这条路由要求令牌带哪些动作，差一个就 403。
   * 只对 `auth: 'workspace_token'` 有意义；空 / 不写 = 只要令牌有效就行
   * （`GET /v1/cloud/links/current` 与自撤销就是这一档——认自己、撤自己永远允许）。
   */
  scopes?: CloudScope[]
  params?: ParamSpec[]
  body?: ZodType
  returns: string
}

export type CloudRouteHandler = (c: Context<CloudEnv>) => Promise<Response>

/**
 * 一条云侧路由。
 *
 * 处理器**不收 deps 参数**：路由包用工厂函数把自己的依赖闭包进去
 * （`entryRoutes({ wallet, pricing })` → `CloudRoute[]`），于是网关不必认识
 * 任何模块的形状——挂一个模块只是往 `modules` 里多塞一个数组。
 */
export interface CloudRoute {
  spec: CloudRouteSpec
  handler: CloudRouteHandler
}

export const cloudRoute = (spec: CloudRouteSpec, handler: CloudRouteHandler): CloudRoute => ({
  spec,
  handler,
})

/** 云侧路由声明 → 本包的 `RouteSpec`，好让 `buildOpenApi` 一份代码两边用。 */
export function toRouteSpec(spec: CloudRouteSpec): RouteSpec {
  return {
    method: spec.method,
    path: spec.path,
    operationId: spec.operationId,
    summary:
      spec.scopes === undefined || spec.scopes.length === 0
        ? spec.summary
        : `${spec.summary}（需要动作：${spec.scopes.join(' / ')}）`,
    tag: spec.tag,
    auth: spec.auth === 'public' ? 'public' : 'bearer',
    ...(spec.params === undefined ? {} : { params: spec.params }),
    ...(spec.body === undefined ? {} : { body: spec.body }),
    returns: spec.returns,
  }
}

// ── 处理器里的小工具（与本地网关的 helpers 同形，只是换了 Env）──────────────

export function cloudCtx(c: Context<CloudEnv>): CloudRequestContext {
  return c.get('cctx')
}

/** 统一成功信封：`{ data, trace_id }`（28 §2，两侧同一个形状）。 */
export function cloudOk<T>(c: Context<CloudEnv>, data: T, status = 200): Response {
  return c.json({ data, trace_id: cloudCtx(c).trace_id }, status as 200)
}

/** 会话路由里的"这是谁"。中间件已保证有；到这里还没有就是装配错了。 */
export function cloudSession(c: Context<CloudEnv>): { account_id: string; org_id: string } {
  const { account_id, org_id } = cloudCtx(c)
  if (account_id === undefined || org_id === undefined)
    throw new ApiError('unauthenticated', '缺少云账号会话')
  return { account_id, org_id }
}

/** 令牌路由里的"这是哪个工作区、能做什么"。 */
export function cloudToken(c: Context<CloudEnv>): VerifiedCloudToken {
  const token = cloudCtx(c).token
  if (token === undefined) throw new ApiError('unauthenticated', '缺少工作区服务令牌')
  return token
}

/** zod 校验；失败 → invalid_input（400），details 只有字段路径与消息，**没有值**。 */
export async function cloudBody<T>(c: Context<CloudEnv>, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  const text = await c.req.text()
  if (text.trim() === '') raw = {}
  else {
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ApiError('invalid_input', '请求体不是合法 JSON')
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw new ApiError('invalid_input', '请求体校验失败', {
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  return parsed.data
}

export function cloudParam(c: Context<CloudEnv>, name: string): string {
  const value = c.req.param(name)
  if (value === undefined || value === '')
    throw new ApiError('invalid_input', `缺少路径参数 ${name}`)
  return value
}

/** `Authorization: Bearer <t>` / 裸 token → token 本身。 */
export function cloudBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const value = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : header.trim()
  return value === '' ? undefined : value
}
