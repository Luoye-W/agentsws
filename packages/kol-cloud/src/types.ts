/**
 * 红人营销增值服务的装配面（67 §3，WP118）。
 *
 * 这个包是**一个路由包，不是一个服务**：它导出 `mountKolCloudRoutes(app, deps)`，
 * 由云侧那个进程挂上去（Compose 形态 `apps/cloud/src/kol-cloud.ts`，Workers 形态
 * `apps/cloud-worker` 的 `KolTenantDO`）——与 WP61 的 `packages/kol-public`、
 * WP59 的 `packages/cloud-entry` 同一种形状。
 *
 * 与 `packages/kol-public`（公共红人库）的关系：**两层，零共用**。
 *
 * | | 公共红人库（WP61/116） | 云端红人库（这里） |
 * |---|---|---|
 * | 数据是谁的 | 跨租户共享的一层事实 | **一个组织自己的**（私有） |
 * | 对象怎么落 | 全局一个 `KolPublicDO` | **每个 org 一个** `KolTenantDO` |
 * | 怎么收钱 | 按次（reveal / 体检） | **按月订阅**（30 积分） |
 * | 主键 | `(channel, handle)` 自足键 | `(kind, id)`——本地那份数据的 id |
 *
 * 纪律：
 *
 * 1. **没订阅不给同步（402），但一条数据都不删**。余额不足也一样：同步暂停、
 *    宽限 30 天。删数据只能由用户自己按那颗按钮（`DELETE /v1/kol/cloud`）。
 * 2. **冲突不静默丢**：输的那一份留在 `kol_cloud_conflicts` 里，导出时一起带走。
 * 3. **云端读得懂数据**（Luoye 09-19）：没有端到端加密、没有恢复口令——看不懂就
 *    替用户跑不了任务。联系方式那一格照旧用 `AGENTSWS_KOL_EMAIL_KEY` 再包一层。
 */

import type { Iso8601 } from '@agentsws/contracts'

/** 这个包认的错误码（与 28 §2 的信封同一张表）。 */
export type KolCloudErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'payment_required'
  | 'invalid_input'
  | 'not_found'
  | 'internal'

const STATUS: Record<KolCloudErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  payment_required: 402,
  invalid_input: 400,
  not_found: 404,
  internal: 500,
}

/**
 * 一句人话 + 一个码。
 *
 * `message` 是**直接进界面**的那一句，所以它里面不许有 org_id、令牌、表名。
 */
export class KolCloudError extends Error {
  readonly code: KolCloudErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: KolCloudErrorCode,
    message: string,
    options: { details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'KolCloudError'
    this.code = code
    this.status = STATUS[code]
    this.details = options.details
  }
}

/** 验完令牌之后的主体（**没有令牌明文**）。 */
export interface KolCloudPrincipal {
  account_id: string
  org_id: string
  workspace_id: string
  scopes: readonly string[]
}

/** Hono 的 `Variables`（这个包只往上下文里放一个东西）。 */
export interface KolCloudEnv {
  Variables: { kol_cloud_principal?: KolCloudPrincipal }
}

/**
 * 库那一口（`better-sqlite3` 与 Durable Object 的 `SyncDb` 都满足它）。
 *
 * 与 `packages/kol-public` 里那一个逐字相同，**刻意不共用**：两个包之间不该
 * 因为一个结构类型而产生依赖（那条依赖会把公共库的整棵类型树拖进租户库）。
 */
export interface SqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close?(): void
}

/**
 * 扣一次月费的结果。**不抛**——扣不上是业务里正常的一半（余额不够），
 * 抛出去会让调用方在"这个对象坏了"与"这个用户没钱"之间分不清。
 */
export type SubscriptionChargeOutcome =
  | { ok: true; credits: number }
  | { ok: false; reason: string }

/**
 * 钱那一跳。两份实现：
 *
 * - Compose 形态：直接拿进程里的 `Wallet`（`localSubscriptionWallet`）；
 * - Workers 形态：打一条内部路由去这个组织的 `WalletDO`（`apps/cloud-worker`）。
 *
 * 抽成一个口子是因为**钱的读写不能跨 await**（见 `packages/metering/src/wallet.ts`）：
 * 两个形态里钱都在自己那一侧同步做完，这个包只拿到一个"成了 / 没成"。
 */
export interface SubscriptionWallet {
  charge(args: {
    org_id: string
    workspace_id: string
    capability: string
    credits: number
    /** 幂等键（`sub:<service>:<org>:<cycle 起始那一天>`）。 */
    request_id: string
  }): Promise<SubscriptionChargeOutcome>
}

/** 审计里的一行（用户数据权利那几条动作，49 §5 / 21 §4）。 */
export interface KolCloudAuditRow {
  at: Iso8601
  org_id: string
  /** `subscribe` / `cancel` / `grant` / `charge` / `export` / `delete` / `sync`。 */
  action: string
  /** 谁干的：`ws:<workspace_id>` 或 `admin`。 */
  actor: string
  /** 一句人话的补充（**不放任何红人数据**）。 */
  note?: string
}
