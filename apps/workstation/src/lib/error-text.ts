/**
 * WP139（docs/78 阻断 #2 第 3 条）：接口的错误信封 → 一句人话。
 *
 * 以前试聊页把 403 与 501 说成同一句「这个服务进程没有装在线客服」——服务明明装了，
 * 是请求带的身份没有这条职责。两件事的出路完全不同：
 *
 * - **501 = 这台没装**：换一台、或者等升级，人什么都做不了；
 * - **403 = 你没有这条职责 / 权限**：去「公司」里给自己加上，或者换一条职责进来。
 *
 * 规矩：
 * 1. 网关判权限拒的 403（`details` 里带 `domain` / `op`）一律换成人话，**不把
 *    `customer.read（range=assigned）` 这种内部值端到屏幕上**；业务自己写的 403
 *    （比如「角色定位只有 owner 改得动」）本来就是人话，原样给；
 * 2. 501 的原文常带着 `GatewayDeps.work` 这种开发者字眼，一律换成「这台没装」；
 * 3. 401 / 429 / 5xx / 连不上各一句；其余（400 / 404 / 409）服务端给的就是人话，原样给。
 */
import { ApiClientError } from './api'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 一页可以把 403 / 501 那两句换成更具体的（比如「没有网站在线客服的权限」）。 */
export interface ErrorTextOverrides {
  forbidden?: string
  not_implemented?: string
}

/** 网关按分配判权限拒的那种 403（不是业务自己写的那句话）。 */
export function isPermissionDenied(err: unknown): boolean {
  if (!(err instanceof ApiClientError) || err.status !== 403) return false
  const d = err.details as { domain?: unknown } | undefined
  return typeof d?.domain === 'string' || err.message.startsWith('X-Assignment')
}

export function apiErrorText(
  err: unknown,
  t: Translate,
  overrides: ErrorTextOverrides = {},
): string {
  if (!(err instanceof ApiClientError)) {
    // fetch 本身没出门（服务没开、断网）是 TypeError
    if (err instanceof TypeError) return t('error.network')
    return err instanceof Error && err.message !== '' ? err.message : t('error.generic')
  }
  const own = err.message === '' ? t('error.generic') : err.message
  if (err.status === 403)
    return isPermissionDenied(err) ? (overrides.forbidden ?? t('error.forbidden')) : own
  if (err.status === 501) return overrides.not_implemented ?? t('error.not_implemented')
  if (err.status === 401) return t('error.unauthenticated')
  if (err.status === 429) return t('error.rate_limited')
  if (err.status >= 500) return err.code === 'internal' ? t('error.server') : own
  return own
}
