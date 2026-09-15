/**
 * 值守的路由包（49 §6 WP60）。挂进哪个 Hono 应用由云侧那边决定（`apps/cloud`）。
 *
 * 两组路径，两种鉴权，刻意不混：
 *
 * | 路径 | 谁能进 | 为什么 |
 * |---|---|---|
 * | `/v1/standby/*` | 工作区服务令牌 + `standby` 动作集 | 开通 / 停 / 导入 / 导出是**商家**的动作 |
 * | `/w/:workspace_id/*` | 公开（原样代理） | 末端用户走子进程自己的会话；云侧不发、不存、不看 |
 *
 * 控制面那一组还有一条更细的：**令牌只能管自己那个工作区**。`:id` 与令牌绑的
 * `workspace_id` 对不上一律 403——一把令牌能列出整个组织的清单（同一个账号一本账），
 * 但不能去开另一个工作区的值守、更不能把它的数据导出来。
 */
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { PUBLIC_PREFIX, proxyToChild } from './proxy.js'
import type { StandbyService } from './service.js'
import { assertWorkspaceId, StandbyError } from './types.js'

/** 18 §1 最小动作集：值守这一组要这一项。 */
export const STANDBY_SCOPE = 'standby'

/** 工作区服务令牌的前缀（只做一次形状检查，不做解析）。 */
export const WORKSPACE_TOKEN_PREFIX = 'wst_'

/** 上传的包最大多少字节。一个工作区的库可以很大，但 512 MB 之外多半是传错了东西。 */
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024

/** 验过之后挂在上下文里的那一份（**从不含令牌明文**）。 */
export interface StandbyPrincipal {
  account_id: string
  org_id: string
  workspace_id: string
  scopes: string[]
}

export type StandbyEnv = { Variables: { standby_principal: StandbyPrincipal } }

/** 令牌验证：WP58 契约里那份 `CloudTokenVerifier`。 */
export type StandbyVerifier = (
  token: string,
) => Promise<
  { account_id: string; org_id: string; workspace_id: string; scopes: string[] } | undefined
>

export interface StandbyRouteDeps {
  service: StandbyService
  verifier: StandbyVerifier
}

export function bearerToken(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
  return value === '' ? undefined : value
}

/**
 * 验令牌 + 查动作集。
 *
 * 形状不对与验不过回**同一句话同一个码**——分开说等于告诉试探的人前缀猜对了
 * （与 WP59 的入口逐字同一条纪律）。
 */
export async function authenticate(
  deps: StandbyRouteDeps,
  authorization: string | undefined,
): Promise<StandbyPrincipal> {
  const token = bearerToken(authorization)
  const unauthenticated = new StandbyError(
    'unauthenticated',
    '这把工作区服务令牌不认识或者已经撤了。去本地的"设置 → 账号与积分"里重新关联一次。',
  )
  if (token === undefined || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) throw unauthenticated
  // 令牌明文只在这一行出现：交给 verifier，函数返回之后没人再引用它
  const verified = await deps.verifier(token)
  if (verified === undefined) throw unauthenticated
  if (!verified.scopes.includes(STANDBY_SCOPE))
    throw new StandbyError(
      'forbidden',
      '这把令牌没有「值守」这一项权限。去云上的账号页把值守放开，或者重新关联一次账号。',
      { details: { required_scope: STANDBY_SCOPE } },
    )
  return verified
}

/** 错误 → `{ code, message, details }` 信封（与 28 §2 同形状）。 */
export function errorResponse(err: unknown): Response {
  const e =
    err instanceof StandbyError
      ? err
      : new StandbyError('internal', '云侧出了点问题，这一次没有扣积分。')
  return new Response(
    JSON.stringify({
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    }),
    { status: e.status, headers: { 'content-type': 'application/json' } },
  )
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** `:id` 必须就是这把令牌绑的那个工作区。 */
function sameWorkspace(principal: StandbyPrincipal, id: string | undefined): string {
  if (id === undefined) throw new StandbyError('invalid_input', '路径里没有工作区 id')
  const wanted = assertWorkspaceId(id)
  if (wanted !== principal.workspace_id)
    throw new StandbyError('forbidden', '这把令牌只能管它自己那个工作区。')
  return wanted
}

async function readSeats(c: Context): Promise<number> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }
  const raw = (body as { seats?: unknown }).seats
  if (raw === undefined) return 1
  const seats = Number(raw)
  if (!Number.isFinite(seats)) throw new StandbyError('invalid_input', 'seats 要是一个整数')
  return seats
}

