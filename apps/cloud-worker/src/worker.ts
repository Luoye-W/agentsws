/**
 * 入口 Worker：一进门先擦干净，再决定这一条请求归哪个 Durable Object（WP114）。
 *
 * 它自己**不存任何东西**，也不做任何业务判断。四件事：
 *
 * 1. **擦头**：把外面送来的内部头与 `X-Forwarded-For` 全剥掉，再按
 *    `CF-Connecting-IP` 填一个真的。不擦的话限流与 principal 都能被伪造；
 * 2. **验令牌**：`wst_…` 的请求先问 `AccountsDO`——**每次都问，不缓存**，
 *    所以"撤销立刻生效"是真的立刻，不是"最多一分钟"；
 * 3. **选对象**：账号那一层去单例 `AccountsDO`，钱那一层去 `WalletDO(org_id)`；
 * 4. **原样转**：请求体与响应体都不缓冲——`/v1/ai/*` 的 SSE 从上游一路流到
 *    用户那里，中间没有一处把它读进内存。
 *
 * 401 那句话不在这里另写一遍：它调的是 `@agentsws/cloud-entry` 的
 * `authenticate`，与 Compose 形态跑的是同一个函数、同一句话。
 */

import { ADMIN_TOKEN_ENV } from '@agentsws/cloud/workers-kit'
import { authenticate, errorResponse } from '@agentsws/cloud-entry'
import type { CloudTokenVerifier, VerifiedCloudToken } from '@agentsws/contracts'
import { isKolPath, type KolCharge, type KolWalletOp, kolChargeFor } from '@agentsws/kol-public'
import type { WalletReservation } from '@agentsws/metering'
import type { WorkerEnv } from './env.js'
import {
  INTERNAL_HEADERS,
  jsonArrayFrom,
  stripInternalHeaders,
  withInternalHeaders,
} from './internal.js'
import { KOL_PUBLIC_SINGLETON } from './kol-admin.js'
import { KOL_WALLET_INTERNAL, type KolReserveFailure } from './kol-wallet.js'

/** 单例 `AccountsDO` 的名字。只有这一个名字，所以只有这一个对象。 */
export const ACCOUNTS_SINGLETON = 'accounts'

/**
 * 客户端送来的这几个头一律不信。
 *
 * `guards.ts` 的 `clientIpOf` 读 `X-Forwarded-For`，那是照 Caddy 那一版写的
 * （反代先删掉客户端送的，再填自己看到的对端）。Cloudflare 这边同一条纪律：
 * 剥掉客户端自己塞的，改填 `CF-Connecting-IP`——那一个是 Cloudflare 填的，
 * 伪造不了。不这么做的话，任何人自己塞一个头就能换一个限流桶。
 */
const CLIENT_IP_HEADERS = ['X-Forwarded-For', 'X-Real-IP'] as const

/** Cloudflare 填的真实客户端 IP。 */
const CF_CONNECTING_IP = 'CF-Connecting-IP'

/** 把客户端自己塞的 IP 头换成 Cloudflare 看到的那一个。 */
export function normalizeClientIp(request: Request): Request {
  const headers = new Headers(request.headers)
  for (const name of CLIENT_IP_HEADERS) headers.delete(name)
  const real = request.headers.get(CF_CONNECTING_IP)
  if (real !== null && real.trim() !== '') headers.set('X-Forwarded-For', real.trim())
  return new Request(request, { headers })
}

/** 钱那一层的路径前缀（去 `WalletDO`）。 */
export function isWalletPath(pathname: string): boolean {
  return (
    pathname.startsWith('/v1/ai/') ||
    pathname === '/v1/wallet' ||
    pathname.startsWith('/v1/wallet/')
  )
}

/** Stripe 自己打过来的那条（不带我们的令牌，带的是签名）。 */
export const STRIPE_WEBHOOK_PATH = '/v1/wallet/topup/stripe/webhook'

/** 管理员手动发积分（WP110）。 */
export const ADMIN_TOPUP_PATH = '/v1/admin/topup'

/** 运营后台的静态产物（WP115）。由 wrangler 的 `[assets]` 服务，不进这段代码。 */
export const ADMIN_ASSET_PREFIX = '/admin/'

/**
 * 这条路归后台那一层吗（WP115 / 65 §2）。
 *
 * 后台的**会话、角色、封禁、黑名单、审计、会员 term** 都与账号住在
 * `AccountsDO` 的同一张库里，所以 `/v1/admin/*` 与 `/admin/*` 一律去那个单例。
 * 例外只有一条：`/v1/admin/topup`（WP110 那条手动充值）**要动钱**，所以它
 * 仍然去 `WalletDO`——上面单独判了。
 */
