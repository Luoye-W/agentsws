/**
 * 公共红人库服务的装配面（48 §5.3 / 49 §6 WP61）。
 *
 * 这个包是**一个路由包，不是一个服务**：它导出 `mountKolPublicRoutes(app, deps)`，
 * 由云侧那个进程（`apps/cloud`）挂上去——与 WP59 的 `packages/cloud-entry`、
 * WP60 的 `packages/standby` 同一种形状。
 *
 * 纪律（一条都不是可选的）：
 *
 * 1. **不接受正文**：观察过一遍字段白名单（`PUBLIC_OBSERVATION_FIELDS`），
 *    评论 / 私信 / 视频文案一个字都不收；
 * 2. **邮箱只有哈希与密文**：明文只在付费 reveal 的那一次响应里出现，
 *    密钥只从环境变量读（见 README），不落配置对象、不进日志；
 * 3. **日志里除了 handle 什么都不打**：handle 是公开的账号名，粉丝数、地区、
 *    类目这些合起来就是一份可以被拼出来的画像；
 * 4. **计量事件只有八个字段**（49 M6）：连红人名字都没有地方放。
 */
import type {
  Iso8601,
  KolChannel,
  Pricing,
  PublicCreatorObservation,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Wallet } from '@agentsws/metering'
import type { Context } from 'hono'
import type { KolStore } from './store.js'

/** 这个包认的环境变量名（**值一个都不在仓库里**，README 列全）。 */
export const KOL_ENV = {
  /** 邮箱密文的服务密钥（base64url 或 hex 的 32 字节）。**租户无关**，只在云侧。 */
  emailKey: 'AGENTSWS_KOL_EMAIL_KEY',
  /** YouTube 官方 Data API 的 key；没有就直接走降级。 */
  youtubeApiKey: 'AGENTSWS_YOUTUBE_API_KEY',
  /** 全站日配额（单位数）；不给按 `YOUTUBE_UNITS_PER_DAY`。 */
  youtubeUnitsPerDay: 'AGENTSWS_YOUTUBE_UNITS_PER_DAY',
  /** Apify 的令牌；没有它就不降级（而不是悄悄换一个别的源）。 */
  apifyToken: 'APIFY_TOKEN',
} as const

/** 哈希、随机与对称加密那一跳（`node:crypto` 只在 `node-crypto.ts` 里出现一次）。 */
export interface KolSecrets {
  /** 一把新的插件令牌明文（`plg_…`）。 */
  newPluginToken(): string
  sha256(value: string): string
  /**
   * 加一段邮箱。没有配密钥就回 `undefined`——**不降级成明文**：
   * 存不了密文就一个字节都不存，这比"先存着回头再加密"安全得多。
   */
  encrypt(plaintext: string): string | undefined
  /** 解一段密文。密钥不对 / 密文被改过一律回 `undefined`（GCM 的 tag 会发现）。 */
  decrypt(cipher: string): string | undefined
  /** 现在有没有配密钥（回填与 reveal 之前先问它，好回一句人话）。 */
  readonly available: boolean
}

/** 谁在贡献：一把插件令牌，或者一个登录态工作区。日配额与奖励按它算。 */
export interface ContributionSubject {
  /**
   * `plg:<sha256 前 16>` 或 `ws:<workspace_id>`。
   *
   * 插件那一路**只放哈希的前 16 位**：这个 id 会进配额表、也会进观察行的
   * `subject` 列，而那两张表是运维会去看的——整串 sha 是验证用的，
   * 不该在每一行数据里再抄一份。
   */
  id: string
  /** 插件那一路才有：整串 sha256，只用来回写配对行上的两个累计数。 */
  pairing_sha256?: string
  workspace_id: WorkspaceId
  org_id: string
  kind: 'plugin' | 'workspace'
}

/** 验过之后挂在上下文里的那一份（**从不含令牌明文**）。 */
export interface KolPrincipal {
  account_id: string
  org_id: string
  workspace_id: WorkspaceId
  scopes: string[]
  /** `X-Agentsws-Region: cn` 的请求只查库，不走境外源（22 §2）。 */
  region: 'cn' | 'global'
}

export interface KolServiceDeps {
  store: KolStore
  wallet: Wallet
  pricing: Pricing
  secrets: KolSecrets
  now: () => Iso8601
  /** id 生成（这个包里不裸调 `Math.random()` / `Date.now()`）。 */
  newId: (prefix: string) => string
  /** 外部数据源（YouTube 配额池 + Apify 降级）；不给就只查库。 */
  sources?: SourceLookup
  /** 请求号；不给就按时间 + 计数。 */
  newRequestId?: () => string
}

/** 一次外部取数的结果：一条观察 + 可能顺带抓到的邮箱（48 §5.3「邮箱抓取」）。 */
export interface SourceSnapshot extends PublicCreatorObservation {
  /** 频道"关于"页上公开的那个邮箱。**不进日志**，进库就变成哈希 + 密文。 */
  email?: string
}

export type KolSourceId = 'youtube' | 'apify'

/**
 * 一个外部数据源。**这一版只有接口与假实现**：真调用（YouTube Data API 的
 * 三次请求、Apify 的 actor run）留给后续 WP —— 在没有真 key 可验的地方
 * 照着文档瞎写一份解析，比没有更糟。
 */
export interface KolSource {
  id: KolSourceId
  /** 境外源。数据驻留 `cn` 的请求一个都不走（22 §2 / 21）。 */
  offshore: boolean
  /** 这次取数要花多少配额单位（Apify 不计单位，回 0）。 */
  units(): number
  fetch(key: { channel: KolChannel; handle: string }): Promise<SourceSnapshot | undefined>
}

/** 取数那一跳（配额池 + 降级都在它后面）。 */
export interface SourceLookup {
  fetch(
    key: { channel: KolChannel; handle: string },
    options: { region: 'cn' | 'global'; at: Iso8601 },
  ): Promise<SourceOutcome>
}

/** 取数的结果。**没取到不是错**：说清楚为什么没取到比抛一个 500 有用。 */
export interface SourceOutcome {
  used: KolSourceId | 'none'
  snapshot?: SourceSnapshot
  /** `residency` / `quota_exhausted` / `no_source` / `not_found`。 */
  reason?: 'residency' | 'quota_exhausted' | 'no_source' | 'not_found'
  /** 一句人话。 */
  message: string
  /** 这次用掉多少配额单位（计量与日志用）。 */
  units: number
}

export type KolErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'residency_blocked'
  | 'not_implemented'
  | 'internal'

export const KOL_STATUS: Record<KolErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  // 402 Payment Required：钱不够，这是它唯一一个货真价实的用法
  insufficient_credits: 402,
  rate_limited: 429,
  residency_blocked: 422,
  not_implemented: 501,
  internal: 500,
}

export class KolError extends Error {
  readonly code: KolErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: KolErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'KolError'
    this.code = code
    this.status = options.status ?? KOL_STATUS[code]
    this.details = options.details
  }
}

export type KolEnv = { Variables: { kol_principal: KolPrincipal; kol_request_id: string } }

export type KolContext = Context<KolEnv>
