/**
 * `KolPublicDO` —— 公共红人库那一层的 Durable Object，**全局一个**（WP116 / 64 §10.2）。
 *
 * 为什么是单例：这张红人表是**跨租户共享的一层事实**（48 §1.2）。按组织切开
 * 就等于每个组织自己攒一份，而公共库的全部价值就在"一个人报的，所有人受益"。
 *
 * 钱**不在这里**。钱按组织切在 `WalletDO` 里，所以这个对象拿到的 `wallet`
 * 是一台**录音机**（`@agentsws/kol-public` 的 `deferredWallet`）：
 * 预扣是入口做好递进来的，结算 / 释放 / 返额度只记在一张纸上，回到入口
 * 再去钱那个对象照单执行。三跳的顺序与 `/v1/ai/*` 完全一样，
 * 只是中间那一跳换成了"查库 / 打上游"。
 *
 * 一个请求里的那台录音机用 `AsyncLocalStorage` 拿——**不是**模块级变量：
 * DO 单线程但请求会在 await 处交错，一个可变的"当前钱包"会把 A 的账记到 B 头上
 * （与 `wallet-do.ts` 里 `PRINCIPAL` 那条注释同一个理由）。
 *
 * 上游密钥（`AGENTSWS_YOUTUBE_API_KEY` / `APIFY_TOKEN`）只从 Worker secret 读，
 * 一个都没配也要能起——那就是"只查库"。邮箱密钥（`AGENTSWS_KOL_EMAIL_KEY`）
 * 没配就**不存邮箱**，health 那一格标黄（64 §10.2）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Clock, Pricing, VerifiedCloudToken } from '@agentsws/contracts'
import {
  type DeferredWallet,
  deferredWallet,
  type KolAdminPort,
  type KolEnv,
  type KolWallet,
  type KolWalletOp,
  KolPublicService,
  type KolSecrets,
  kolSourcesFromEnv,
  localKolAdminPort,
  mountKolPublicRoutes,
  nodeKolSecrets,
  type SourceLookup,
  SqliteKolStore,
} from '@agentsws/kol-public'
import { buildPricing, type WalletReservation } from '@agentsws/metering'
import { Hono } from 'hono'
import type { DoStorageLike } from './do-sql.js'
import { doSyncDb } from './do-sql.js'
import { envRecord, type WorkerEnv } from './env.js'
import { INTERNAL_HEADERS, jsonArrayFrom, principalFrom } from './internal.js'
import { handleKolAdmin } from './kol-admin.js'

/** 这一次请求的那台录音机。 */
const CURRENT = new AsyncLocalStorage<DeferredWallet>()

/** 这一次请求的 principal（与 `wallet-do.ts` 里那一个同样的理由用 ALS）。 */
const PRINCIPAL = new AsyncLocalStorage<VerifiedCloudToken>()

export interface KolPublicDoStateLike {
  readonly storage: DoStorageLike
}

export interface KolPublicDoOptions {
  clock?: Clock
  pricing?: Pricing
  /** 测试注入：假的外部源（**不联网、不花钱**）。 */
  sources?: SourceLookup
  /** 测试注入：假的哈希 / 加密（不给就按环境变量拼）。 */
  secrets?: KolSecrets
  newId?: (prefix: string) => string
}

/**
 * 录音机的**代理**：服务只拿到这一个对象，每次调用去 ALS 里找当下那一台。
 *
 * 没有作用域就抛：那意味着有人绕过 `fetch` 直接调服务，而那样的调用会
 * **无声地不扣钱**。装配错误要吵，不要省。
 */
function proxyWallet(): KolWallet {
  const current = (): KolWallet => {
    const found = CURRENT.getStore()
    if (found === undefined)
      throw new Error('公共红人库的钱包只在一次请求的作用域里可用（WP116 两段式）')
    return found.wallet
  }
  return {
    reserve: (args) => current().reserve(args),
    settle: (reservation, actual) => current().settle(reservation, actual),
    release: (reservation) => current().release(reservation),
    topup: (args) => current().topup(args),
  }
}

export class KolPublicCore {
  readonly store: SqliteKolStore
  readonly service: KolPublicService
  readonly admin: KolAdminPort
  /** 邮箱密钥配了没有（health 那一格看它）。 */
  readonly emailKeyReady: boolean
  readonly #app: Hono<KolEnv>

  constructor(state: KolPublicDoStateLike, env: WorkerEnv, options: KolPublicDoOptions = {}) {
    const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
    const now = (): string => clock.now()
    const record = envRecord(env)
    /*
     * 迁移在第一次唤醒时同步跑完（`SqliteKolStore` 的构造函数里就是
     * 一串 `CREATE TABLE IF NOT EXISTS`）。升级 = 再 deploy 一次，见 docs/64 §8。
     *
     * `SyncDb` 结构上满足 `SqliteLike`，所以**业务 SQL 一个字都不用改**——
     * 与钱包、账号库同一条路（WP114）。
     */
    this.store = new SqliteKolStore(doSyncDb(state.storage))
    const secrets = options.secrets ?? nodeKolSecrets({ env: record })
    this.emailKeyReady = secrets.available
    let seq = 0
    const newId =
      options.newId ??
      ((prefix: string) => `${prefix}_${now().replace(/\D/g, '').slice(0, 14)}_${String(++seq)}`)
    this.service = new KolPublicService({
      store: this.store,
      wallet: proxyWallet(),
      pricing: options.pricing ?? buildPricing(),
      secrets,
      now,
      newId,
      sources: options.sources ?? kolSourcesFromEnv(record, this.store),
    })
    this.admin = localKolAdminPort({ store: this.store, secrets, now })

    /*
     * 令牌在这里不验第二遍：入口已经问过 `AccountsDO`（每次都问）。
     * 这个对象只信来自入口的调用——它在公网上没有地址。
     */
    const app = new Hono<KolEnv>()
    mountKolPublicRoutes(app, {
      service: this.service,
      verifier: async () => PRINCIPAL.getStore(),
    })
    this.#app = app
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // 后台那几条（统计 / 搜索 / 移除 / 搬家）走内部路由，不进公共库的路由表
    const adminRes = await handleKolAdmin(this, request, url)
    if (adminRes !== undefined) return adminRes
    /*
     * 入口做好的那几笔预扣（通常 0 或 1 笔）。录音机拿它当"已经预扣过了"，
     * 自己**不造**任何一笔——造得出来就等于这个对象能凭空放行一次付费调用。
     */
    const recorder = deferredWallet({
      reservations: jsonArrayFrom(
        request.headers,
        INTERNAL_HEADERS.kolReservations,
      ) as WalletReservation[],
      now: () => new Date().toISOString(),
    })
    const principal = principalFrom(request)
    const run = async (): Promise<Response> => {
      const res = await CURRENT.run(recorder, () => this.#app.fetch(request))
      // 记下来的那几笔放在响应头上带回入口（入口读完就删，用户看不见）
      const headers = new Headers(res.headers)
      if (recorder.ops.length > 0)
        headers.set(INTERNAL_HEADERS.kolOps, JSON.stringify(recorder.ops satisfies KolWalletOp[]))
      return new Response(res.body, { status: res.status, headers })
    }
    return principal === undefined ? run() : PRINCIPAL.run(principal, run)
  }
}
