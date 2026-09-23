/**
 * 公共红人库的路由包（48 §5.3 / 49 §6 WP61）。挂进哪个 Hono 应用由云侧决定
 * （`apps/cloud/src/kol-public.ts`）。
 *
 * 两组路径，两种鉴权，刻意不混：
 *
 * | 路径 | 谁能进 | 为什么 |
 * |---|---|---|
 * | `/v1/data/kol/*`（除下面那条） | 工作区服务令牌 + `data` 动作集 | 浏览 / 体检 / reveal / 配对是**商家**的动作 |
 * | `POST /v1/data/kol/plugins/observations`（WP129 加 `plugins/content-observations`） | 插件令牌 `plg_…` | 插件跑在浏览器里，它只能报观察——既不能查库，也不能花积分 |
 *
 * 令牌纪律（18 §1）三条，都在 {@link authenticate} 那一个函数里：
 * 令牌只从头里读一次、验完就扔；明文不进日志 / 不进错误信封 / 不进计量事件；
 * 每条路由声明自己要哪个动作集，没有就 403。
 *
 * 形状不对与验不过回**同一句话同一个码**——分开说等于告诉试探的人前缀猜对了
 * （与 WP59 / WP60 逐字同一条）。
 */
import type { CloudTokenVerifier, FollowersBand, KolChannel } from '@agentsws/contracts'
import {
  FOLLOWERS_BANDS,
  followersBandOf,
  KOL_PUBLIC_SCOPE,
  KOL_REGION_HEADER,
  PLUGIN_TOKEN_PREFIX,
  WORKSPACE_TOKEN_PREFIX,
} from '@agentsws/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { assertChannel, normalizeHandle } from './normalize.js'
import { type KolPublicService, workspaceSubject } from './service.js'
import { type KolEnv, KolError, type KolPrincipal } from './types.js'

/** 路径前缀（49 M3 的服务入口把 `/v1/data/*` 留给了公共库）。 */
export const KOL_PREFIX = '/v1/data/kol'

export interface KolRouteDeps {
  service: KolPublicService
  /** WP58 的那个纯函数（`apps/cloud` 的 `sqliteTokenVerifier`）。 */
  verifier: CloudTokenVerifier
}

export function bearerToken(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
  return value === '' ? undefined : value
}

const unauthenticated = (): KolError =>
  new KolError(
    'unauthenticated',
    '这把工作区服务令牌不认识或者已经撤了。去本地的"设置 → 账号与积分"里重新关联一次。',
  )

/** `X-Agentsws-Region: cn` → 只查库，不走境外源（22 §2）。 */
export function regionOf(raw: string | undefined): 'cn' | 'global' {
  return raw?.trim().toLowerCase() === 'cn' ? 'cn' : 'global'
}

/** 验工作区服务令牌 + 查 `data` 动作集。 */
export async function authenticate(
  deps: KolRouteDeps,
  authorization: string | undefined,
  region: string | undefined,
): Promise<KolPrincipal> {
  const token = bearerToken(authorization)
  if (token === undefined || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) throw unauthenticated()
  // 令牌明文只在这一行出现：交给 verifier，函数返回之后没人再引用它
  const verified = await deps.verifier(token)
  if (verified === undefined) throw unauthenticated()
  if (!verified.scopes.includes(KOL_PUBLIC_SCOPE))
    throw new KolError(
      'forbidden',
      '这把令牌没有「公共红人库」这一项权限。去云上的账号页把它放开，或者重新关联一次账号。',
      { details: { required_scope: KOL_PUBLIC_SCOPE } },
    )
  return {
    account_id: verified.account_id,
    org_id: verified.org_id,
    workspace_id: verified.workspace_id,
    scopes: verified.scopes,
    region: regionOf(region),
  }
}

/** 错误 → `{ code, message, details }` 信封（与 28 §2 同形状）。 */
export function errorResponse(err: unknown): Response {
  const e =
    err instanceof KolError ? err : new KolError('internal', '云侧出了点问题，这一次没有扣积分。')
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
  return new Response(JSON.stringify({ data: value }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function bodyOf(c: Context<KolEnv>): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new KolError('invalid_input', '请求体要是一个 JSON 对象。')
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof KolError) throw err
    throw new KolError('invalid_input', '请求体不是合法 JSON。')
  }
}

