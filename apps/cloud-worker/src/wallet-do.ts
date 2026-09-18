/**
 * `WalletDO` —— 钱那一层的 Durable Object，**每个组织一个**（WP114）。
 *
 * `idFromName(org_id)`：一个组织的 lots、预扣、计量事件全在自己那一个对象里，
 * 而 DO 同一时刻只有一个线程在跑。于是：
 *
 * - **钱包全同步这条纪律在云上原样成立**——`reserve` 与 `settle` 之间没有一个
 *   await 让别的请求插进来（`packages/metering/src/wallet.ts` 的头注释）；
 * - 组织之间天然互不阻塞——A 在跑一条长流式，B 的余额照查不误。
 *
 * 这里跑三块路由，都是**现成的包**，不是重写的：
 *
 * | 路由 | 从哪来 |
 * |---|---|
 * | `/v1/ai/*`、`/v1/wallet/*` | `@agentsws/cloud-entry` 的 `mountEntryRoutes` |
 * | `/v1/admin/topup` | `@agentsws/cloud` 的 `adminRoutes` |
 *
 * **令牌在这里不验第二遍**：Worker 进门时已经问过 `AccountsDO`（每次都问，
 * 不缓存——撤销要立刻生效），把验完的 principal 放进内部头。这个 DO 只信
 * 来自 Worker 的调用（它在公网上没有地址），所以 `verifier` 就是"把内部头里
 * 那一份拿出来"。403（差 scope）与 402（余额不够）仍然在这里判——
 * 那两件事本来就该在钱这一侧判。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  IDEMPOTENCY_MIGRATIONS_TABLE,
  SqlIdempotencyStore,
  type SweepableIdempotencyStore,
} from '@agentsws/api'
import {
  ADMIN_TOKEN_ENV,
  ADMIN_TOKEN_MIN_BYTES,
  type AdminAccountsLookup,
  adminRoutes,
  cloudIdempotency,
  createCloudHono,
} from '@agentsws/cloud/workers-kit'
import {
  type AiUpstream,
  type EntryDeps,
  type EntryEnv,
  mountEntryRoutes,
  type StripeConfig,
} from '@agentsws/cloud-entry'
import type { Clock, CloudTokenVerifier, Pricing, VerifiedCloudToken } from '@agentsws/contracts'
import { buildPricing, createSqlWalletStore, type SqlWalletStore, Wallet } from '@agentsws/metering'
import type { Hono } from 'hono'
import type { DoStorageLike } from './do-sql.js'
import { doSyncDb } from './do-sql.js'
import type { WorkerEnv } from './env.js'
import { INTERNAL_HEADERS, principalFrom } from './internal.js'

/** 预扣多久扫一次（与 Compose 形态的 `SWEEP_INTERVAL_MS` 同一个数）。 */
export const RESERVATION_SWEEP_MS = 10 * 60 * 1000
/** 一笔预扣多老算孤儿（与 Compose 形态的 `RESERVATION_MAX_AGE_MS` 同一个数）。 */
export const RESERVATION_MAX_AGE_MS = 60 * 60 * 1000

/** 模型上游的默认地址。内测期直接指一家 OpenAI 兼容的官方口。 */
export const DEFAULT_WORKER_UPSTREAM = 'https://api.deepseek.com/v1'

/**
 * 这一次请求的 principal。
 *
 * 为什么是 `AsyncLocalStorage` 而不是一个模块级变量：DO 同一时刻只跑一个线程，
 * 但**请求会在 await 处交错**——一个可变的"当前 principal"会在两条流式请求
 * 之间串号，而串号意味着把 A 的调用记到 B 的账上。ALS 是这里唯一正确的办法。
 */
const PRINCIPAL = new AsyncLocalStorage<VerifiedCloudToken>()

export interface WalletDoStateLike {
  readonly storage: DoStorageLike & {
    setAlarm(when: number): Promise<void> | void
    getAlarm(): Promise<number | null> | number | null
  }
}

export interface WalletDoOptions {
  clock?: Clock
  pricing?: Pricing
  /** 测试注入假上游 → 全程不联网、不花钱。 */
  fetch?: EntryDeps['fetch']
  newRequestId?: () => string
}

export class WalletCore {
  readonly store: SqlWalletStore
  readonly wallet: Wallet
  readonly pricing: Pricing
  readonly idempotency: SweepableIdempotencyStore
  readonly #app: Hono<EntryEnv>
  readonly #state: WalletDoStateLike
  readonly #clock: Clock

