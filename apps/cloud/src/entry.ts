/**
 * 49 M3：把 WP59 的服务入口（`packages/cloud-entry`：`/v1/ai/*` 转发 + `/v1/wallet/*`）
 * 挂进这个进程。
 *
 * 为什么不是走 `modules: CloudRoute[][]` 那个挂载点：入口路由包有自己的一套
 * 鉴权中间件（令牌 → principal → scope；错误信封按 402 / 422 那套语义），与账号层的
 * `CloudRoute` 形状不同。硬把两套拧成一种形状只会让"余额不足"与"令牌无效"共用一个
 * 错误码表。所以这里直接把入口路由挂到同一个 Hono 应用上——同一个端口、同一份令牌
 * 验证（`server.verifyToken`），但各管各的中间件。
 *
 * 纪律与 49 M6 一致：
 * - New API 的内部密钥与 Stripe 的密钥**只从环境变量读**，而且是回调（用到那一刻才取）；
 * - 钱包库与账号库分开文件（`wallet.sqlite` / `cloud.sqlite`），同一个数据目录；
 * - 这里不记任何正文，`onEvent` 只把 `wallet.low_balance` 这类计量事件打到 stdout。
 */
import { join } from 'node:path'
import {
  type AiUpstream,
  type EntryDeps,
  type EntryEnv,
  type FetchLike,
  mountEntryRoutes,
  type SearchUpstream,
  type StripeConfig,
  searchProviderOf,
} from '@agentsws/cloud-entry'
import type { Clock, CloudTokenVerifier, Pricing } from '@agentsws/contracts'
import {
  buildPricing,
  createSqliteWalletStore,
  MemoryWalletStore,
  Wallet,
  type WalletEvent,
  type WalletStore,
} from '@agentsws/metering'
import type { Hono } from 'hono'
import type { CloudServer } from './server.js'

/** 入口那一层认的环境变量名（值一个都不在仓库里；见 `packages/cloud-entry/README.md`）。 */
export const ENTRY_ENV = {
  newapiKey: 'AGENTSWS_NEWAPI_KEY',
  newapiBaseUrl: 'AGENTSWS_NEWAPI_BASE_URL',
  stripeSecretKey: 'STRIPE_SECRET_KEY',
  stripeWebhookSecret: 'STRIPE_WEBHOOK_SECRET',
  publicUrl: 'AGENTSWS_CLOUD_PUBLIC_URL',
  /** WP155：官方数据接口的搜索数据服务商（非敏感）与它的 key（敏感）。 */
  searchProvider: 'AGENTSWS_SEARCH_DATA_PROVIDER',
  searchKey: 'AGENTSWS_SEARCH_DATA_KEY',
} as const

export const DEFAULT_NEWAPI_BASE_URL = 'http://127.0.0.1:3000/v1'

export interface MountEntryOptions {
  env?: Record<string, string | undefined>
  clock?: Clock
  /** 钱包库放哪个目录；不给 = 内存（测试）。 */
  dataDir?: string
  /** 已有的钱包存储（测试注入内存版并预充值）。给了就不按 `dataDir` 开库。 */
  walletStore?: WalletStore
  /** 打上游 / Stripe 用的 fetch（测试注入假上游 → 全程不联网、不花钱）。 */
  fetch?: FetchLike
  pricing?: Pricing
  upstream?: AiUpstream
  /** WP155：搜索数据那一家（测试注入替身 key + 假上游；不给就从环境变量读）。 */
  search?: SearchUpstream
  stripe?: StripeConfig
  onWalletEvent?: (e: WalletEvent) => void
  newRequestId?: () => string
  /**
   * 验令牌用哪一个。不给就是 WP58 的账号库那个。
   *
   * WP60 把它串成两个：先账号库（商家那把），再值守（子进程那把内部令牌）——
   * 子进程也要用 `/v1/ai/*`，但它那把不在 `workspace_links` 里（见
   * `packages/standby/src/child-token.ts` 的头注释）。
   */
  verifier?: CloudTokenVerifier
}

export interface MountedEntry {
  wallet: Wallet
  pricing: Pricing
  store: WalletStore
}

export function walletDbPath(dataDir: string | undefined): string {
  if (dataDir === undefined || dataDir.trim() === '') return ':memory:'
  return join(dataDir, 'wallet.sqlite')
}

/**
 * 把服务入口挂到 `server.app` 上。返回钱包句柄（部署脚本要用它跑 `sweepReservations`，
 * 测试要用它预充值）。
 */
export function mountEntry(server: CloudServer, options: MountEntryOptions = {}): MountedEntry {
  const env = options.env ?? process.env
  const now = (): string => (options.clock ?? { now: () => new Date().toISOString() }).now()
  const store =
    options.walletStore ??
    (options.dataDir === undefined
      ? new MemoryWalletStore()
      : createSqliteWalletStore({ dbPath: walletDbPath(options.dataDir), now }))
  let seq = 0
  const wallet = new Wallet({
    store,
    now,
    newId: (prefix) => `${prefix}_${now().replace(/\D/g, '').slice(0, 14)}_${String(++seq)}`,
    ...(options.onWalletEvent === undefined
      ? {
          onEvent: (e: WalletEvent) => {
            // 计量事件只有能力 / 单位 / 数量 / 积分 / 时间 / 工作区（49 M6）——打出来也不会泄露什么
            process.stdout.write(`[wallet] ${e.type} org=${e.org_id}\n`)
          },
        }
      : { onEvent: options.onWalletEvent }),
  })
  const pricing = options.pricing ?? buildPricing()
  const upstream: AiUpstream = options.upstream ?? {
    base_url: env[ENTRY_ENV.newapiBaseUrl] ?? DEFAULT_NEWAPI_BASE_URL,
    api_key: () => env[ENTRY_ENV.newapiKey],
  }
  const publicUrl = env[ENTRY_ENV.publicUrl]
  const stripe: StripeConfig = options.stripe ?? {
    secret_key: () => env[ENTRY_ENV.stripeSecretKey],
    webhook_secret: () => env[ENTRY_ENV.stripeWebhookSecret],
    ...(publicUrl === undefined ? {} : { return_url: publicUrl }),
  }
  // WP155：搜索数据那一家——认不出的服务商名当没开通（不猜）；key 用到那一刻才取
  const searchNamed = (env[ENTRY_ENV.searchProvider] ?? '').trim().toLowerCase() || 'dataforseo'
  const searchAdapter = searchProviderOf(searchNamed)
  const search: SearchUpstream = options.search ?? {
    provider: searchAdapter?.id ?? 'dataforseo',
    api_key: () => (searchAdapter === undefined ? undefined : env[ENTRY_ENV.searchKey]),
  }
  const deps: EntryDeps = {
    verifier: options.verifier ?? server.verifyToken,
    wallet,
    pricing,
    upstream: { ai: upstream, search },
    stripe,
    now,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.newRequestId === undefined ? {} : { newRequestId: options.newRequestId }),
  }
  // 两个 Hono 环境只差 `Variables` 的形状；入口的中间件自己 set 自己那几个键，互不读对方的
  mountEntryRoutes(server.app as unknown as Hono<EntryEnv>, deps)
  return { wallet, pricing, store }
}
