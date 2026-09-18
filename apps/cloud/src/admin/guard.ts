/**
 * 后台的守卫（65 §2）。
 *
 * 四条，每条都有一个具体的攻击面在后面：
 *
 * 1. **无权一律 404，不是 403**（KOLAgents 那条）。403 等于告诉试探的人
 *    "这条路确实存在，你只是差一个角色"——那正是他想知道的第一件事。
 *    404 之后，`/v1/admin/accounts` 与 `/v1/admin/nonsense` 在他那边长得一模一样。
 * 2. **角色每次请求现查**（在 `AdminStore.session` 里）：刚被降级的人不该靠一张
 *    旧 cookie 再撑十二小时。
 * 3. **写接口认 CSRF**：双提交 token（cookie 一份、请求头一份）**加上** Origin 校验。
 *    只做 Origin 挡不住没有 Origin 头的老浏览器；只做双提交挡不住同站点的子域写
 *    cookie。两条都做的成本是一行。
 * 4. **`support` 一个写接口都调不动**。判在包装器里，不在每个 handler 里——
 *    漏判一次就是一个只读角色能封人。
 */

import { ApiError, type CloudEnv } from '@agentsws/api'
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_CSRF_HEADER,
  ADMIN_SESSION_COOKIE,
  type AdminSession,
} from '@agentsws/contracts'
import type { Context } from 'hono'
import { clientIpOf } from '../guards.js'
import type { AdminStore } from './store.js'

/** 无权时抛的那一个。**所有**分支都抛同一句话——差别一个字都不能有。 */
export const notThere = (): ApiError => new ApiError('not_found', '没有这个入口')

/** `Cookie: a=1; b=2` → Map。值走 `decodeURIComponent`（我们自己写的时候编过）。 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (header === undefined) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === '') continue
    try {
      out.set(name, decodeURIComponent(value))
    } catch {
      out.set(name, value)
    }
  }
  return out
}

/**
 * 这个地址下 cookie 要不要带 `Secure`。
 *
 * 不只是"https 才带"：`__Host-` 前缀**要求**必须有 `Secure`，而浏览器把
 * `localhost` / `127.0.0.1` 当作可信来源（potentially trustworthy origin），
 * 在这两个主机上即使走 http 也认 `Secure` cookie。
 *
 * 只按 `https://` 判的后果是：本机联调时后台**永远登不进去**——服务端写了一张
 * 没有 `Secure` 的 `__Host-` cookie，浏览器当场丢掉，而页面上看不出任何异常，
 * 只是一直回登录页。这一条是真踩出来的（WP115 的截图脚本）。
 */
export function secureCookiesFor(baseUrl: string): boolean {
  if (baseUrl.startsWith('https://')) return true
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * 写一张 cookie。
 *
 * `__Host-` 前缀（会话那一张）要求：`Secure`、`Path=/`、**没有 `Domain`**。
 * 浏览器会强制这三条，于是别的子域写不进这个名字——子域被拿下之后仍然不能
 * 给我们种一张会话 cookie。
 *
 * `secure` 在本地 http 联调时会让 cookie 根本存不下，所以它是一个参数：
 * 生产永远 true，`AGENTSWS_CLOUD_BASE_URL` 是 http:// 时才 false。
 */
export function cookieHeader(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
    'SameSite=Lax',
  ]
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export interface StaffPrincipal {
  session: AdminSession & { csrf_sha256: string }
  ip: string
}

/**
 * 这次请求是不是一个 staff 发来的。不是就抛 404。
 *
 * **没有"匿名也能看一点"这一档**：后台的每一条路由都要求登录，包括
 * `GET /v1/admin/me`——那一条是"我是谁"，不是"有没有人"。
 */
export function requireStaff(c: Context<CloudEnv>, admin: AdminStore): StaffPrincipal {
  const token = parseCookies(c.req.header('Cookie')).get(ADMIN_SESSION_COOKIE)
  if (token === undefined || token === '') throw notThere()
  const session = admin.session(token)
  if (session === undefined) throw notThere()
  return { session, ip: clientIpOf(c) }
}

/** 写接口：必须是 `admin`。`support` 走到这里与没登录一样——404。 */
export function requireAdmin(c: Context<CloudEnv>, admin: AdminStore): StaffPrincipal {
  const principal = requireStaff(c, admin)
  if (principal.session.role !== 'admin') throw notThere()
  return principal
}

/**
 * CSRF：Origin 校验 + 双提交。
 *
 * Origin 对不上是 403 而不是 404——走到这里说明会话是真的，再装作"这条路不存在"
 * 只会让一个真管理员对着一个莫名其妙的 404 发呆。**不存在**与**这一次不行**
 * 是两回事，前者藏，后者说。
 */
export function requireCsrf(
  c: Context<CloudEnv>,
  admin: AdminStore,
  principal: StaffPrincipal,
  baseUrl: string,
): void {
  const origin = c.req.header('Origin')
  if (origin !== undefined && origin !== '' && !sameOrigin(origin, baseUrl))
    throw new ApiError('forbidden', '这个请求不是从后台页面发出来的')
  const given = c.req.header(ADMIN_CSRF_HEADER)?.trim()
  if (given === undefined || given === '')
    throw new ApiError('forbidden', `缺少 ${ADMIN_CSRF_HEADER}`)
  const cookie = parseCookies(c.req.header('Cookie')).get(ADMIN_CSRF_COOKIE)
  // 三方都要对上：头里那串、cookie 里那串、库里那个哈希。少比一处就少挡一类攻击
  if (cookie !== given || !admin.csrfMatches(principal.session, given))
    throw new ApiError('forbidden', 'CSRF 校验没过，刷新一下后台页面再试')
}

/** 同源判定：协议 + 主机 + 端口。**只比这三样**，路径不看。 */
export function sameOrigin(origin: string, baseUrl: string): boolean {
  try {
    const a = new URL(origin)
    const b = new URL(baseUrl)
    return a.protocol === b.protocol && a.host === b.host
  } catch {
    return false
  }
}