  constructor(state: WalletDoStateLike, env: WorkerEnv, options: WalletDoOptions = {}) {
    this.#state = state
    const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
    this.#clock = clock
    const now = (): string => clock.now()
    const db = doSyncDb(state.storage)
    // 迁移在第一次唤醒时跑完（同步）——升级 = 再 deploy 一次，见 docs/64 §8
    this.store = createSqlWalletStore({ db, now })
    // 幂等表与钱包住在同一张 DO SQLite 里 → 版本号表另起一个名字（见 AccountsDO 那条注释）
    this.idempotency = new SqlIdempotencyStore({
      db,
      clock,
      migrationsTable: IDEMPOTENCY_MIGRATIONS_TABLE,
    })

    let seq = 0
    this.wallet = new Wallet({
      store: this.store,
      now,
      newId: (prefix) => `${prefix}_${now().replace(/\D/g, '').slice(0, 14)}_${String(++seq)}`,
      onEvent: (e) => {
        // 计量事件只有能力 / 单位 / 数量 / 积分 / 时间 / 工作区（49 M6）
        console.log(`[wallet] ${e.type} org=${e.org_id}`)
      },
    })
    this.pricing = options.pricing ?? buildPricing()

    const upstream: AiUpstream = {
      base_url: env.AGENTSWS_NEWAPI_BASE_URL ?? DEFAULT_WORKER_UPSTREAM,
      // key 是取值回调：用到那一刻才取，不在配置对象里长住（22 §5）
      api_key: () => env.AGENTSWS_NEWAPI_KEY,
    }
    const stripe: StripeConfig = {
      secret_key: () => env.STRIPE_SECRET_KEY,
      webhook_secret: () => env.STRIPE_WEBHOOK_SECRET,
      ...(env.AGENTSWS_CLOUD_PUBLIC_URL === undefined
        ? {}
        : { return_url: env.AGENTSWS_CLOUD_PUBLIC_URL }),
    }

    /*
     * 令牌验证那一跳：Worker 已经验过了，这里只把内部头里那一份拿出来。
     * 拿不出来就回 `undefined` —— 入口那一层会翻成 401，与"令牌无效"同一句话。
     */
    const verifier: CloudTokenVerifier = async () => PRINCIPAL.getStore()

    const app = createCloudHono()
    const deps: EntryDeps = {
      verifier,
      wallet: this.wallet,
      pricing: this.pricing,
      upstream: { ai: upstream },
      stripe,
      now,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.newRequestId === undefined ? {} : { newRequestId: options.newRequestId }),
    }
    // 两个 Hono 环境只差 `Variables` 的形状；各自的中间件只读自己 set 的那几个键
    mountEntryRoutes(app as unknown as Hono<EntryEnv>, deps)

    /*
     * 管理员手动发积分（WP110）。组织是 Worker 在转发之前解析好的，所以这里
     * 给进去的账号库是一个"已经验过"的极小实现——它只回答"这个组织在不在"，
     * 而答案永远是"在"（不在的话请求根本到不了这个对象）。
     */
    const adminToken = (env[ADMIN_TOKEN_ENV] ?? '').trim()
    if (adminToken !== '') {
      if (new TextEncoder().encode(adminToken).length < ADMIN_TOKEN_MIN_BYTES)
        throw new Error(
          `${ADMIN_TOKEN_ENV} 太短（至少 ${String(ADMIN_TOKEN_MIN_BYTES)} 字节）：` +
            '用 `openssl rand -base64 48` 生成一个，别自己编。',
        )
      const accounts: AdminAccountsLookup = {
        accountByEmail: () => undefined,
        primaryOrg: () => undefined,
        org: (id) => ({ id }),
      }
      const idempotent = cloudIdempotency({ store: this.idempotency, clock })
      for (const r of adminRoutes({
        clock,
        token: adminToken,
        accounts: () => accounts,
        wallet: () => ({ wallet: this.wallet, store: this.store }),
        log: (line) => {
          console.log(line.trimEnd())
        },
      })) {
        app.on(r.spec.method.toUpperCase(), [r.spec.path], idempotent, (c) => r.handler(c))
      }
    }

    this.#app = app as unknown as Hono<EntryEnv>
  }

  async fetch(request: Request): Promise<Response> {
    const principal = principalFrom(request)
    const run = async (): Promise<Response> => {
      const res = await this.#app.fetch(request)
      await this.armAlarm()
      return res
    }
    // 没有内部头（管理员那条路由就没有）就不开 ALS 作用域
    return principal === undefined ? run() : PRINCIPAL.run(principal, run)
  }

  /**
   * 闹钟：扫孤儿预扣 + 过期幂等键。
   *
   * **不是 Cron 扫全体组织**：每个 WalletDO 自己管自己那一份，没有预扣就不续
   * 下一拍。一万个组织里只有三个在用的时候，醒来的也只有那三个。
   */
  sweep(): { reservations: number; idempotency: number } {
    const olderThan = new Date(Date.parse(this.#clock.now()) - RESERVATION_MAX_AGE_MS).toISOString()
    let reservations = 0
    let idempotency = 0
    // 一件失败不该让另一件也不跑——定时任务把请求带走是最糟的那种失败
    try {
      reservations = this.store.sweepReservations(olderThan)
    } catch {
      reservations = 0
    }
    try {
      idempotency = this.idempotency.sweep(this.#clock)
    } catch {
      idempotency = 0
    }
    return { reservations, idempotency }
  }

  async alarm(): Promise<{ reservations: number; idempotency: number }> {
    const out = this.sweep()
    await this.armAlarm(true)
    return out
  }

  /** 有预扣（或有幂等键）才续闹钟；两样都没有就让这个对象安静睡着。 */
  async armAlarm(force = false): Promise<void> {
    const wanted = this.store.hasReservations() || this.idempotency.size > 0
    if (!wanted) return
    if (!force) {
      const current = await this.#state.storage.getAlarm()
      if (current !== null && current !== undefined) return
    }
    await this.#state.storage.setAlarm(Date.parse(this.#clock.now()) + RESERVATION_SWEEP_MS)
  }
}

/** 内部头的名字从这里转出去，`index.ts` 与测试共用同一份。 */
export { INTERNAL_HEADERS }
