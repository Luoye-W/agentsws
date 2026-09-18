/**
 * Worker → Durable Object 的**内部头**（WP114）。
 *
 * 一条纪律，只有一条，但它是整个形态的安全地基：
 *
 * > **Worker 一进门就把这几个头从请求上剥掉**，然后才轮到它自己往上写。
 *
 * 不剥的话，外面任何人自己塞一个 `X-Agentsws-Principal: {"scopes":["ai"],…}`
 * 就成了任意组织的主体——令牌验证、scope、余额全都白做。剥掉之后，这几个头
 * **只可能**是这个 Worker 写上去的：DO 在公网上没有地址，除了同一个 Worker
 * 没有别的东西能发请求给它。
 *
 * 头的值里**没有令牌明文**——只有验完的 principal（账号 / 组织 / 工作区 / 动作集）。
 * 与 `packages/cloud-entry` 那条纪律同一句话："`c.get('principal')` 里没有令牌明文"。
 */

import type { CloudScope, VerifiedCloudToken } from '@agentsws/contracts'

/**
 * 内部头的名字。
 *
 * 前缀刻意用 `X-Agentsws-Internal-`：一眼看得出"这不是给外面用的"，
 * 也方便在日志与网关规则里整片过滤。
 */
export const INTERNAL_HEADERS = {
  /** 已验证的 principal（JSON）。 */
  principal: 'X-Agentsws-Internal-Principal',
  /** 这次请求的追踪号（Worker 生成，DO 与日志共用同一个）。 */
  trace: 'X-Agentsws-Internal-Trace',
  /** 管理员那条路由：Worker 已经把邮箱解析成组织了，DO 不必再查账号库。 */
  adminOrg: 'X-Agentsws-Internal-Admin-Org',
  /**
   * WP115：`AccountsDO` 对 Worker 说"这个人有后台会话，把静态产物给他"。
   *
   * 为什么是一个头而不是让 DO 自己回文件：`[assets]` 的 binding 在**入口
   * Worker** 上，DO 拿不到；而判权限要查库，库在 DO 里。一次往返，两边各做
   * 自己做得到的那一半。
   */
  adminAsset: 'X-Agentsws-Internal-Admin-Asset',
} as const

/** 全部内部头的名字（进门先按这张表剥）。 */
export const INTERNAL_HEADER_NAMES: readonly string[] = Object.values(INTERNAL_HEADERS)

/**
 * 把外面送来的内部头**全部剥掉**，回一个干净的请求。
 *
 * 返回新对象而不是改原来那个：`Request.headers` 在 Workers 上是不可变的。
 */
export function stripInternalHeaders(request: Request): Request {
  let dirty = false
  for (const name of INTERNAL_HEADER_NAMES)
    if (request.headers.has(name)) {
      dirty = true
      break
    }
  if (!dirty) return request
  const headers = new Headers(request.headers)
  for (const name of INTERNAL_HEADER_NAMES) headers.delete(name)
  return new Request(request, { headers })
}

/** 往一个请求上写内部头（只有 Worker 调这个）。 */
export function withInternalHeaders(
  request: Request,
  values: { principal?: VerifiedCloudToken; trace?: string; adminOrg?: string },
): Request {
  const headers = new Headers(request.headers)
  if (values.principal !== undefined)
    headers.set(INTERNAL_HEADERS.principal, JSON.stringify(values.principal))
  if (values.trace !== undefined) headers.set(INTERNAL_HEADERS.trace, values.trace)
  if (values.adminOrg !== undefined) headers.set(INTERNAL_HEADERS.adminOrg, values.adminOrg)
  return new Request(request, { headers })
}

/** 从内部头里读回 principal。读不出来 / 形状不对一律 `undefined`（不抛）。 */
export function principalFrom(request: Request): VerifiedCloudToken | undefined {
  const raw = request.headers.get(INTERNAL_HEADERS.principal)
  if (raw === null || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const p = parsed as Record<string, unknown>
  const { account_id, org_id, workspace_id, scopes } = p
  if (
    typeof account_id !== 'string' ||
    typeof org_id !== 'string' ||
    typeof workspace_id !== 'string' ||
    !Array.isArray(scopes) ||
    !scopes.every((s): s is CloudScope => typeof s === 'string')
  )
    return undefined
  return { account_id, org_id, workspace_id, scopes }
}
