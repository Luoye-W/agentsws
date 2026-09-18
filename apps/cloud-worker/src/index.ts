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
  principalFrom,
  stripInternalHeaders,
  withInternalHeaders,
} from './internal.js'
export {
  DEFAULT_WORKER_UPSTREAM,
  RESERVATION_MAX_AGE_MS,
  RESERVATION_SWEEP_MS,
  WalletCore,
} from './wallet-do.js'
export {
  ACCOUNTS_SINGLETON,
  ADMIN_TOPUP_PATH,
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

  alarm(): void {
    this.#core.alarm()
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
