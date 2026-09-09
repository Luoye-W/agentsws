/**
 * 路由声明：每条路由自带鉴权元组、是否需要 Assignment、是否属于 send / apply 类。
 * OpenAPI 与中间件都从同一份声明里读，避免「文档与实现两张皮」（28 §2）。
 */
import type { DataDomain, Operation, Range, Sensitivity } from '@agentsws/contracts'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import type { GatewayDeps, RequestContext } from './types.js'

/**
 * WP20 加了 `delete`：断开一条连接就是删掉它，用别的动词都得多解释一句。
 * WP27 加了 `patch`：改一条定时任务的时间 / 暂停恢复是**局部改**，用 `put` 就得整条重发。
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch'

/** 31 §3.1：完整元组判定 (assignment, domain, op, range, sensitivity)。 */
export interface AuthzSpec {
  domain: DataDomain
  op: Operation
  range: Range
  sensitivity: Sensitivity
}

export interface ParamSpec {
  name: string
  in: 'query' | 'path' | 'header'
  required?: boolean
  description: string
  schema?: { type: 'string' | 'integer' | 'boolean' }
}

export interface RouteSpec {
  method: HttpMethod
  /** Hono 风格路径（`:id`）；OpenAPI 里转成 `{id}`。 */
  path: string
  operationId: string
  summary: string
  tag: string
  /** `public` = 不需要 Bearer（只有 /v1/health、/v1/auth/*、openapi）。 */
  auth: 'public' | 'bearer'
  /** 需要 `X-Assignment` 头（有 authz 的路由一律需要）。 */
  assignment?: boolean
  authz?: AuthzSpec
  /**
   * 自助豁免：读自己的绑定（本人的 Assignment / 本人的清单）时不再要求策略层读权限。
   * 只有它返回 true 时才跳过 `can`，其余一律走完整元组判定。
   */
  authzBypass?: (c: Context<GatewayEnv>, rctx: RequestContext) => boolean
  /** send / apply 类：`AGENTSWS_HALT=outbound` 时 503（28 §4 用例 3）。 */
  outbound?: boolean
  params?: ParamSpec[]
  body?: ZodType
  /** 成功响应体 `data` 的说明。 */
  returns: string
}

export type GatewayEnv = { Variables: { rctx: RequestContext } }

export type RouteHandler = (c: Context<GatewayEnv>, deps: GatewayDeps) => Promise<Response>

export interface Route {
  spec: RouteSpec
  handler: RouteHandler
}

export const route = (spec: RouteSpec, handler: RouteHandler): Route => ({ spec, handler })
