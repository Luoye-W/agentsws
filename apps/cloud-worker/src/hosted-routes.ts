/**
 * WP128：托管实例在入口 Worker 上的几条路（验令牌 → 转给 `HostedInstanceDO(工作区)`）。
 *
 * 两类调用方、两把钥匙，**互不通用**：
 *
 * | 路 | 谁打 | 认哪把令牌 |
 * |---|---|---|
 * | `GET/PUT /v1/hosted/snapshot` | 容器里的 `apps/server`（推 / 拉自己的快照） | **只认 `wst_hosted_`** |
 * | `GET /v1/support/hosted` | 商家本机（设置页看托管状态） | 只认工作区令牌 |
 * | `GET/PUT /v1/support/hosted/snapshot` | 商家本机（取回云端那一份 / 用本机这份覆盖云端） | 只认工作区令牌 |
 *
 * `wst_hosted_` 令牌另外只在 `/v1/ai/*` 与 `/v1/wallet`（读）上认——`hostedAwareVerifier`
 * 只在那两处用；别的路由用的 `remoteVerifier` 只问 `AccountsDO`，那里没有这把令牌，
 * 所以一个被攻下来的容器开不了订阅、签不了配对、拉不走留言。
 */
import { authenticate, errorResponse } from '@agentsws/cloud-entry'
import type { CloudTokenVerifier, VerifiedCloudToken } from '@agentsws/contracts'
import { isHostedToken, workspaceOfHostedToken } from '@agentsws/hosted'
import type { WorkerEnv } from './env.js'
import { HOSTED_INTERNAL, SNAPSHOT_SOURCE_HEADER } from './hosted-instance-do.js'
import { withInternalHeaders } from './internal.js'

/** 容器推 / 拉快照。 */
export const HOSTED_SNAPSHOT_PATH = '/v1/hosted/snapshot'
/** 商家看托管状态。 */
export const SUPPORT_HOSTED_PATH = '/v1/support/hosted'
/** 商家取回 / 覆盖云端那一份。 */
export const SUPPORT_HOSTED_SNAPSHOT_PATH = '/v1/support/hosted/snapshot'

export function isHostedPath(pathname: string): boolean {
  return (
    pathname === HOSTED_SNAPSHOT_PATH ||
    pathname === SUPPORT_HOSTED_PATH ||
    pathname === SUPPORT_HOSTED_SNAPSHOT_PATH
  )
}

const envelope = (code: string, message: string, status: number): Response =>
  Response.json({ code, message }, { status })

/** 问 `HostedInstanceDO(工作区)`：这把 `wst_hosted_` 令牌是不是它现在那一把。 */
export function hostedTokenVerifier(env: WorkerEnv): CloudTokenVerifier {
  return async (token: string): Promise<VerifiedCloudToken | undefined> => {
    const ns = env.HOSTED_INSTANCE
    const workspace = workspaceOfHostedToken(token)
    if (ns === undefined || workspace === undefined) return undefined
    const res = await ns.get(ns.idFromName(workspace)).fetch(
      new Request(`https://hosted.internal${HOSTED_INTERNAL.verifyToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    )
    if (!res.ok) return undefined
    const parsed = (await res.json()) as VerifiedCloudToken | null
    // 令牌里读出来的工作区必须与对象回的一致（不一致 = 有人拼了一把别人的前缀）
    return parsed === null || parsed.workspace_id !== workspace ? undefined : parsed
  }
}

/** `/v1/ai/*` 与钱包那一条用的：`wst_hosted_` 去问托管对象，别的照旧问账号库。 */
export function hostedAwareVerifier(
  env: WorkerEnv,
  fallback: CloudTokenVerifier,
): CloudTokenVerifier {
  const hosted = hostedTokenVerifier(env)
  return (token: string) => (isHostedToken(token) ? hosted(token) : fallback(token))
}

const bearer = (request: Request): string | undefined => {
  const raw = request.headers.get('Authorization') ?? undefined
  if (raw === undefined) return undefined
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
}

export async function handleHosted(
  env: WorkerEnv,
  request: Request,
  url: URL,
  ownerVerifier: CloudTokenVerifier,
): Promise<Response> {
  const ns = env.HOSTED_INSTANCE
  if (ns === undefined)
    return envelope('not_found', `没有这个入口：${request.method} ${url.pathname}`, 404)

  const containerSide = url.pathname === HOSTED_SNAPSHOT_PATH
  const token = bearer(request)
  // 两类钥匙互不通用：容器那条只认托管令牌，商家那几条不认托管令牌
  if (token !== undefined && isHostedToken(token) !== containerSide)
    return envelope('unauthenticated', '这把令牌不能用在这里', 401)

  let principal: VerifiedCloudToken
  try {
    const verified = await authenticate(
      { verifier: containerSide ? hostedTokenVerifier(env) : ownerVerifier },
      request.headers.get('Authorization') ?? undefined,
    )
    principal = { ...verified, scopes: verified.scopes as VerifiedCloudToken['scopes'] }
  } catch (err) {
    return errorResponse(err)
  }
  const stub = ns.get(ns.idFromName(principal.workspace_id))

  if (url.pathname === SUPPORT_HOSTED_PATH) {
    if (request.method !== 'GET')
      return envelope('not_found', `没有这个入口：${request.method} ${url.pathname}`, 404)
    return stub.fetch(new Request(`https://hosted.internal${HOSTED_INTERNAL.status}`))
  }

  if (request.method !== 'GET' && request.method !== 'PUT')
    return envelope('not_found', `没有这个入口：${request.method} ${url.pathname}`, 404)
  // 快照：谁推的记下来（容器 = hosted；商家本机 = local）。正文原样转，不缓冲
  const headers = new Headers(request.headers)
  headers.set(SNAPSHOT_SOURCE_HEADER, containerSide ? 'hosted' : 'local')
  const forwarded = new Request(`https://hosted.internal${HOSTED_INTERNAL.snapshot}`, {
    method: request.method,
    headers,
    ...(request.method === 'PUT' ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit)
  return stub.fetch(withInternalHeaders(forwarded, { principal }))
}
