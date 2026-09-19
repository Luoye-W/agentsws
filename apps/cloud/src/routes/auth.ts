/**
 * 49 M1 的登录：复用 20 §3 的 magic link 那一套，一个字都没改——
 * 签一次性 token（15 分钟、一次性、只存哈希）→ 邮件投递 → 换会话 token。
 *
 * 与本地档唯一的不同：**一次性 token 绝不进 HTTP 响应**。本地单机档回传是因为
 * 那台机器上只有一个人、回环口、没有邮件通道；云上有真邮箱，回传就等于
 * "谁调谁登录"。
 */

import {
  ApiError,
  type CloudRoute,
  cloudBody,
  cloudOk,
  cloudRoute,
  cloudSession,
} from '@agentsws/api'
import { type Clock, emailDomain } from '@agentsws/contracts'
import { z } from 'zod'
import { callbackWithToken, checkCallbackUrl } from '../callback.js'
import { clientIpOf, type MagicLinkLimiter, rateLimited } from '../guards.js'
import { loginMail, MailDeliveryError, type MailSender } from '../mail.js'
import { grantSignupBonus, type SignupBonusHooks } from '../signup-bonus.js'
import { CLOUD_LOGIN_TTL_MS, type CloudStore } from '../store.js'

/**
 * 不带 `callback_url` 时信里那条链接落在哪。
 *
 * WP58 拼的是 `/cloud/auth/callback`，而那条路由**不存在**——不带 callback 调一次
 * magic-link，信发出去了，点开是 404。WP110 把落点改成真有的那一页（`/login`），
 * 旧路径留成别名（`server.ts` 的 `LEGACY_LOGIN_PATH`），已经发出去的信照样点得开。
 */
export const DEFAULT_CALLBACK_PATH = '/login'

const MagicLinkBody = z.object({
  email: z.string().min(3).max(320),
  /**
   * 点开之后落到哪儿。本地关联向导传的是自己的回环地址；网页版不传，
   * 落到云自己的 `/cloud/auth/callback`。白名单见 `callback.ts`。
   */
  callback_url: z.string().min(1).max(2000).optional(),
  /** 本地向导生成的一次性随机串，原样带回，用来挡"别人塞给你一条回调"。 */
  state: z.string().min(1).max(200).optional(),
})

const VerifyBody = z.object({ token: z.string().min(1).max(500) })

export interface AuthRouteDeps {
  store: CloudStore
  clock: Clock
  mail: MailSender
  /** 云自己的对外地址（`AGENTSWS_CLOUD_BASE_URL`）。 */
  baseUrl: string
  loginTtlMs?: number
  /**
   * WP110 限流：每邮箱 5 次 / 小时、每 IP 20 次 / 小时。
   *
   * 不给 = 不限（只读路由声明的场合，比如 `gen-cloud-openapi.mjs`）。
   * 这一条是整个云侧**唯一**一条"不带任何凭据就能让服务器发出一封信"的路由，
   * 裸着的话别人能拿它给任意邮箱刷信，而收信的人只会觉得是我们在骚扰他。
   */
  limiter?: MagicLinkLimiter
  /** 投递失败时把那一行写到哪儿（默认 stderr）。 */
  warn?: (line: string) => void
  /**
   * WP121（70 §2）：注册赠送 10 积分。
   *
   * 不给 = 这个节点不送（开源自建档默认就是这样：没有云钱包，也没有积分这回事）。
   */
  signupBonus?: SignupBonusHooks
}