export function isAdminPath(pathname: string): boolean {
  if (pathname === ADMIN_TOPUP_PATH) return false
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/v1/admin/') ||
    pathname === '/v1/admin'
  )
}

/** 定长比较：不给计时旁路。 */
export function secretEquals(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= (x[i] as number) ^ (y[i] as number)
  return diff === 0
}

/** `{ code, message }` 信封（与网关 28 §2 同形状）。 */
function envelope(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function accountsStub(env: WorkerEnv): { fetch(request: Request): Promise<Response> } {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(ACCOUNTS_SINGLETON))
}

function walletStub(
  env: WorkerEnv,
  org_id: string,
): { fetch(request: Request): Promise<Response> } {
  // 每个组织一个对象：钱的并发边界就是这一行
  return env.WALLET.get(env.WALLET.idFromName(org_id))
}

/** 去问 `AccountsDO`：这串令牌是谁的。**每次都问，一秒都不缓存。** */
export function remoteVerifier(env: WorkerEnv, origin: string): CloudTokenVerifier {
  return async (token: string): Promise<VerifiedCloudToken | undefined> => {
    const res = await accountsStub(env).fetch(
      new Request(`${origin}/__internal/verify-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    )
    if (!res.ok) return undefined
    const parsed = (await res.json()) as VerifiedCloudToken | null
    return parsed ?? undefined
  }
}

/** 把 `{ email | org_id }` 解成一个**存在的**组织号；不存在回 `undefined`。 */
async function resolveOrg(
  env: WorkerEnv,
  origin: string,
  input: { org_id?: string; email?: string },
): Promise<string | undefined> {
  const res = await accountsStub(env).fetch(
    new Request(`${origin}/__internal/resolve-org`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  if (!res.ok) return undefined
  const parsed = (await res.json()) as { org_id?: string } | null
  return parsed?.org_id
}

/** Stripe webhook 的正文里那个组织号（**不验签**——验签在 DO 里，正文原样带过去）。 */
export function orgOfStripePayload(payload: string): string | undefined {
  try {
    const event = JSON.parse(payload) as {
      data?: { object?: { metadata?: { org_id?: unknown } } }
    }
    const org = event.data?.object?.metadata?.org_id
    return typeof org === 'string' && org !== '' ? org : undefined
  } catch {
    return undefined
  }
}

async function handleStripeWebhook(env: WorkerEnv, request: Request): Promise<Response> {
  /*
   * 正文要**原样**交给 DO：Stripe 签的是 `${t}.${原始 body}`，
   * 重新序列化一趟键序一变签名就对不上。所以这里只读一次文本、找出组织号，
   * 再把**同一串文本**转下去。
   */
  const payload = await request.text()
  const org_id = orgOfStripePayload(payload)
  if (org_id === undefined) return envelope('invalid_input', 'webhook 里缺 org_id（metadata）', 400)
  return walletStub(env, org_id).fetch(
    new Request(request.url, { method: 'POST', headers: request.headers, body: payload }),
  )
}

async function handleAdminTopup(
  env: WorkerEnv,
  request: Request,
  origin: string,
): Promise<Response> {
  const configured = (env[ADMIN_TOKEN_ENV] ?? '').trim()
  // 没配就**根本没有这条路由**（不是挂上去再拒）——与 Compose 形态同一条
  if (configured === '') return envelope('not_found', `没有这个入口：POST ${ADMIN_TOPUP_PATH}`, 404)
  const raw = request.headers.get('Authorization') ?? ''
  const given = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
  /*
   * 令牌比对在**解析组织之前**：先解析的话，一个没有钥匙的人就能拿
   * `{"email":"..."}` 试出"这个邮箱在不在库里"。
   */
  if (!secretEquals(given.trim(), configured))
    return envelope('unauthenticated', '管理员令牌不对', 401)
  const text = await request.text()
  let body: { org_id?: string; email?: string } = {}
  try {
    body = text.trim() === '' ? {} : (JSON.parse(text) as typeof body)
  } catch {
    return envelope('invalid_input', '请求体不是合法 JSON', 400)
  }
  const org_id = await resolveOrg(env, origin, body)
  if (org_id === undefined)
    return envelope(
      'not_found',
      body.org_id === undefined ? '这个邮箱还没登录过云账号——让他先在本地关联一次' : '没有这个组织',
      404,
    )
  // 组织号补进正文：DO 那一头的账号库是"已经验过"的极小实现，不再查一遍
  const forwarded = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...body, org_id }),
  })
  return walletStub(env, org_id).fetch(forwarded)
}

/**
 * 公共红人库那三跳（WP116 / 64 §10.2）。
 *
 * ```
 * ① WalletDO(org) 预扣（只有收费那三条路要）
 * ② KolPublicDO 取数（带着那一笔预扣）
 * ③ WalletDO(…)  照单结算 / 释放 / 返额度
 * ```
 *
 * ③ **按组织分组**再打：结算走预扣上的组织，而"贡献返额度"那一笔可能落在
 * 另一个组织头上（插件令牌配对给谁，额度就返给谁）。一趟打一个对象。
 *
 * ③ 用 `waitUntil` 吗？**不用。** 它是钱，用户拿到 200 的那一刻账必须已经记上；
 * 抄给看板那一份才是"顺便"。
 */
async function handleKolPublic(
  env: WorkerEnv,
  request: Request,
  origin: string,
  url: URL,
): Promise<Response> {
  if (env.KOL_PUBLIC === undefined)
    return envelope('not_found', `没有这个入口：${request.method} ${url.pathname}`, 404)

  /*
   * 插件上报那一条**不认工作区令牌**（只认 `plg_…`），所以这里不能强求 principal。
   * 认令牌的活儿由公共库自己那一套鉴权做（`packages/kol-public` 的 `authenticate`），
   * 入口只负责："如果带着 `wst_…`，先验一遍并把 principal 递进去"。
   */
  let principal: VerifiedCloudToken | undefined
  const authorization = request.headers.get('Authorization') ?? undefined
  if (authorization !== undefined && authorization.includes('wst_')) {
    try {
      const verified = await authenticate({ verifier: remoteVerifier(env, origin) }, authorization)
      principal = { ...verified, scopes: verified.scopes as VerifiedCloudToken['scopes'] }
    } catch (err) {
      return errorResponse(err)
    }
  }

  // ① 预扣（免费那几条一笔都不预扣）
  const charge = kolChargeFor(request.method, url.pathname)
  const reservations: WalletReservation[] = []
  if (charge !== undefined) {
    if (principal === undefined) return envelope('unauthenticated', '这一条要登录的工作区令牌', 401)
    const reserved = await reserveKolCharge(env, origin, principal, charge)
    if ('error' in reserved)
      return envelope(
        reserved.error.code,
        reserved.error.message,
        reserved.error.code === 'insufficient_credits' ? 402 : 400,
      )
    reservations.push(reserved.reservation)
  }

  // ② 取数
  const stub = env.KOL_PUBLIC.get(env.KOL_PUBLIC.idFromName(KOL_PUBLIC_SINGLETON))
  const forwarded = withInternalHeaders(request, {
    ...(principal === undefined ? {} : { principal }),
    ...(reservations.length === 0 ? {} : { kolReservations: reservations }),
  })
  const res = await stub.fetch(forwarded)

  // ③ 照单执行。**记不上不该把 200 变成 500**：钱那一侧的孤儿预扣清扫是兜底
  const ops = jsonArrayFrom(res.headers, INTERNAL_HEADERS.kolOps) as KolWalletOp[]
  await applyKolOpsRemote(env, origin, ops, reservations)

  // 内部头不出门
  const headers = new Headers(res.headers)
  headers.delete(INTERNAL_HEADERS.kolOps)
  return new Response(res.body, { status: res.status, headers })
}

/** ① 去那个组织的 `WalletDO` 里预扣一笔。 */
async function reserveKolCharge(
  env: WorkerEnv,
  origin: string,
  principal: VerifiedCloudToken,
  charge: KolCharge,
): Promise<{ reservation: WalletReservation } | { error: KolReserveFailure }> {
  const res = await walletStub(env, principal.org_id).fetch(
    new Request(`${origin}${KOL_WALLET_INTERNAL.reserve}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: principal.org_id,
        workspace_id: principal.workspace_id,
        capability: charge.capability,
        unit: charge.unit,
        quantity: charge.quantity,
        request_id: crypto.randomUUID(),
      }),
    }),
  )
  if (!res.ok)
    return { error: { code: 'invalid_input', message: '钱包没应答，这一次没做（钱一分没动）' } }
  const parsed = (await res.json()) as
    | { error: KolReserveFailure }
    | (WalletReservation & { error?: undefined })
  if (parsed.error !== undefined) return { error: parsed.error }
  return { reservation: parsed as WalletReservation }
}

