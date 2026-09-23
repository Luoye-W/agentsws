/**
 * 托管实例那把云令牌（`hct_…`）。
 *
 * 容器里的 `apps/server` 要用云上的模型（`/v1/ai/*`，计积分，块 = `ai`）、要把
 * 快照推回来，所以它得有一把令牌。这把与商家手上那把**不是同一把**，照
 * `packages/standby/src/child-token.ts` 的三条纪律：
 *
 * - **动作集只有 `ai` + `wallet:read`**：被攻下来的租户实例最多只能把这个租户
 *   自己的积分花掉，开不了、停不了、导不走任何工作区；
 * - **每次起容器换一把**，旧的当场作废；停容器即作废；
 * - **库里只有 sha256**，明文只经容器的环境变量传一次。
 *
 * 令牌里带着工作区号（base64url）：入口 Worker 拿到一把 `hct_` 令牌时要知道该去问
 * 哪一个 `HostedInstanceDO`（每工作区一个），而不是去扫一张全局表。
 * 带工作区号不泄密——工作区号本来就在嵌入代码里公开。
 */
import type { CloudScope } from '@agentsws/contracts'

export const HOSTED_TOKEN_PREFIX = 'hct_'

/** 托管实例那把令牌能做的全部事。 */
export const HOSTED_TOKEN_SCOPES: readonly CloudScope[] = ['ai', 'wallet:read']

/** 有效期：45 天（容器每次重起都换，正常用不到这么久；与值守子进程同一个数）。 */
export const HOSTED_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000

const toB64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')

export function isHostedToken(token: string): boolean {
  return token.startsWith(HOSTED_TOKEN_PREFIX)
}

/** 拼一把：`hct_<base64url(工作区)>.<随机>`。随机部分由调用方给（DO 里用 crypto）。 */
export function composeHostedToken(workspace_id: string, random: string): string {
  return `${HOSTED_TOKEN_PREFIX}${toB64url(workspace_id)}.${random}`
}

/** 从令牌里读出工作区号；形状不对回 `undefined`（不抛——验令牌的路上不给探测的余地）。 */
export function workspaceOfHostedToken(token: string): string | undefined {
  if (!isHostedToken(token)) return undefined
  const body = token.slice(HOSTED_TOKEN_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0 || dot === body.length - 1) return undefined
  try {
    const ws = Buffer.from(body.slice(0, dot), 'base64url').toString('utf8')
    return /^[A-Za-z0-9_:.-]{1,64}$/.test(ws) && !ws.includes('..') ? ws : undefined
  } catch {
    return undefined
  }
}
