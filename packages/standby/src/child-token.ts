/**
 * 子进程那把云令牌（49 §6 WP60 + 18 §1 令牌纪律）。
 *
 * 值守起来的那个 `apps/server` 也要用云上的模型（49 M2 的 `agentsws_cloud`
 * provider），所以它得有一把工作区服务令牌。这把令牌与商家手上那把**不是同一把**，
 * 三条差别都写在代码里：
 *
 * | | 商家那把 | 子进程这把 |
 * |---|---|---|
 * | 签发 | WP58 的 `workspace_links` | 这里（`standby_child_tokens`） |
 * | 动作集 | `ai` / `wallet:read` / `wallet:topup` / `standby` | **只有 `ai` + `wallet:read`** |
 * | 明文在哪 | 用户本机加密库 | 子进程的环境变量，只传一次 |
 *
 * 为什么不复用 WP58 那张表：那张表上有一条不变量——"一个工作区同时只能有一条
 * 活着的关联"（一个工作区的钱只能从一个地方出，52 O3）。为子进程再签一条就破了它。
 *
 * 动作集里**没有 `standby`**：子进程不该能去开 / 停 / 导出任何工作区的值守，
 * 包括它自己的。一个被攻下来的租户进程，最多只能把这个租户自己的积分花掉。
 */
import type { CloudScope, Iso8601, VerifiedCloudToken, WorkspaceId } from '@agentsws/contracts'
import type { ChildTokenRow, StandbySecrets, StandbyTokenStore } from './types.js'

/** 子进程那把令牌能做的全部事。 */
export const CHILD_SCOPES: readonly CloudScope[] = ['ai', 'wallet:read']

/** 有效期（毫秒）。短是有意的：每次重拉都换一把新的，旧的当场作废。 */
export const CHILD_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000

/** 验过之后的样子：就是 WP58 那份（服务入口只认这个形状）。 */
export type VerifiedChildToken = VerifiedCloudToken

export interface ChildTokensOptions {
  store: StandbyTokenStore
  secrets: StandbySecrets
  now: () => Iso8601
  ttlMs?: number
}

export class ChildTokens {
  private readonly store: StandbyTokenStore
  private readonly secrets: StandbySecrets
  private readonly now: () => Iso8601
  private readonly ttlMs: number

  constructor(options: ChildTokensOptions) {
    this.store = options.store
    this.secrets = options.secrets
    this.now = options.now
    this.ttlMs = options.ttlMs ?? CHILD_TOKEN_TTL_MS
  }

  /**
   * 签一把。**同一个工作区之前那几把当场作废**——重拉一次换一把，
   * 于是"这个子进程崩过几次"不会在云上留下一串还能用的令牌。
   *
   * 明文只在返回值里出现一次；库里只有 sha256。
   */
  issue(input: { workspace_id: WorkspaceId; org_id: string; account_id: string }): string {
    const at = this.now()
    this.store.revokeAllOf(input.workspace_id, at)
    const token = this.secrets.newToken()
    this.store.put({
      sha256: this.secrets.sha256(token),
      workspace_id: input.workspace_id,
      org_id: input.org_id,
      account_id: input.account_id,
      issued_at: at,
      expires_at: new Date(Date.parse(at) + this.ttlMs).toISOString(),
    })
    return token
  }

  /**
   * 验一把。撤销 / 过期 / 根本不存在一律回 `undefined`——**不区分**，
   * 免得被拿来探测哪把令牌存在过（与 WP58 的 `CloudTokenVerifier` 逐字同一条）。
   */
  verify(token: string): VerifiedChildToken | undefined {
    const row: ChildTokenRow | undefined = this.store.bySha256(this.secrets.sha256(token))
    if (row === undefined) return undefined
    const at = this.now()
    if (row.revoked_at !== undefined) return undefined
    if (row.expires_at <= at) return undefined
    return {
      account_id: row.account_id,
      org_id: row.org_id,
      workspace_id: row.workspace_id,
      scopes: [...CHILD_SCOPES],
    }
  }

  /** 服务入口那边要的那个纯函数形状（`CloudTokenVerifier`）。 */
  verifier(): (token: string) => Promise<VerifiedChildToken | undefined> {
    return (token: string) => Promise.resolve(this.verify(token))
  }
}
