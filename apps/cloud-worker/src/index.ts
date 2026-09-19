/**
 * `@agentsws/cloud-worker` —— Agents 工坊云的**无服务器形态**（Cloudflare Workers
 * + Durable Objects，WP114 / docs/64）。
 *
 * 这个文件只有三样东西，都是给 `wrangler.toml` 认的：
 *
 * - `default export` 的 `fetch`：入口 Worker（逻辑在 `worker.ts`）；
 * - `AccountsDO`：账号那一层的单例对象（实现在 `accounts-do.ts`）；
 * - `WalletDO`：每个组织一个的钱包对象（实现在 `wallet-do.ts`）。
 *
 * 两个 DO 类都是**朴素类**（`constructor(state, env)` + `fetch` + `alarm`），
 * 不继承 `cloudflare:workers` 的基类——那样这个包在普通 tsc 下也编得过，
 * 测试不必起 workerd 就能把这两个类装起来。
 *
 * Compose / 自建形态在 `apps/cloud` + `deploy/`，**保留不删**（docs/61）。
 * 两个形态跑的是同一份路由表与同一段鉴权（`@agentsws/cloud` 的 `buildCloudApp`）。
 */

export { AccountsCore, IDEMPOTENCY_SWEEP_MS } from './accounts-do.js'
export { type DoSqlCursor, type DoSqlStorage, type DoStorageLike, doSyncDb } from './do-sql.js'
export { envRecord, type WorkerEnv } from './env.js'
export {
  INTERNAL_HEADER_NAMES,
  INTERNAL_HEADERS,
  jsonArrayFrom,
  principalFrom,
  stripInternalHeaders,
  withInternalHeaders,
} from './internal.js'
export {
  handleKolAdmin,
  KOL_ADMIN_INTERNAL,
  KOL_PUBLIC_SINGLETON,
  type KolNamespaceLike,
  remoteKolAdminPort,
} from './kol-admin.js'
export {
  KolPublicCore,
  type KolPublicDoOptions,
  type KolPublicDoStateLike,
} from './kol-public-do.js'
export {
  BILLING_SWEEP_MS,
  KOL_TENANT_INTERNAL,
  KolTenantCore,
  type KolTenantDoOptions,
  type KolTenantDoStateLike,
} from './kol-tenant-do.js'
export {
  applyKolOps,
  handleKolWallet,
  KOL_WALLET_INTERNAL,
  type KolApplyInput,
  type KolApplyResult,
  type KolReserveFailure,
  type KolReserveInput,
} from './kol-wallet.js'
export {
  copyEventsTo,
  copyLotsTo,
  LEDGER_COPY_BATCH,
  LEDGER_INTERNAL,
  LEDGER_SINGLETON,
  LedgerCore,
  remoteUsageLedger,
} from './ledger-do.js'
export {
  createOutbox,
  OUTBOX_MIGRATIONS,
  OUTBOX_MIGRATIONS_TABLE,
  type Outbox,
  outboxEventKey,
} from './outbox.js'
export {
  handleWalletAdmin,
  remoteWalletAdminPort,
  WALLET_ADMIN_INTERNAL,
  type WalletNamespaceLike,
} from './wallet-admin.js'
export {
  chargeOnce,
  handleSubscriptionWallet,
  remoteSubscriptionWallet,
  SUBSCRIPTION_WALLET_INTERNAL,
  type SubscriptionChargeInput,
} from './subscription-wallet.js'
export {
  DEFAULT_WORKER_UPSTREAM,
  RESERVATION_MAX_AGE_MS,
  RESERVATION_SWEEP_MS,
  WalletCore,
} from './wallet-do.js'
export {
  ACCOUNTS_SINGLETON,
  ADMIN_ASSET_PREFIX,
  ADMIN_TOPUP_PATH,
  isAdminPath,
  isWalletPath,
  normalizeClientIp,
  orgOfStripePayload,
  remoteVerifier,
  route,
  STRIPE_WEBHOOK_PATH,
  secretEquals,
} from './worker.js'

import { AccountsCore, type DoStateLike } from './accounts-do.js'
import type { WorkerEnv } from './env.js'
import { KolPublicCore, type KolPublicDoStateLike } from './kol-public-do.js'
import { KolTenantCore, type KolTenantDoStateLike } from './kol-tenant-do.js'
import { LedgerCore } from './ledger-do.js'
import { WalletCore, type WalletDoStateLike } from './wallet-do.js'
import { route } from './worker.js'

/**
 * 账号那一层（单例）。
 *
 * 装配（开库、跑迁移、拼发信口）在**构造函数里**，而构造函数在这个对象第一次
 * 被唤醒时跑一次。所以"升级怎么迁移"没有单独的一步：新版本 deploy 上去，
 * 对象下次醒来自己把缺的版本补上。
 */
export class AccountsDO {
  readonly #core: AccountsCore

  constructor(state: DoStateLike, env: WorkerEnv) {
    this.#core = new AccountsCore(state, env)
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request)
  }

  async alarm(): Promise<void> {
    await this.#core.alarm()
  }
}

/**
 * 计量事件的只读副本（**单例**，WP115 / 65 §9）。
 *
 * 钱按组织切开之后没有一张跨全部组织的表，而后台的总览 / 台账要的正是那个。
 * 每条计量事件由源头 `WalletDO` 抄一份进来（`ctx.waitUntil`，失败进待补队列、
 * alarm 重投）。**只增不改**：这个对象上没有一条改或删计量事件的路由。
 */
export class LedgerDO {
  readonly #core: LedgerCore

  constructor(state: { storage: DoStateLike['storage'] }) {
    this.#core = new LedgerCore(state)
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request)
  }
}

/**
 * 公共红人库（**全局一个**，WP116 / 64 §10.2）。
 *
 * 这张红人表是跨租户共享的一层事实，所以只有一个对象、只有一个名字
 * （`KOL_PUBLIC_SINGLETON`）。钱不在这里——它拿到的钱包是一台录音机，
 * 真正的预扣与结算发生在 `WalletDO` 里（见 `kol-public-do.ts` 的头注释）。
 *
 * **没有 alarm**：它不管钱，也没有孤儿预扣要扫。基准缓存过期不清也读不到
 * 过期数据（`BENCHMARK_CACHE_MS` 在读的时候判），所以这个对象醒着的时间
 * 就是有人查库的时间。
 */
export class KolPublicDO {
  readonly #core: KolPublicCore

  constructor(state: KolPublicDoStateLike, env: WorkerEnv) {
    this.#core = new KolPublicCore(state, env)
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request)
  }
}

/**
 * 红人营销增值服务的租户库（**每个组织一个**，WP118 / 67 §3）。
 *
 * 与上面那个公共库刚好相反：公共库是跨租户共享的事实（一个对象），这一份是
 * 一个组织自己的私有数据（一个组织一个对象）——对象边界就是隔离边界。
 *
 * **有 alarm**：每天醒一次把到点的月费扣掉（幂等，重跑不会多扣）。
 */
export class KolTenantDO {
  readonly #core: KolTenantCore

  constructor(state: KolTenantDoStateLike, env: WorkerEnv) {
    this.#core = new KolTenantCore(state, env)
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request)
  }

  async alarm(): Promise<void> {
    await this.#core.alarm()
  }
}

/** 钱包（每个组织一个）。 */
export class WalletDO {
  readonly #core: WalletCore

  constructor(state: WalletDoStateLike, env: WorkerEnv) {
    this.#core = new WalletCore(state, env)
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request)
  }

  async alarm(): Promise<void> {
    await this.#core.alarm()
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return route(request, env)
  },
}
