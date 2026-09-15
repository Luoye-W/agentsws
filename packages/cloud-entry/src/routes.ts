/**
 * 服务入口的装配（49 M3）：中间件 + 路由表 + 一个 `mountEntryRoutes`。
 *
 * **这个包不起服务**——它只导出路由，由云侧那个进程挂上去（WP58 的 `apps/cloud`）。
 * 本地联调用 `bin/dev.mjs`（内存 verifier + 内存钱包 + 假上游）。
 *
 * 令牌纪律（18 §1）三条，都在 {@link authenticate} 那一个函数里：
 * 1. 令牌**只从 `Authorization` 头读一次**，验完就扔——`c.get('principal')` 里
 *    是账号 / 组织 / 工作区 / scopes，**没有令牌明文**；
 * 2. 令牌明文不进日志、不进错误信封、不进计量事件（那张表根本没有这一列）；
 * 3. 最小动作集：每条路由声明自己要哪个 scope，没有就 403 —— 拿 `wallet` 那把
 *    令牌打 `/v1/ai/*` 打不动。
 */

import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { aiRoutes } from './ai.js'
import type { EntryDeps, EntryEnv, EntryPrincipal, EntryRoute } from './types.js'
import { EntryError } from './types.js'
import { walletRoutes } from './wallet-routes.js'

/** 工作区服务令牌的前缀（WP58 签发时用它；这里只做一次形状检查，不做解析）。 */
export const WORKSPACE_TOKEN_PREFIX = 'wst_'

/** `Authorization: Bearer <t>` / 裸 token → token 本身。 */
export function bearerToken(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
  return value === '' ? undefined : value
}

/**
 * 验令牌。
 *
 * 形状不对（不是 `wst_…`）与验不过回同一句话、同一个状态码——
 * 分开说等于告诉试探的人"你的前缀猜对了"。
 */
export async function authenticate(
  deps: EntryDeps,
  authorization: string | undefined,
): Promise<EntryPrincipal> {
  const token = bearerToken(authorization)
  const unauthenticated = new EntryError(
    'unauthenticated',
    '这把工作区服务令牌不认识或者已经撤了。去本地的设置 → 账号与积分里重新关联一次。',
  )
  if (token === undefined || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) throw unauthenticated
  // 令牌明文只在这一行出现：交给 verifier，函数返回之后没人再引用它
  const verified = await deps.verifier(token)
  if (verified === undefined) throw unauthenticated
  return {
    account_id: verified.account_id,
    org_id: verified.org_id,
    workspace_id: verified.workspace_id,
    scopes: verified.scopes,
  }
}

/** 一个数着走的请求号（这个包里不裸调 `Math.random()`）。 */
function requestIds(deps: EntryDeps): () => string {
  if (deps.newRequestId !== undefined) return deps.newRequestId
  let n = 0
  return () => `req_${Date.now().toString(36)}_${(++n).toString(36)}`
}

/** 错误 → `{ code, message, details }` 信封（与 28 §2 同形状）。 */
export function errorResponse(err: unknown): Response {
  const e =
    err instanceof EntryError
      ? err
      : new EntryError('internal', '云侧出了点问题，这一次没有扣积分。')
  return new Response(
    JSON.stringify({
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    }),
    { status: e.status, headers: { 'content-type': 'application/json' } },
  )
}

/** 全部路由（AI + 钱包）。挂进哪个应用由云侧那边决定。 */
export function entryRoutes(deps: EntryDeps): EntryRoute[] {
  return [...aiRoutes(deps), ...walletRoutes(deps)]
}

function guard(
  deps: EntryDeps,
  route: EntryRoute,
  newId: () => string,
): MiddlewareHandler<EntryEnv> {
  return async (c, next) => {
    c.set('request_id', newId())
    if (route.auth === 'public') return next()
    const principal = await authenticate(deps, c.req.header('Authorization'))
    if (route.scope !== undefined && !principal.scopes.includes(route.scope)) {
      throw new EntryError(
        'forbidden',
        `这把令牌没有「${route.scope}」这一项权限。去本地的设置里重新关联一次账号，或者让所有者放开它。`,
        { details: { required_scope: route.scope } },
      )
    }
    c.set('principal', principal)
    return next()
  }
}

/**
 * 把入口挂进一个 Hono 应用。
 *
 * 错误统一在这里翻信封——每个 handler 里都写一遍 try/catch 是抄写，
 * 而抄写迟早会漏掉一处，漏掉的那处就会把内部细节端给用户。
 */
export function mountEntryRoutes(app: Hono<EntryEnv>, deps: EntryDeps): Hono<EntryEnv> {
  const newId = requestIds(deps)
  for (const route of entryRoutes(deps)) {
    const middleware = guard(deps, route, newId)
    const handler = async (c: Context<EntryEnv>): Promise<Response> => {
      try {
        return await route.handler(c)
      } catch (err) {
        return errorResponse(err)
      }
    }
    const wrapped: MiddlewareHandler<EntryEnv> = async (c, next) => {
      try {
        return await middleware(c, next)
      } catch (err) {
        return errorResponse(err)
      }
    }
    if (route.method === 'get') app.get(route.path, wrapped, handler)
    else app.post(route.path, wrapped, handler)
  }
  return app
}

/** 一个装好入口的 Hono 应用（`bin/dev.mjs` 与测试用；生产由云侧自己拼）。 */
export function createEntryApp(deps: EntryDeps): Hono<EntryEnv> {
  return mountEntryRoutes(new Hono<EntryEnv>(), deps)
}
