/** 路由处理器共用的小工具：统一信封、上下文取值、请求体校验。 */
import type { ApprovalItem, Assignment, PersonId } from '@agentsws/contracts'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from './errors.js'
import type { GatewayEnv } from './route-spec.js'
import type { Principal, RequestContext } from './types.js'

/** 统一成功信封：`{ data, trace_id }`。 */
export function ok<T>(c: Context<GatewayEnv>, data: T, status = 200): Response {
  const rctx = c.get('rctx')
  return c.json({ data, trace_id: rctx.trace_id }, status as 200)
}

export function ctxOf(c: Context<GatewayEnv>): RequestContext {
  return c.get('rctx')
}

export function principalOf(c: Context<GatewayEnv>): Principal {
  const p = c.get('rctx').principal
  // 中间件已保证 bearer 路由必有 principal；到这里还没有就是装配错误。
  if (!p) throw new ApiError('unauthenticated', '缺少凭据')
  return p
}

export function assignmentOf(c: Context<GatewayEnv>): Assignment {
  const a = c.get('rctx').assignment
  if (!a) throw new ApiError('invalid_input', '缺少 X-Assignment 头')
  return a
}

/** zod 校验；失败 → invalid_input（400），details 带字段路径。 */
export async function body<T>(c: Context<GatewayEnv>, schema: ZodType<T>): Promise<T> {
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

/** 路径参数；路由注册时是动态路径，类型上是 `string | undefined`，缺失即路由装配错误。 */
export function param(c: Context<GatewayEnv>, name: string): string {
  const value = c.req.param(name)
  if (value === undefined || value === '')
    throw new ApiError('invalid_input', `缺少路径参数 ${name}`)
  return value
}

export function listParam(c: Context<GatewayEnv>, name: string): string[] | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function intParam(c: Context<GatewayEnv>, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new ApiError('invalid_input', `${name} 必须是非负整数`)
  return n
}

/**
 * 14 §7：decision_token 是一次性凭据，只属于收件人本人。
 * 队列 / 详情返回时抹掉别人那份，否则 A 能拿 B 的 token 去决定。
 */
export function redactItem(item: ApprovalItem, person: PersonId): ApprovalItem {
  return {
    ...item,
    deliveries: item.deliveries.map((d) =>
      d.to === person ? d : { ...d, decision_token: '[redacted]' },
    ),
  }
}

/** 取当前人还能用的那张 token（body 没带 decision_token 时用）。 */
export function tokenFor(item: ApprovalItem, person: PersonId): string | undefined {
  const usable = item.deliveries.filter(
    (d) => d.to === person && d.status !== 'expired' && d.status !== 'acted',
  )
  return usable[usable.length - 1]?.decision_token
}
