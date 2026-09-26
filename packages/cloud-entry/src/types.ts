/**
 * 服务入口的装配面（49 M3）。
 *
 * 这个包是**一个路由包，不是一个服务**：它只导出 `entryRoutes(deps)`，
 * 由云侧那个进程（WP58 的 `apps/cloud`）挂上去。这样两件事分得开——
 * 账号 / 令牌 / 组织在那边，价目 / 钱包 / 转发在这边，合并时不会撞同一个文件。
 */
import type { CloudTokenVerifier, Pricing, SearchDataProvider } from '@agentsws/contracts'
import type { CostTable, Wallet } from '@agentsws/metering'
import type { Context } from 'hono'
import type { SearchCache } from './search/cache.js'

/**
 * 令牌验证：就是 WP58 契约里那份 `CloudTokenVerifier`（合并时由局部声明改成别名）。
 * 验不过回 `undefined`（不抛）：抛异常会让"令牌过期"和"验证服务挂了"长得一样。
 */
export type TokenVerifier = CloudTokenVerifier

/** 验过之后挂在请求上下文里的那一份（**从不含令牌明文**）。 */
export interface EntryPrincipal {
  account_id: string
  org_id: string
  workspace_id: string
  scopes: string[]
}

/** 模型名 → 这个模型在哪些区可用。`cn` 在列表里才允许境内请求用它（22 §2）。 */
export type RegionMap = Record<string, ('cn' | 'global')[]>

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** 模型汇聚层（New API）。**不把它暴露给用户**（49 M6）：只有我们这一层打它。 */
export interface AiUpstream {
  /** New API 的 OpenAI 兼容口根地址（`https://…/v1`）。 */
  base_url: string
  /**
   * 内部密钥。**只从环境变量 `AGENTSWS_NEWAPI_KEY` 读**（装配方负责取），
   * 给回调而不是给值——key 不在配置对象里长住，与 22 §5「业务代码里没有 key」同一条纪律。
   * 直接给字符串也认（测试里省事）。
   */
  api_key: string | (() => string | undefined)
  /** 不给的话按价目表里那条 `cn` 判（`pricing.json` 的 `cn_vendors`）。 */
  region_map?: RegionMap
}

/**
 * WP155：官方数据接口的搜索数据那一家（docs/81）。**不暴露给用户**——对外只叫
 * 「Agents 工坊官方数据接口」。key 只从 `AGENTSWS_SEARCH_DATA_KEY` 读（Luoye 用
 * `wrangler secret put` 自己敲，不经 AI），给回调不给值。
 */
export interface SearchUpstream {
  provider: SearchDataProvider
  /** DataForSEO 是 `login:password`；另两家是一串 key。 */
  api_key: string | (() => string | undefined)
}

/** Stripe 装配（值全部从环境变量来；这个包里不写任何 key）。 */
export interface StripeConfig {
  /** `STRIPE_SECRET_KEY`。 */
  secret_key?: string | (() => string | undefined)
  /** `STRIPE_WEBHOOK_SECRET`：验 webhook 签名用。 */
  webhook_secret?: string | (() => string | undefined)
  /** 付完跳回哪儿（`AGENTSWS_CLOUD_PUBLIC_URL`）。 */
  return_url?: string
  /** Stripe API 根地址；测试里指到假上游。 */
  api_base?: string
}

export interface EntryDeps {
  verifier: TokenVerifier
  wallet: Wallet
  pricing: Pricing
  /** WP155：`search` 不给 = 搜索数据没开通（状态口如实说，另两条回 501，一分不扣）。 */
  upstream: { ai: AiUpstream; search?: SearchUpstream }
  /** WP155：搜索数据的结果缓存；不给就用进程内的那份（命中照收同价）。 */
  searchCache?: SearchCache
  stripe?: StripeConfig
  fetch?: FetchLike
  now?: () => string
  /** 请求号；不给就用时间 + 计数（这个包里不裸调 `Math.random()`）。 */
  newRequestId?: () => string
  /**
   * WP115（65 §3）：**我们自己人的调用免计费，也不污染统计**。
   *
   * KefuAgent 那条真事：管理员拿生产环境试接口，失败率被顶到 30%，从那以后
   * 没人再信那张看板。所以这一档单独记成 `admin_exempt`——成本照记（我们确实
   * 付了上游的钱），向用户收 0，聚合时整行滤掉。
   *
   * 不给 = 谁都不免（默认最保守：漏免一次只是多收自己一点钱，错免一次是漏账）。
   */
  isExemptAccount?: (account_id: string) => boolean
  /**
   * WP115：成本表。不给就用 `@agentsws/metering` 打包的那份。
   * 给 `null` = 不算成本（计量事件里 `cost_micros` 留空，聚合当 0）。
   */
  costTable?: CostTable | null
}

/** 这个包自己的错误信封（与网关 28 §2 同形状，码表按入口的语义另立）。 */
export type EntryErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'insufficient_credits'
  | 'residency_blocked'
  | 'not_implemented'
  | 'provider_error'
  | 'internal'

export const ENTRY_STATUS: Record<EntryErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_input: 400,
  // 402 Payment Required：这是它唯一一个货真价实的用法——钱不够
  insufficient_credits: 402,
  residency_blocked: 422,
  not_implemented: 501,
  provider_error: 502,
  internal: 500,
}

export class EntryError extends Error {
  readonly code: EntryErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: EntryErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'EntryError'
    this.code = code
    this.status = options.status ?? ENTRY_STATUS[code]
    this.details = options.details
  }
}

export type EntryEnv = { Variables: { principal: EntryPrincipal; request_id: string } }

/** 一条路由。形状刻意做薄——挂进哪个 Hono 应用由云侧那边决定。 */
export interface EntryRoute {
  method: 'get' | 'post'
  path: string
  /** `public` 的那条只有 Stripe 的 webhook（它带的是签名，不是我们的令牌）。 */
  auth: 'bearer' | 'public'
  /** 需要哪个 scope（`bearer` 才有意义）。 */
  scope?: string
  summary: string
  handler: (c: Context<EntryEnv>) => Promise<Response>
}

/** 取密钥：回调就调一次，字符串就原样。取回来的值直接进头，不落变量、不进日志。 */
export function secretOf(
  source: string | (() => string | undefined) | undefined,
): string | undefined {
  if (source === undefined) return undefined
  const value = typeof source === 'function' ? source() : source
  return value === undefined || value === '' ? undefined : value
}