export function authRoutes(deps: AuthRouteDeps): CloudRoute[] {
  const ttl = deps.loginTtlMs ?? CLOUD_LOGIN_TTL_MS
  const warn = deps.warn ?? ((line: string) => process.stderr.write(line))
  return [
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/auth/magic-link',
        operationId: 'cloudMagicLink',
        summary: '发一封登录邮件（一次性 token 只进邮件，不进响应）',
        tag: 'cloud-auth',
        auth: 'public',
        body: MagicLinkBody,
        returns: '{ expires_at, delivered: "email" }',
      },
      async (c) => {
        const input = await cloudBody(c, MagicLinkBody)
        const email = input.email.trim().toLowerCase()
        if (!email.includes('@')) throw new ApiError('invalid_input', 'email 不合法')
        const callback = input.callback_url ?? `${deps.baseUrl}${DEFAULT_CALLBACK_PATH}`
        const check = checkCallbackUrl(callback, deps.baseUrl)
        if (!check.ok) throw new ApiError('invalid_input', check.reason ?? 'callback_url 不允许')
        /*
         * 限流在**建账号之前**：先建后限的话，刷一遍就能在库里种下一堆空账号
         * （每个还各带一个隐式组织）。
         */
        if (deps.limiter !== undefined) {
          const verdict = deps.limiter.take(email, clientIpOf(c), Date.parse(deps.clock.now()))
          if (!verdict.allowed) {
            // 哪一条限住的只进服务端日志；给用户的那句话对此一个字不说
            warn(`[magic-link] 限流 scope=${verdict.scope} domain=${emailDomain(email)}\n`)
            throw rateLimited(verdict)
          }
        }
        // 第一次见到这个邮箱就建账号 + 隐式建组织（52 O3）；
        // 回应对"这个邮箱注册过没有"一个字都不透露——两条路的响应一模一样。
        const { account } = deps.store.ensureAccount(email)
        const issued = deps.store.issueLogin(account.id, ttl)
        const link = callbackWithToken(callback, issued.token, input.state)
        try {
          await deps.mail(loginMail(email, link, Math.round(ttl / 60000)))
        } catch (err) {
          /*
           * 投递失败要如实说"信没发出去"——假装发出去了只会让人在收件箱里干等。
           * 但那句话对"这个地址存不存在"一个字都不说（退信原文在 `cause` 里，
           * 由 `smtpMailSender` 打进 stderr，不进响应）。
           */
          if (err instanceof MailDeliveryError)
            throw new ApiError('provider_unavailable', err.message)
          warn(`[magic-link] 投递出了没预料到的错：${String(err)}\n`)
          throw new ApiError('provider_unavailable', '登录信没发出去，等一分钟再试一次。')
        }
        return cloudOk(c, { expires_at: issued.expires_at, delivered: 'email' })
      },
    ),
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/auth/verify',
        operationId: 'cloudVerifyMagicLink',
        summary: '验一次性 token，换云账号会话',
        tag: 'cloud-auth',
        auth: 'public',
        body: VerifyBody,
        returns: '{ account, org, session_token, expires_at, bonus? }',
      },
      async (c) => {
        const input = await cloudBody(c, VerifyBody)
        const out = deps.store.verifyLogin(input.token)
        // 用过 / 过期 / 不存在，一律同一句话
        if (out === undefined) throw new ApiError('unauthenticated', '登录链接无效或已用过')
        /*
         * WP121（70 §2）：**这一刻**才送注册积分——点开了信才算这个邮箱是真的。
         * `grantSignupBonus` 永不抛：送不出去也不该让登录失败。
         */
        const bonus =
          deps.signupBonus === undefined
            ? undefined
            : await grantSignupBonus(
                { clock: deps.clock, hooks: deps.signupBonus },
                { account_id: out.account.id, org_id: out.org.id, email: out.account.email },
              )
        return cloudOk(c, {
          account: { id: out.account.id, email: out.account.email },
          org: { id: out.org.id, name: out.org.name },
          session_token: out.session_token,
          expires_at: out.expires_at,
          ...(bonus === undefined ? {} : { bonus }),
        })
      },
    ),
    cloudRoute(
      {
        method: 'get',
        path: '/v1/cloud/me',
        operationId: 'cloudMe',
        summary: '当前云账号：是谁、组织是哪个',
        tag: 'cloud-auth',
        auth: 'session',
        returns: '{ account, org }',
      },
      async (c) => {
        const { account_id, org_id } = cloudSession(c)
        const account = deps.store.account(account_id)
        const org = deps.store.org(org_id)
        if (account === undefined || org === undefined)
          throw new ApiError('not_found', '账号或组织不存在')
        return cloudOk(c, {
          account: { id: account.id, email: account.email },
          org: { id: org.id, name: org.name, members: org.members.length },
        })
      },
    ),
    cloudRoute(
      {
        method: 'post',
        path: '/v1/cloud/auth/logout',
        operationId: 'cloudLogout',
        summary: '注销：撤销这一张会话 token',
        tag: 'cloud-auth',
        auth: 'session',
        returns: '{ revoked: true }',
      },
      async (c) => {
        const raw = c.req.header('Authorization')
        const token = raw?.startsWith('Bearer ') === true ? raw.slice('Bearer '.length).trim() : raw
        if (token !== undefined && token !== '') deps.store.revokeSession(token)
        return cloudOk(c, { revoked: true })
      },
    ),
  ]
}
