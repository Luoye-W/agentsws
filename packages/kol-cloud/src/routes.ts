/**
 * 红人营销增值服务的路由包（67 §3）。挂进哪个 Hono 应用由云侧决定。
 *
 * 一组路径、一种鉴权：`/v1/kol/*`，工作区服务令牌 + `kol` 动作集（WP118 新加的
 * 那一个，进默认签发）。为什么动作集进默认：这把动作集本身**不解锁任何东西**
 * ——没订阅的组织调同步接口一律 402。不进默认的后果是"订阅完了还要回云上重签
 * 一把令牌"，而那一步用户不知道要做，也不该知道。
 *
 * | 路径 | 干什么 |
 * |---|---|
 * | `GET /v1/kol/sync/status` | 订阅状态 + 云端多少条 + 最近同步 + 冲突数 |
 * | `POST /v1/kol/sync/push` | 上行（最后写入者胜，输的留着） |
 * | `GET /v1/kol/sync/pull` | 下行（游标翻页） |
 * | `POST /v1/kol/subscription` | 开通（当场扣第一期） |
 * | `DELETE /v1/kol/subscription` | 取消（当期用完为止） |
 * | `GET /v1/kol/cloud/export` | 导出云端这一份（**欠费也给导**） |
 * | `DELETE /v1/kol/cloud` | 删掉云端这一份（本地一条不动） |
 *
 * 形状不对与验不过回**同一句话同一个码**——分开说等于告诉试探的人前缀猜对了
 * （与 WP59 / WP61 逐字同一条）。
 */
import type { CloudTokenVerifier } from '@agentsws/contracts'
import { WORKSPACE_TOKEN_PREFIX } from '@agentsws/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import type { Hono } from 'hono'
import type { KolCloudService } from './service.js'
import { KolCloudError, type KolCloudEnv, type KolCloudPrincipal } from './types.js'

/** 路径前缀。`/v1/data/kol/*` 是**公共库**那一层，两者不共用一个字节。 */
export const KOL_CLOUD_PREFIX = '/v1/kol'

/** 这条路归租户云端红人库吗（入口 Worker 拿它分流）。 */
export function isKolCloudPath(pathname: string): boolean {
  return pathname === KOL_CLOUD_PREFIX || pathname.startsWith(`${KOL_CLOUD_PREFIX}/`)
}

/** 这个包要的动作集（WP118 新加，见 `CloudScope`）。 */
export const KOL_CLOUD_SCOPE = 'kol'

export interface KolCloudRouteDeps {
  service: KolCloudService
  /** 验工作区服务令牌。Workers 形态已经在入口验过，这里给一个读内部头的替身。 */
  verifier: CloudTokenVerifier
}

export function bearerToken(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
  return value === '' ? undefined : value
}

const unauthenticated = (): KolCloudError =>
  new KolCloudError(
    'unauthenticated',
    '这把工作区服务令牌不认识或者已经撤了。去本地的「设置 → 账号与积分」里重新关联一次。',
  )

export async function authenticate(
  deps: KolCloudRouteDeps,
  authorization: string | undefined,
): Promise<KolCloudPrincipal> {
  const token = bearerToken(authorization)
  if (token === undefined || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) throw unauthenticated()
  // 令牌明文只在这一行出现：交给 verifier，函数返回之后没人再引用它
  const verified = await deps.verifier(token)
  if (verified === undefined) throw unauthenticated()
  if (!verified.scopes.includes(KOL_CLOUD_SCOPE))
    throw new KolCloudError(
      'forbidden',
      '这把令牌没有「红人营销云端同步」这一项权限。去云上的账号页把它放开，或者重新关联一次账号。',
      { details: { required_scope: KOL_CLOUD_SCOPE } },
    )
  return {
    account_id: verified.account_id,
    org_id: verified.org_id,
    workspace_id: verified.workspace_id,
    scopes: verified.scopes,
  }
}

/** 错误 → `{ code, message, details }` 信封（与 28 §2 同形状）。 */
export function errorResponse(err: unknown): Response {
  const e =
    err instanceof KolCloudError
      ? err
      : new KolCloudError('internal', '云侧出了点问题，这一次没有动你的数据。')
  return new Response(
    JSON.stringify({
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    }),
    { status: e.status, headers: { 'content-type': 'application/json' } },
  )
}

const principalOf = (c: Context<KolCloudEnv>): KolCloudPrincipal => {
  const found = c.get('kol_cloud_principal')
  // 中间件跑过就一定有；没有是装配错了，要吵（无声地当成匿名请求更危险）
  if (found === undefined) throw new KolCloudError('internal', '这一次请求没有主体。')
  return found
}

/** 把这一组路由挂到一个 Hono 应用上。 */
export function mountKolCloudRoutes(app: Hono<KolCloudEnv>, deps: KolCloudRouteDeps): void {
  const auth: MiddlewareHandler<KolCloudEnv> = async (c, next) => {
    const principal = await authenticate(deps, c.req.header('Authorization'))
    c.set('kol_cloud_principal', principal)
    await next()
  }

  app.use(`${KOL_CLOUD_PREFIX}/*`, async (c, next) => {
    try {
      await next()
    } catch (err) {
      return errorResponse(err)
    }
    return undefined
  })

  app.get(`${KOL_CLOUD_PREFIX}/sync/status`, auth, (c) =>
    c.json(deps.service.status(principalOf(c))),
  )

  app.post(`${KOL_CLOUD_PREFIX}/sync/push`, auth, async (c) => {
    const body = (await c.req.json().catch(() => {
      throw new KolCloudError('invalid_input', '请求体不是合法 JSON。')
    })) as { writer?: string; objects?: unknown[] }
    return c.json(
      deps.service.push(principalOf(c), {
        writer: String(body.writer ?? ''),
        objects: (body.objects ?? []) as never,
      }),
    )
  })

  app.get(`${KOL_CLOUD_PREFIX}/sync/pull`, auth, (c) => {
    const limitRaw = c.req.query('limit')
    const parsed = limitRaw === undefined ? Number.NaN : Number(limitRaw)
    return c.json(
      deps.service.pull(principalOf(c), {
        ...(c.req.query('cursor') === undefined ? {} : { cursor: c.req.query('cursor') as string }),
        ...(c.req.query('writer') === undefined ? {} : { writer: c.req.query('writer') as string }),
        ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
      }),
    )
  })

  app.post(`${KOL_CLOUD_PREFIX}/subscription`, auth, async (c) =>
    c.json(await deps.service.subscribe(principalOf(c))),
  )

  app.delete(`${KOL_CLOUD_PREFIX}/subscription`, auth, (c) =>
    c.json(deps.service.cancel(principalOf(c))),
  )

  app.get(`${KOL_CLOUD_PREFIX}/cloud/export`, auth, (c) =>
    c.json(deps.service.exportAll(principalOf(c))),
  )

  app.delete(`${KOL_CLOUD_PREFIX}/cloud`, auth, (c) =>
    c.json(deps.service.deleteAll(principalOf(c))),
  )
}