/** ③ 按组织分组，一趟打一个 `WalletDO`。 */
async function applyKolOpsRemote(
  env: WorkerEnv,
  origin: string,
  ops: readonly KolWalletOp[],
  reservations: readonly WalletReservation[],
): Promise<void> {
  const byOrg = new Map<string, { ops: KolWalletOp[]; reservations: WalletReservation[] }>()
  const bucket = (org_id: string): { ops: KolWalletOp[]; reservations: WalletReservation[] } => {
    const found = byOrg.get(org_id)
    if (found !== undefined) return found
    const made = { ops: [] as KolWalletOp[], reservations: [] as WalletReservation[] }
    byOrg.set(org_id, made)
    return made
  }
  for (const op of ops)
    bucket(op.kind === 'topup' ? op.args.org_id : op.reservation.org_id).ops.push(op)
  for (const reservation of reservations) bucket(reservation.org_id).reservations.push(reservation)
  if (byOrg.size === 0) return
  await Promise.all(
    [...byOrg].map(async ([org_id, batch]) => {
      try {
        await walletStub(env, org_id).fetch(
          new Request(`${origin}${KOL_WALLET_INTERNAL.apply}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch),
          }),
        )
      } catch {
        // 记不上就算了：那笔预扣会被钱那一侧的闹钟当孤儿扫掉（一小时）
      }
    }),
  )
}

/** 一条请求的全部去向。 */
export async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const clean = normalizeClientIp(stripInternalHeaders(request))
  const url = new URL(clean.url)
  const origin = url.origin

  // 内部路由不对外开放——外面打进来就是 404，与不存在的路径一句话
  if (url.pathname.startsWith('/__internal/'))
    return envelope('not_found', `没有这个入口：${clean.method} ${url.pathname}`, 404)

  if (url.pathname === STRIPE_WEBHOOK_PATH && clean.method === 'POST')
    return handleStripeWebhook(env, clean)

  if (url.pathname === ADMIN_TOPUP_PATH && clean.method === 'POST')
    return handleAdminTopup(env, clean, origin)

  /*
   * WP115 的后台。**不在这里判权限**——那一层在 `AccountsDO` 里（会话、角色、
   * CSRF 都要查库）。这里只负责把它送到对的对象上。
   *
   * `/admin/assets/*` 这类静态资产由 wrangler 的 `[assets]` 在到达 Worker
   * **之前**就回掉了（`not_found_handling = "none"`，`run_worker_first` 只对
   * `/admin/*` 之外的路径为真——见 wrangler.toml 的那一段）。所以走到这里的
   * `/admin/*` 只剩服务端渲染的那两页与 SPA 的兜底。
   */
  if (isAdminPath(url.pathname)) {
    const res = await accountsStub(env).fetch(clean)
    /*
     * DO 说"这个人有后台会话"（204 + 内部头）→ 由这里去 `[assets]` 取文件。
     * 判权限在库那一侧，取文件在 binding 这一侧，一次往返各做一半。
     */
    if (res.status === 204 && res.headers.get(INTERNAL_HEADERS.adminAsset) === '1') {
      if (env.ASSETS === undefined)
        return envelope('not_found', `没有这个入口：${clean.method} ${url.pathname}`, 404)
      return env.ASSETS.fetch(clean)
    }
    return res
  }

  // WP116：公共红人库（预扣 → 取数 → 结算，三跳）
  if (isKolPath(url.pathname)) return handleKolPublic(env, clean, origin, url)

  if (isWalletPath(url.pathname)) {
    // ② 验令牌：每次都去问 AccountsDO（撤销立刻生效）
    let principal: VerifiedCloudToken
    try {
      const verified = await authenticate(
        { verifier: remoteVerifier(env, origin) },
        clean.headers.get('Authorization') ?? undefined,
      )
      // `EntryPrincipal.scopes` 是 `string[]`（入口那一层不认识动作集的枚举）；
      // 内部头里放的是验证器原样回来的那一份，所以这里按 `CloudScope[]` 还原
      principal = { ...verified, scopes: verified.scopes as VerifiedCloudToken['scopes'] }
    } catch (err) {
      // 401 那句话与 Compose 形态一字不差（同一个函数抛的同一个错）
      return errorResponse(err)
    }
    // ③ 选对象 + ④ 原样转（响应体是流，不缓冲）
    return walletStub(env, principal.org_id).fetch(withInternalHeaders(clean, { principal }))
  }

  // 其余全归账号那一层：health、magic link、会话、工作区关联、首页、登录落地页
  return accountsStub(env).fetch(clean)
}
