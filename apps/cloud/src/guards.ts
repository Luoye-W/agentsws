/**
 * 云侧的限流与幂等（WP110）。
 *
 * WP58 的后置清单第 ⑥ 条："云侧没有限流与幂等（本地网关那两道中间件没搬过去），
 * 账号层的路由目前裸着。" 这个文件补上，**复用 `packages/api` 里已有的两份实现**
 * （`TokenBucketLimiter` / `IdempotencyStore`），不在云侧另写一套——第二套令牌桶
 * 迟早会与第一套在某个边界条件上不一致，而不一致的那一边没人测得到。
 *
 * 两处与本地网关不同：
 *
 * 1. **限流的主语不是工作区**。本地那道的键是 `workspace_id|kind`（一台机器上
 *    一个工作区）；云上最需要挡的那条路由（magic-link）**根本还没有工作区**——
 *    调它的人连账号都可能还不存在。所以键是「邮箱」与「来源 IP」两条：
 *    每邮箱 5 次 / 小时挡"给某个人狂发信"，每 IP 20 次 / 小时挡"拿脚本刷"。
 * 2. **幂等的作用域不是 (工作区, 人)**，而是这次请求用的是哪一种凭据：
 *    会话路由按 `org|account`，令牌路由按 `workspace`，公开路由按来源 IP。
 *    作用域分不开的后果是 A 拿 B 猜到的键就能把 B 的响应体读走——而云侧
 *    签发令牌那条路由的响应体里**有一次性的令牌明文**。
 */

import { createHash } from 'node:crypto'
import {
  ApiError,
  type CloudEnv,
  fingerprint,
  type IdempotencyStore,
  TokenBucketLimiter,
} from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import type { Context, MiddlewareHandler } from 'hono'

/** magic-link：每个邮箱一小时 5 次。 */
export const MAGIC_LINK_PER_EMAIL_HOUR = 5
/** magic-link：每个来源 IP 一小时 20 次。 */
export const MAGIC_LINK_PER_IP_HOUR = 20

const HOUR_SECONDS = 3600

/** 令牌桶的两个 kind 名（`TokenBucketLimiter` 按 kind 查策略）。 */
export const MAGIC_LINK_KINDS = { email: 'magic_link_email', ip: 'magic_link_ip' } as const

export interface RateVerdict {
  allowed: boolean
  /** 拒的时候建议等多少秒（≥1）。 */
  retry_after: number
  /** 是哪一条限住的。**只进日志与 details，不进给用户看的那句话**。 */
  scope: 'email' | 'ip'
}

export interface MagicLinkLimiter {
  take(email: string, ip: string, nowMs: number): RateVerdict
}

export interface MagicLinkLimiterOptions {
  perEmailPerHour?: number
  perIpPerHour?: number
}

/**
 * magic-link 的两道桶。
 *
 * 邮箱先判、IP 后判：邮箱那条被限住时**不消耗 IP 的额度**，否则同一个办公室里
 * 一个人手抖点了五次，旁边的同事就登不进来了。
 *
 * 邮箱进桶前先 sha256：这张表只在内存里，但"进程内存里有一份完整的邮箱清单"
 * 与"有一份哈希清单"在被 dump 的那一天不是一回事（21 §1）。
 */
export function createMagicLinkLimiter(options: MagicLinkLimiterOptions = {}): MagicLinkLimiter {
  const perEmail = options.perEmailPerHour ?? MAGIC_LINK_PER_EMAIL_HOUR
  const perIp = options.perIpPerHour ?? MAGIC_LINK_PER_IP_HOUR
  const limiter = new TokenBucketLimiter({
    [MAGIC_LINK_KINDS.email]: { burst: perEmail, per_second: perEmail / HOUR_SECONDS },
    [MAGIC_LINK_KINDS.ip]: { burst: perIp, per_second: perIp / HOUR_SECONDS },
  })
  return {
    take(email, ip, nowMs) {
      const emailKey = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
      const byEmail = limiter.take(emailKey, MAGIC_LINK_KINDS.email, nowMs)
      if (!byEmail.allowed)
        return { allowed: false, retry_after: byEmail.retry_after, scope: 'email' }
      const byIp = limiter.take(ip, MAGIC_LINK_KINDS.ip, nowMs)
      if (!byIp.allowed) return { allowed: false, retry_after: byIp.retry_after, scope: 'ip' }
      return { allowed: true, retry_after: 0, scope: 'ip' }
    },
  }
}

