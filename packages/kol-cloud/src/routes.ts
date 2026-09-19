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
 * | `GET /v1/kol/sync/conflicts` | 还没处理的冲突（**双方版本都在里面**） |
 * | `POST /v1/kol/sync/conflicts/resolve` | 用户处理完一条：把标记消掉（不删任何一份） |
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
import type { Context, Hono } from 'hono'
import type { KolCloudService } from './service.js'
import { type KolCloudEnv, KolCloudError, type KolCloudPrincipal } from './types.js'

/** 路径前缀。`/v1/data/kol/*` 是**公共库**那一层，两者不共用一个字节。 */
export const KOL_CLOUD_PREFIX = '/v1/kol'

/** 这条路归租户云端红人库吗（入口 Worker 拿它分流）。 */
export function isKolCloudPath(pathname: string): boolean {
  return pathname === KOL_CLOUD_PREFIX || pathname.startsWith(`${KOL_CLOUD_PREFIX}/`)
}

/** 这个包要的动作集（WP118 新加，见 `CloudScope`）。 */
export const KOL_CLOUD_SCOPE = 'kol'

export interface KolCloudRouteDeps {
  /**
   * **按组织**取服务。
   *
   * 为什么是一个函数而不是一个实例：两个形态里"一个组织一份数据"的落法不同
   * （Workers 是一个 DO 一份，Compose 是一个库文件一份），但路由表是同一张。
   * 把"选哪一份"这一步交给装配方，路由包就不必认识多租户这件事——也就不可能
   * 写出一条忘了按组织过滤的查询。
   */
  serviceOf: (principal: KolCloudPrincipal) => KolCloudService
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

/**
 * 成功 → `{ data }` 信封。
 *
 * 与 `/v1/wallet/*`（`packages/cloud-entry`）、`/v1/data/kol/*`（`packages/kol-public`）
 * **逐字同一个形状**：云对外的成功信封只有一种，本地那一侧的取数代码也只需要
 * 认一种。裸着回对象的话，每多一个消费方就多一处"这个接口有没有信封"的记忆。
 */
export function okResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: value }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 把这一组路由挂到一个 Hono 应用上。
 *
 * 每条处理器**各自包一层 try/catch**（{@link guard}），而不是靠一个 `app.use`
 * 的错误中间件或 `app.onError`：这组路由会被挂进两个不同的应用（Workers 形态
 * 是这个包自己建的 Hono，Compose 形态是云侧那个已经有自己 `onError` 的应用），
 * 而那两种应用对"谁来兜错"的约定不一样。包在自己这一层，两边行为一模一样。
 */
export function mountKolCloudRoutes(app: Hono<KolCloudEnv>, deps: KolCloudRouteDeps): void {
  /**
   * 把一个处理器包成"绝不抛"的：错误一律翻成 `{ code, message }` 信封。
   *
   * 处理器拿到的是**已经按组织选好的那一份服务**——它没有办法拿到别人的那一份。
   */
  const guard =
    (
      fn: (
        service: KolCloudService,
        principal: KolCloudPrincipal,
        c: Context<KolCloudEnv>,
      ) => Response | Promise<Response>,
    ) =>
    async (c: Context<KolCloudEnv>): Promise<Response> => {
      try {
        // 鉴权也在里面：401 / 403 与业务错走同一条翻译路径，不会漏成 500
        const principal = await authenticate(deps, c.req.header('Authorization'))
        c.set('kol_cloud_principal', principal)
        return await fn(deps.serviceOf(principal), principal, c)
      } catch (err) {
        return errorResponse(err)
      }
    }

  app.get(
    `${KOL_CLOUD_PREFIX}/sync/status`,
    guard((service, principal) => okResponse(service.status(principal))),
  )

  app.get(
    `${KOL_CLOUD_PREFIX}/sync/conflicts`,
    guard((service, principal, c) => {
      const limitRaw = c.req.query('limit')
      const parsed = limitRaw === undefined ? Number.NaN : Number(limitRaw)
      return okResponse(service.conflicts(principal, Number.isFinite(parsed) ? parsed : undefined))
    }),
  )

  app.post(
    `${KOL_CLOUD_PREFIX}/sync/conflicts/resolve`,
    guard(async (service, principal, c) => {
      const body = (await c.req.json().catch(() => {
        throw new KolCloudError('invalid_input', '请求体不是合法 JSON。')
      })) as { kind?: string; id?: string }
      return okResponse(
        service.resolveConflicts(principal, {
          kind: String(body.kind ?? ''),
          id: String(body.id ?? ''),
        }),
      )
    }),
  )

  app.post(
    `${KOL_CLOUD_PREFIX}/sync/push`,
    guard(async (service, principal, c) => {
      const body = (await c.req.json().catch(() => {
        throw new KolCloudError('invalid_input', '请求体不是合法 JSON。')
      })) as { writer?: string; objects?: unknown[] }
      return okResponse(
        service.push(principal, {
          writer: String(body.writer ?? ''),
          objects: (body.objects ?? []) as never,
        }),
      )
    }),
  )

  app.get(
    `${KOL_CLOUD_PREFIX}/sync/pull`,
    guard((service, principal, c) => {
      const limitRaw = c.req.query('limit')
      const parsed = limitRaw === undefined ? Number.NaN : Number(limitRaw)
      const cursor = c.req.query('cursor')
      const writer = c.req.query('writer')
      return okResponse(
        service.pull(principal, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(writer === undefined ? {} : { writer }),
          ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
        }),
      )
    }),
  )

  app.post(
    `${KOL_CLOUD_PREFIX}/subscription`,
    guard(async (service, principal) => okResponse(await service.subscribe(principal))),
  )

  app.delete(
    `${KOL_CLOUD_PREFIX}/subscription`,
    guard((service, principal) => okResponse(service.cancel(principal))),
  )

  app.get(
    `${KOL_CLOUD_PREFIX}/cloud/export`,
    guard((service, principal) => okResponse(service.exportAll(principal))),
  )

  app.delete(
    `${KOL_CLOUD_PREFIX}/cloud`,
    guard((service, principal) => okResponse(service.deleteAll(principal))),
  )
}