/** 路径里的 `:channel/:handle` → 归一化过的自足键。 */
function keyOf(c: Context<KolEnv>): { channel: KolChannel; handle: string } {
  return {
    channel: assertChannel(c.req.param('channel')),
    handle: normalizeHandle(c.req.param('handle')),
  }
}

const numberOf = (raw: string | undefined, field: string): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new KolError('invalid_input', `${field} 要是一个数。`)
  return value
}

function bandOf(c: Context<KolEnv>): FollowersBand {
  const raw = c.req.query('followers_band')
  if (raw !== undefined && raw.trim() !== '') {
    if (!(FOLLOWERS_BANDS as readonly string[]).includes(raw))
      throw new KolError(
        'invalid_input',
        `followers_band 只能是这四个之一：${FOLLOWERS_BANDS.join(' / ')}。`,
      )
    return raw as FollowersBand
  }
  const followers = numberOf(c.req.query('followers'), 'followers')
  if (followers !== undefined) return followersBandOf(followers)
  throw new KolError(
    'invalid_input',
    `基准要按粉丝量级出：带上 followers_band（${FOLLOWERS_BANDS.join(' / ')}）或者一个 followers 数。`,
  )
}

/** 把公共红人库挂到一个 Hono 应用上。 */
export function mountKolPublicRoutes(app: Hono<KolEnv>, deps: KolRouteDeps): Hono<KolEnv> {
  const guard: MiddlewareHandler<KolEnv> = async (c, next) => {
    c.set(
      'kol_principal',
      await authenticate(deps, c.req.header('Authorization'), c.req.header(KOL_REGION_HEADER)),
    )
    await next()
  }

  // 错误统一在这里翻信封——每个 handler 里写一遍 try/catch 是抄写，而抄写迟早漏一处
  const guarded: MiddlewareHandler<KolEnv> = async (c, next) => {
    try {
      return await guard(c, next)
    } catch (err) {
      return errorResponse(err)
    }
  }

  const wrap =
    (handler: (c: Context<KolEnv>) => Promise<Response>) =>
    async (c: Context<KolEnv>): Promise<Response> => {
      try {
        return await handler(c)
      } catch (err) {
        return errorResponse(err)
      }
    }

  // ————— 读：浏览（免费）—————
  app.get(
    `${KOL_PREFIX}/creators`,
    guarded,
    wrap(async (c) => {
      const channel = c.req.query('channel')
      return json(
        deps.service.browse(c.get('kol_principal'), {
          ...(channel === undefined || channel === '' ? {} : { channel: assertChannel(channel) }),
          q: c.req.query('q'),
          min_followers: numberOf(c.req.query('min_followers'), 'min_followers'),
          category: c.req.query('category'),
          limit: numberOf(c.req.query('limit'), 'limit'),
        }),
      )
    }),
  )

  // ————— 读：免费体检报告 —————
  app.get(
    `${KOL_PREFIX}/creators/:channel/:handle/audit`,
    guarded,
    wrap(async (c) => json(deps.service.audit(c.get('kol_principal'), keyOf(c)))),
  )

  // ————— 读：付费 reveal（data.kol.lookup）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/reveal`,
    guarded,
    wrap(async (c) => json(deps.service.reveal(c.get('kol_principal'), keyOf(c)))),
  )

  // ————— 读：付费深度体检（data.kol.audit）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/deep-audit`,
    guarded,
    wrap(async (c) => json(deps.service.deepAudit(c.get('kol_principal'), keyOf(c)))),
  )

  // ————— 读：去外部源刷新一次（social.fetch；cn 只查库）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/refresh`,
    guarded,
    wrap(async (c) => json(await deps.service.refresh(c.get('kol_principal'), keyOf(c)))),
  )

  // ————— 读：k-匿名基准 —————
  app.get(
    `${KOL_PREFIX}/benchmarks`,
    guarded,
    wrap(async (c) =>
      json(
        deps.service.benchmark(c.get('kol_principal'), {
          channel: assertChannel(c.req.query('channel')),
          category: c.req.query('category'),
          followers_band: bandOf(c),
        }),
      ),
    ),
  )

  // ————— 写：手动加观察（登录态工作区）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/observations`,
    guarded,
    wrap(async (c) => {
      const key = keyOf(c)
      const body = await bodyOf(c)
      const raw = body.observations ?? [body]
      // 路径里的自足键就是权威：body 里带的 channel / handle 以路径为准
      const observations = (Array.isArray(raw) ? raw : [raw]).map((one) =>
        typeof one === 'object' && one !== null && !Array.isArray(one)
          ? { ...(one as Record<string, unknown>), channel: key.channel, handle: key.handle }
          : one,
      )
      return json(deps.service.contributeAs(c.get('kol_principal'), observations), 201)
    }),
  )

  // ————— 写：内容观测（WP129；登录态工作区——本机服务转发插件采到的内容走这条）—————
  app.post(
    `${KOL_PREFIX}/content-observations`,
    guarded,
    wrap(async (c) => {
      const body = await bodyOf(c)
      return json(
        deps.service.contributeContentAs(c.get('kol_principal'), body.observations ?? []),
        201,
      )
    }),
  )

  // ————— 写：联系方式回填（回填者得奖励）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/contact`,
    guarded,
    wrap(async (c) =>
      json(
        deps.service.saveContact(
          workspaceSubject(c.get('kol_principal')),
          keyOf(c),
          await bodyOf(c),
        ),
        201,
      ),
    ),
  )

  // ————— 写：争议（只记不裁）—————
  app.post(
    `${KOL_PREFIX}/creators/:channel/:handle/disputes`,
    guarded,
    wrap(async (c) =>
      json(deps.service.dispute(c.get('kol_principal'), keyOf(c), await bodyOf(c)), 201),
    ),
  )

  // ————— 插件：配对（工作区令牌换一把 plg_…）—————
  app.post(
    `${KOL_PREFIX}/plugins/pair`,
    guarded,
    wrap(async (c) => {
      const body = await bodyOf(c)
      const label = typeof body.label === 'string' ? body.label : ''
      const issued = deps.service.pairPlugin(c.get('kol_principal'), label)
      // 明文只在这一次响应里出现；库里只有 sha256
      return json(
        { pairing: issued.pairing, token: issued.token, expires_at: issued.expires_at },
        201,
      )
    }),
  )

  // ————— 插件：撤一把 —————
  app.post(
    `${KOL_PREFIX}/plugins/:sha/revoke`,
    guarded,
    wrap(async (c) => {
      const sha = c.req.param('sha') ?? ''
      const ok = deps.service.revokePlugin(c.get('kol_principal'), sha)
      if (!ok) throw new KolError('not_found', '没有这把插件令牌。')
      return json({ revoked: true })
    }),
  )

  /*
   * 插件上报：**这一条不认工作区令牌**，只认 `plg_…`。
   *
   * 两条鉴权分开的理由与 WP60 的公网入口一样：一个装在几千台电脑上的扩展
   * 拿到的那把，能做的事必须比商家那把少一个数量级——它只能往库里加事实，
   * 不能查库、不能花钱、不能撤自己之外的任何东西。
   */
  app.post(
    `${KOL_PREFIX}/plugins/observations`,
    wrap(async (c) => {
      const token = bearerToken(c.req.header('Authorization'))
      const subject =
        token === undefined || !token.startsWith(PLUGIN_TOKEN_PREFIX)
          ? undefined
          : deps.service.verifyPluginToken(token)
      if (subject === undefined)
        throw new KolError(
          'unauthenticated',
          '这把插件令牌不认识或者已经撤了。在工作站里重新配对一次插件。',
        )
      const body = await bodyOf(c)
      return json(deps.service.contribute(subject, body.observations ?? [], 'plugin'), 201)
    }),
  )

  // ————— 插件：内容观测（WP129；与上面那条同一把 plg_…、同一套口径）—————
  app.post(
    `${KOL_PREFIX}/plugins/content-observations`,
    wrap(async (c) => {
      const token = bearerToken(c.req.header('Authorization'))
      const subject =
        token === undefined || !token.startsWith(PLUGIN_TOKEN_PREFIX)
          ? undefined
          : deps.service.verifyPluginToken(token)
      if (subject === undefined)
        throw new KolError(
          'unauthenticated',
          '这把插件令牌不认识或者已经撤了。在工作站里重新配对一次插件。',
        )
      const body = await bodyOf(c)
      return json(deps.service.contributeContent(subject, body.observations ?? [], 'plugin'), 201)
    }),
  )

  return app
}

/** 一个装好公共库的 Hono 应用（测试与 `bin/dev.mjs` 用；生产由云侧自己拼）。 */
export function createKolPublicApp(deps: KolRouteDeps): Hono<KolEnv> {
  return mountKolPublicRoutes(new Hono<KolEnv>(), deps)
}