/** 超限时抛的那一个。对用户只有一句话——**不说是邮箱限住了还是 IP 限住了**。 */
export function rateLimited(verdict: RateVerdict): ApiError {
  return new ApiError('rate_limited', '发得太频繁了，过一会儿再试。', {
    headers: { 'Retry-After': String(verdict.retry_after) },
    // details 里只有等多久；哪一条限住的只进服务端日志
    details: { retry_after: verdict.retry_after },
  })
}

/**
 * 这一次请求从哪儿来。
 *
 * **两条前提，缺一条这个值就能被伪造、限流就形同虚设**：
 *
 * 1. 云进程只从反向代理收流量——`deploy/docker-compose.yml` 里 `cloud`
 *    一个端口都不发布，外面连不到它；
 * 2. 那个反向代理**把客户端送来的 `X-Forwarded-For` 删掉之后**才填自己看到的
 *    对端（`deploy/Caddyfile` 里的 `header_up -X-Forwarded-For`）。Caddy 默认是
 *    追加而不是覆盖，不删的话任何人自己塞一个头就能换一个限流桶。
 *
 * 换别的代理、或者直接把容器暴到公网，都要重新想一遍这两条。
 */
export function clientIpOf(c: Context<CloudEnv>): string {
  const forwarded = c.req.header('X-Forwarded-For')
  if (forwarded !== undefined && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0]?.trim()
    if (first !== undefined && first !== '') return first
  }
  const real = c.req.header('X-Real-IP')?.trim()
  if (real !== undefined && real !== '') return real
  // `@hono/node-server` 把 Node 的 req 放在 `c.env.incoming`；测试里直接 fetch 没有它
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming
  const remote = incoming?.socket?.remoteAddress
  return remote === undefined || remote === '' ? 'unknown' : remote
}

/** 一次请求的幂等作用域：凭据不同的人之间必须互相看不见对方的键。 */
export function idempotencyScopeOf(c: Context<CloudEnv>): string {
  const ctx = c.get('cctx')
  if (ctx?.account_id !== undefined && ctx.org_id !== undefined)
    return `session|${ctx.org_id}|${ctx.account_id}`
  if (ctx?.token !== undefined) return `token|${ctx.token.workspace_id}`
  return `ip|${clientIpOf(c)}`
}

export interface IdempotencyOptions {
  store: IdempotencyStore
  clock: Clock
  /** 作用域怎么算；默认 {@link idempotencyScopeOf}。 */
  scopeOf?: (c: Context<CloudEnv>) => string
}

/**
 * 28 §2 幂等：同键 24h 重放原响应；同键不同请求指纹 → `idempotency_conflict`（409）。
 *
 * 与本地网关那道一字不差的三条：没带 `Idempotency-Key` 就什么都不做；
 * 5xx 不入表（未定结果可以重试）；处理器自己返回的 4xx **入表**
 * （同一个键重放同一个拒绝，而不是第二次换个说法）。
 */
export function cloudIdempotency(options: IdempotencyOptions): MiddlewareHandler<CloudEnv> {
  const scopeOf = options.scopeOf ?? idempotencyScopeOf
  const nowMs = (): number => Date.parse(options.clock.now())
  return async (c, next) => {
    const key = c.req.header('Idempotency-Key')?.trim()
    if (key === undefined || key === '') return next()
    const scope = scopeOf(c)
    const text = await c.req.text()
    const fp = fingerprint(c.req.method, c.req.path, text)
    const stored = options.store.get(scope, key, nowMs())
    if (stored !== undefined) {
      if (stored.fingerprint !== fp)
        throw new ApiError('idempotency_conflict', '同一个 Idempotency-Key 用在了不同的请求上')
      return new Response(stored.body, {
        status: stored.status,
        headers: {
          'content-type': stored.content_type,
          'X-Trace-Id': c.get('cctx')?.trace_id ?? '',
          'Idempotent-Replay': 'true',
        },
      })
    }
    await next()
    const res = c.res
    if (res.status < 500)
      options.store.put(scope, key, {
        fingerprint: fp,
        status: res.status,
        body: await res.clone().text(),
        content_type: res.headers.get('content-type') ?? 'application/json',
        stored_at: nowMs(),
      })
    return undefined
  }
}