/** 控制面的五条 + 公网入口。 */
export function mountStandbyRoutes(
  app: Hono<StandbyEnv>,
  deps: StandbyRouteDeps,
): Hono<StandbyEnv> {
  const guard: MiddlewareHandler<StandbyEnv> = async (c, next) => {
    c.set('standby_principal', await authenticate(deps, c.req.header('Authorization')))
    await next()
  }

  const wrap =
    (handler: (c: Context<StandbyEnv>) => Promise<Response>) =>
    async (c: Context<StandbyEnv>): Promise<Response> => {
      try {
        return await handler(c)
      } catch (err) {
        return errorResponse(err)
      }
    }

  // 错误统一在这里翻信封——每个 handler 里写一遍 try/catch 是抄写，而抄写迟早漏一处
  const guarded: MiddlewareHandler<StandbyEnv> = async (c, next) => {
    try {
      return await guard(c, next)
    } catch (err) {
      return errorResponse(err)
    }
  }

  app.get(
    '/v1/standby/workspaces',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      return json({ workspaces: deps.service.list(p.org_id), seat_price: deps.service.seatPrice() })
    }),
  )

  app.post(
    '/v1/standby/workspaces',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      const seats = await readSeats(c)
      const view = await deps.service.open({
        org_id: p.org_id,
        account_id: p.account_id,
        workspace_id: p.workspace_id,
        seats,
      })
      return json(view, 201)
    }),
  )

  app.get(
    '/v1/standby/workspaces/:id',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      const id = sameWorkspace(p, c.req.param('id'))
      const view = deps.service.get(id)
      if (view === undefined) throw new StandbyError('not_found', '这个工作区没有开值守。')
      return json(view)
    }),
  )

  app.post(
    '/v1/standby/workspaces/:id/stop',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      const id = sameWorkspace(p, c.req.param('id'))
      return json(deps.service.stop(id))
    }),
  )

  app.post(
    '/v1/standby/workspaces/:id/import',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      const id = sameWorkspace(p, c.req.param('id'))
      const seats = Number(c.req.query('seats') ?? '1')
      const force = c.req.query('force') === 'true'
      const buffer = await c.req.arrayBuffer()
      if (buffer.byteLength === 0) throw new StandbyError('invalid_input', '请求体里没有包。')
      if (buffer.byteLength > MAX_PACKAGE_BYTES)
        throw new StandbyError('invalid_input', '这个包太大了（超过 512 MB）。')
      const view = await deps.service.importAndStart({
        org_id: p.org_id,
        account_id: p.account_id,
        workspace_id: id,
        zip: new Uint8Array(buffer),
        seats: Number.isFinite(seats) ? seats : 1,
        force,
      })
      return json(view, 201)
    }),
  )

  app.get(
    '/v1/standby/workspaces/:id/export',
    guarded,
    wrap(async (c) => {
      const p = c.get('standby_principal')
      const id = sameWorkspace(p, c.req.param('id'))
      const pkg = await deps.service.exportPackage(id)
      // Uint8Array → 独占的 ArrayBuffer（`Buffer` 的底层是池子里的一块，
      // 直接取 `.buffer` 会连带把别人的字节一起端出去）
      return new Response(pkg.bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${pkg.name}"`,
        },
      })
    }),
  )

  // 公网入口：原样代理到子进程。**公开**——末端用户带的是子进程自己的会话
  const proxy = wrap(async (c) =>
    proxyToChild(
      {
        fetch: (input, init) => deps.service.fetch(input, init),
        portOf: (id) => deps.service.pool.portOf(id),
      },
      c,
    ),
  )
  app.all(`${PUBLIC_PREFIX}/:workspace_id`, proxy)
  app.all(`${PUBLIC_PREFIX}/:workspace_id/*`, proxy)

  return app
}

/** 一个装好值守的 Hono 应用（测试用；生产由云侧自己拼）。 */
export function createStandbyApp(deps: StandbyRouteDeps): Hono<StandbyEnv> {
  return mountStandbyRoutes(new Hono<StandbyEnv>(), deps)
}
