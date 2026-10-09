/**
 * WP164（docs/83 §2 第 1 条）：**云端对外契约**的真源。
 *
 * 云端整体搬进私有仓之后，开源的 Agents 工坊与私有云之间唯一的约定就是这张表：
 * `CloudApi` 的每个键是 `'METHOD /path'`，值里的 `body` / `ok.body` / `query` …
 * 直接引用本包的真类型。`node scripts/gen-cloud-contract.mjs` 用 TypeScript
 * 编译器把它读出来，生成 `packages/contracts/cloud-openapi.json`（OpenAPI 3.1）；
 * CI 跑 `--check` 保证那份 JSON 与这里零漂移。**不手写第二份。**
 *
 * 只收客户端与其他产品（KOLAgents / KefuAgents / BtoBAgents）会调的路径；
 * 运营后台（`/v1/admin/*`）是私有的，留在 `apps/cloud/openapi.json`。
 *
 * 三种响应外形，照实际行为写，别统一"美化"：
 * - 账号那一层（`/v1/cloud/*`）：成功 `{ data, trace_id }`，错误 {@link CloudErrorBody}；
 * - 钱包（`/v1/wallet/*`）：成功 `{ data }`（没有 trace_id），错误 {@link CloudEntryErrorBody}；
 * - AI（`/v1/ai/*`）与其余大多数：成功就是正文本身（AI 是 OpenAI 兼容形状），
 *   错误 {@link CloudEntryErrorBody}（`{ code, message, details? }`）。
 */
import type {
  RelayClientFrame,
  RelayOfflineMessageRequest,
  RelayOfflineMessages,
  RelayOwnerStatus,
  RelayPairingIssued,
  RelayServerFrame,
  RelayVisitorErrorBody,
  RelayVisitorEvent,
  RelayVisitorMessageRequest,
  RelayVisitorMessageResult,
  RelayVisitorOk,
  RelayVisitorSession,
  RelayVisitorTypingRequest,
  RelayWidgetPublicConfig,
  SupportSubscriptionCancelled,
  SupportSubscriptionStarted,
  SupportSubscriptionView,
} from './chat-relay.js'
import type { CloudScope } from './cloud.js'
import type {
  AllocationAuditList,
  AllocationLimitChanged,
  AllocationLimitRequest,
  AllocationMemberRemoved,
  AllocationMemberRemoveRequest,
  AllocationReport,
  AllocationReportQuery,
  AllocationRosterRequest,
  AllocationRosterSynced,
  AllocationSettings,
  AllocationSettingsView,
  AttributionHeaders,
  MyAllocation,
} from './cloud-allocation.js'
import type {
  MemberUsageReport,
  Pricing,
  TopupOrder,
  TopupProvider,
  TopupTiers,
  UsageGroup,
  UsageReport,
  WalletBalance,
} from './cloud-entry.js'
import type { Iso8601, WorkspaceId } from './common.js'
import type {
  DataCallParams,
  DataCallRequest,
  DataCallResult,
  DataCapabilityList,
  DataRegionHeaders,
  DataTaskItemsPage,
  DataTaskItemsQuery,
  DataTaskParams,
  DataTaskSubmit,
  DataTaskView,
} from './data-service.js'
import type { HostedInstanceStatus, HostedSnapshotStored } from './hosted.js'
import type { KolChannel } from './kol.js'
import type {
  KolCloudDeleteResult,
  KolCloudExport,
  KolServiceSubscription,
  KolSyncConflictList,
  KolSyncConflictResolveResult,
  KolSyncPullResult,
  KolSyncPushRequest,
  KolSyncPushResult,
  KolSyncStatus,
} from './kol-cloud.js'
import type {
  AuditReport,
  Benchmark,
  ContributionEvent,
  Dispute,
  FollowersBand,
  IssuedPluginToken,
  PublicContentObservation,
  PublicCreatorCard,
  PublicCreatorObservation,
  PublicCreatorQuery,
  RevealedContact,
} from './kol-public.js'
import type { PricingCatalog } from './pricing-catalog.js'
import type {
  AiAnswerProbe,
  AiAnswerResult,
  AiPlatform,
  SearchDataStatus,
  SerpQuery,
  SerpResult,
} from './search-data.js'
import type { StandbyWorkspace } from './standby.js'

/* ------------------------------------------------------------------ */
/* 表的形状                                                             */
/* ------------------------------------------------------------------ */

/**
 * 鉴权档。
 *
 * - `public`：不带凭据（magic link 那两条、health、访客挂件）；
 * - `session`：云账号会话 `cs_…`（只管账号与关联）；
 * - `workspace_token`：工作区服务令牌 `wst_…`，再按 `scope` 查动作集；
 * - `plugin_token`：浏览器插件令牌 `plg_…`（插件上报公共红人库）；
 * - `hosted_instance`：托管实例容器自己的令牌（推 / 拉快照）；
 * - `visitor`：聊天转发的访客令牌（开会话时签）。
 */
export type CloudApiAuth =
  | 'public'
  | 'session'
  | 'workspace_token'
  | 'plugin_token'
  | 'hosted_instance'
  | 'visitor'

/** 成功响应的媒体类型（缺省 `json`）。 */
export type CloudApiContent = 'json' | 'sse' | 'html' | 'javascript' | 'text' | 'zip'

/** 表里一条路由的形状（生成器按这些键读；多写一个键不会进契约）。 */
export interface CloudApiOperation {
  auth: CloudApiAuth
  /** 要求令牌带的动作（只对 `workspace_token` 有意义）。 */
  scope?: CloudScope
  /** 分组（OpenAPI 的 tag）。 */
  tag: string
  /** 路径参数（`{id}` 这类）。 */
  params?: object
  query?: object
  /** 我们认的请求头（不含 `Authorization`）。 */
  headers?: object
  body?: unknown
  /** 请求体的媒体类型（缺省 `json`；快照上传是 `zip`）。 */
  bodyContent?: CloudApiContent
  ok: {
    status: number
    body?: unknown
    content?: CloudApiContent
    /** 同一条路由还能回 SSE 时（如对话口 `stream: true`），每个 `data:` 的形状。 */
    sse?: unknown
    /** 响应头里我们带的东西。 */
    headers?: object
    description?: string
  }
  /** 除了 `ok` 之外还会回的成功状态（如 204 没有快照、200 访客消息没发出去）。 */
  alt?: { status: number; body?: unknown; content?: CloudApiContent; description?: string }
  /** 状态码 → 这个状态下会出现的错误码（字面量联合）。 */
  errors?: object
  /** 错误响应的正文形状。 */
  errorBody?: unknown
  /** WebSocket：握手之后两个方向的消息形状。 */
  ws?: { client: unknown; server: unknown }
}

/** 账号那一层的成功信封。 */
export interface CloudOkEnvelope<T> {
  data: T
  trace_id: string
}

/** 钱包那几条的成功信封（没有 trace_id）。 */
export interface CloudDataEnvelope<T> {
  data: T
}

/** 账号那一层的错误（28 §2 的信封）。 */
export interface CloudErrorBody {
  code: string
  message: string
  details?: unknown
  trace_id: string
}

/**
 * 服务入口（AI / 钱包 / 搜索数据 / 红人 / 托管 / 转发）的错误。
 *
 * `code` 写成 `string`：各模块的码表各有增减（入口的见 {@link CloudEntryErrorCode}），
 * 客户端要认的那几个在每条路由的 `errors` 里逐条列出来。
 */
export interface CloudEntryErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** 服务入口（`/v1/ai/*`、`/v1/wallet/*`、`/v1/data/search/*`）的错误码表。 */
export type CloudEntryErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'insufficient_credits'
  | 'residency_blocked'
  | 'not_implemented'
  | 'provider_error'
  | 'internal'

/* ------------------------------------------------------------------ */
/* 账号、登录、工作区关联（`/v1/cloud/*`）                               */
/* ------------------------------------------------------------------ */

/** `GET /v1/cloud/health`。`modules` / `newapi` 在装了健康状态的部署上才有。 */
export interface CloudHealthView {
  status: 'ok'
  version: string
  at: Iso8601
  /** 模块名 → 挂上了没有。 */
  modules?: Record<string, boolean>
  /** 模型汇聚层通不通（`unknown` = 没探过，不假装是通的）。 */
  newapi?: { reachable: boolean | 'unknown'; checked_at?: Iso8601 }
}

/** `POST /v1/cloud/auth/magic-link` 的请求。 */
export interface MagicLinkRequest {
  email: string
  /** 点开信里的链接之后回到哪儿（只认白名单里的地址）；不给就回云自己的登录页。 */
  callback_url?: string
  /** 原样带回 callback 的一串（防 CSRF）。 */
  state?: string
}

/** 信发出去了。一次性 token 只进邮件，不进响应。 */
export interface MagicLinkSent {
  expires_at: Iso8601
  delivered: 'email'
}

/* ── WP231：注册与登录分开（密码 + 邮箱验证码；老的 magic-link 照旧，老客户端不坏）──── */

/**
 * 条款版本 = 官网条款三页的生效日期（`apps/site/src/config.ts` 的 `LEGAL_EFFECTIVE_DATE`；
 * `packages/contracts/test/wp231-signup.test.ts` 钉着两边一致）。改条款就两处一起改。
 */
export const LEGAL_TERMS_VERSION = '2026-10-05'

/** 官网根地址（条款与隐私页在这里）。 */
export const SITE_BASE_URL = 'https://agentsws.com'

/** 注册时要同意的两页。 */
export type LegalDocument = 'terms' | 'privacy'

/** 界面与信用哪种语言。 */
export type CloudAuthLocale = 'zh' | 'en'

/** 官网条款页的地址：中文在根下，英文在 `/en/` 下。 */
export function legalDocumentUrl(doc: LegalDocument, locale: CloudAuthLocale): string {
  return `${SITE_BASE_URL}${locale === 'en' ? '/en' : ''}/${doc}/`
}

/** 密码最短几位。 */
export const CLOUD_PASSWORD_MIN = 8
/** 密码最长几位（挡超长输入把哈希拖慢）。 */
export const CLOUD_PASSWORD_MAX = 128
/** 邮箱验证码几位。 */
export const CLOUD_OTP_LENGTH = 6
/** 验证码多久有效（秒）。 */
export const CLOUD_OTP_TTL_SECONDS = 300
/** 一条验证码最多试几次（试满作废，要重发）。 */
export const CLOUD_OTP_MAX_ATTEMPTS = 5

/**
 * 密码强度 0–4（界面上那根条；**只算分，不存密码**）。
 * 0 = 不够 8 位；之后按「长度 ≥ 12」「大小写都有」「有数字」「有符号」各加一档，封顶 4。
 */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length < CLOUD_PASSWORD_MIN) return 0
  let score = 1
  if (password.length >= 12) score += 1
  if (/[a-z]/u.test(password) && /[A-Z]/u.test(password)) score += 1
  if (/\d/u.test(password)) score += 1
  if (/[^A-Za-z0-9]/u.test(password)) score += 1
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4
}

/** 注册从哪儿来的（留证用）。 */
export type CloudSignupSource = 'workstation' | 'web'

/** 注册时勾的那一下。`accepted` 只能是 `true`——没勾就不该发请求。 */
export interface CloudSignupConsent {
  accepted: true
  /** 同意的是哪一版条款（{@link LEGAL_TERMS_VERSION}）。 */
  terms_version: string
}

/**
 * `POST /v1/cloud/auth/signup`：名字 + 邮箱 + 密码 + 同意条款 → 发一封 6 位**注册验证码**。
 * 邮箱已注册 → 409 `conflict`，`details.reason = 'already_registered'`，不发信。
 * 验证码过了（`/signup/verify`）才真正建号并送注册积分；同意记录在那一刻落库。
 */
export interface CloudSignupRequest {
  /** 名字或公司名（当组织名）。 */
  name: string
  email: string
  /** 明文只在这一跳里（HTTPS），云上只存 PBKDF2 哈希；不进日志、事件、审计。 */
  password: string
  consent: CloudSignupConsent
  source: CloudSignupSource
  locale?: CloudAuthLocale
  /** 人机验证（云上配了 Turnstile 且 `source = web` 时必填）。 */
  turnstile_token?: string
}

/** 验证码发出去了（或者——登录 / 忘记密码对没注册的邮箱——**静默不发**，回包一样）。 */
export interface CloudCodeSent {
  expires_at: Iso8601
  delivered: 'email'
}

/** `POST /v1/cloud/auth/signup/verify` 与 `/otp/verify`：邮箱 + 6 位码。 */
export interface CloudCodeVerifyRequest {
  email: string
  code: string
}

/** `POST /v1/cloud/auth/otp`：发一封登录验证码（没注册的邮箱静默成功、不发信、不建号）。 */
export interface CloudOtpRequest {
  email: string
  locale?: CloudAuthLocale
}

/** `POST /v1/cloud/auth/password`：密码登录。 */
export interface CloudPasswordLoginRequest {
  email: string
  password: string
}

/** `POST /v1/cloud/auth/password/forgot`：发一封重置密码验证码（没注册的邮箱静默成功）。 */
export interface CloudPasswordForgotRequest {
  email: string
  locale?: CloudAuthLocale
}

/** `POST /v1/cloud/auth/password/reset`：验证码 + 新密码。成功后这个账号别的会话全部失效。 */
export interface CloudPasswordResetRequest {
  email: string
  code: string
  new_password: string
}

/** `GET /v1/cloud/auth/config`：界面要知道的几样（没有任何密钥）。 */
export interface CloudAuthConfig {
  password_min: number
  otp_length: number
  otp_ttl_seconds: number
  terms_version: string
  /** 配了 Turnstile 才有（公开的 site key，不是 secret）。 */
  turnstile_site_key?: string
}

/** 被拒时 `details.reason` 的几种值（界面据此给「一键切到登录 / 注册」等）。 */
export type CloudAuthReason =
  | 'already_registered'
  | 'invalid_code'
  | 'code_expired'
  | 'too_many_attempts'
  | 'bad_credentials'
  | 'locked'
  | 'weak_password'
  | 'consent_required'
  | 'captcha_required'

/** 被拒时的 `details`。 */
export interface CloudAuthReasonDetails {
  reason: CloudAuthReason
  /** `locked` / 限流时：还要等多少秒。 */
  retry_after?: number
}

/** `POST /v1/cloud/auth/verify` 的请求。 */
export interface MagicLinkVerifyRequest {
  /** 信里链接上的那串一次性 token。 */
  token: string
}

/** 注册赠送的结果（WP121）：没送成的原因也照实说。 */
export interface SignupBonusView {
  granted: boolean
  credits: number
  expires_at?: Iso8601
  lot_id?: string
  skip?: 'already' | 'blocked' | 'unavailable' | 'disabled' | 'failed'
}

/** 验过 magic link：换到一张云账号会话。 */
export interface CloudSessionIssued {
  account: { id: string; email: string }
  org: { id: string; name: string }
  /** `cs_…`，只在这里出现一次。 */
  session_token: string
  expires_at: Iso8601
  /** 第一次点开登录信才有（注册赠送）。 */
  bonus?: SignupBonusView
  /** WP231：这一下是不是刚注册（注册验证码过了、账号是这一刻建的）。老云不回这一格。 */
  registered?: boolean
}

/** `GET /v1/cloud/me`。 */
export interface CloudMeView {
  account: { id: string; email: string }
  /** `members` 是组织里有几个人。 */
  org: { id: string; name: string; members: number }
}

/** `POST /v1/cloud/auth/logout`。 */
export interface CloudLogoutResult {
  revoked: true
}

/** 一条工作区关联的读视图：**没有令牌，也没有哈希**。 */
export interface WorkspaceLinkView {
  id: string
  workspace_id: string
  cloud_org_id: string
  label: string
  scopes: CloudScope[]
  created_at: Iso8601
  expires_at: Iso8601
  revoked_at?: Iso8601
  last_used_at?: Iso8601
  /** 过期或撤销了就是 false。 */
  active: boolean
}

/** 签一把工作区服务令牌（`POST /v1/cloud/links` 与 `/links/sibling`）。 */
export interface CreateWorkspaceLinkRequest {
  workspace_id: string
  label?: string
  /** 不给就是默认动作集；`/links/sibling` 忽略它（补签的与调用者同权）。 */
  scopes?: CloudScope[]
  /** 默认 90，最长 365。 */
  ttl_days?: number
}

/** 签发 / 续期的结果：`token`（`wst_…`）只在这里出现一次。 */
export interface IssuedWorkspaceLinkView {
  link: WorkspaceLinkView
  token: string
}

/** `POST /v1/cloud/links/{id}/renew` 的请求。 */
export interface RenewWorkspaceLinkRequest {
  ttl_days?: number
}

/** `GET /v1/cloud/links`。 */
export interface WorkspaceLinkList {
  links: WorkspaceLinkView[]
}

/** `GET /v1/cloud/links/current`：这把令牌自己是谁。 */
export interface CurrentWorkspaceLinkView {
  link: WorkspaceLinkView
  org?: { id: string; name: string }
  account?: { id: string; email: string }
}

/** 账号那一层 POST 都认的幂等头（24h 内同键重放原响应）。 */
export interface CloudIdempotencyHeaders {
  'Idempotency-Key'?: string
}

/* ------------------------------------------------------------------ */
/* 钱包、充值（`/v1/wallet/*`）                                         */
/* ------------------------------------------------------------------ */

/** `GET /v1/wallet/usage` 的查询参数。 */
export interface WalletUsageQuery {
  /** 缺省 `capability`。 */
  group?: UsageGroup
  /** 缺省本月一号零点（UTC）。`group=member` 缺省按**公司时区**的本月（WP279，决策 286）。 */
  from?: Iso8601
  /** 缺省现在。 */
  to?: Iso8601
  /**
   * WP279：只看这一个人（本机成员 id，`attributionIdOk` 形状；不合法回 400）。哪个分组都能筛。
   */
  member?: string
  /** WP279：公司时区的某个自然月（`YYYY-MM`）。和 `from` / `to` 只能给一样，写错回 400。 */
  month?: string
}

/** `POST /v1/wallet/topup` 的请求。 */
export interface TopupRequest {
  /** 按哪一档充（`usd20` …）。普通令牌必须给；只有 `wallet:admin` 能不给、改用 `credits`。 */
  tier_id?: string
  /** 缺省 `stripe`；`wechat` / `alipay` 这一版回 501。 */
  provider?: TopupProvider
  /** 任意金额（只有 `wallet:admin`）。 */
  credits?: number
}

/* ------------------------------------------------------------------ */
/* AI（`/v1/ai/*`，OpenAI 兼容）                                        */
/* ------------------------------------------------------------------ */

/**
 * 我们加的请求头：数据驻留。`cn` = 只允许境内可用的模型，否则 422 `residency_blocked`。
 */
export interface AiRegionHeaders extends AttributionHeaders {
  'X-Agentsws-Region'?: 'cn' | 'global'
}

/** OpenAI 兼容的 usage（结算按它）。 */
export interface AiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

/** 对话里的一条消息（其余字段原样转给上游）。 */
export interface AiChatMessage {
  role: string
  content?: unknown
  [key: string]: unknown
}

/**
 * `POST /v1/ai/chat/completions` 的请求（OpenAI 兼容，其余字段原样转给上游）。
 * 预扣按 `max_tokens`（或 `max_completion_tokens`）估；流式时我们替你带上
 * `stream_options.include_usage`。
 */
export interface AiChatCompletionRequest {
  model: string
  messages: AiChatMessage[]
  stream?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  [key: string]: unknown
}

/** 非流式对话的回包（上游原样端出，这里只钉我们结算要用的那几格）。 */
export interface AiChatCompletion {
  id?: string
  object?: string
  model?: string
  choices: unknown[]
  usage?: AiUsage
  [key: string]: unknown
}

/** 流式对话里每个 `data:` 块（最后一块带 `usage`；结尾 `data: [DONE]`）。 */
export interface AiChatCompletionChunk {
  id?: string
  object?: string
  choices?: unknown[]
  usage?: AiUsage | null
  [key: string]: unknown
}

/** `POST /v1/ai/embeddings` 的请求。 */
export interface AiEmbeddingsRequest {
  model: string
  input: string | string[]
  [key: string]: unknown
}

/** 向量口的回包（上游原样）。 */
export interface AiEmbeddings {
  object?: string
  data: unknown[]
  model?: string
  usage?: AiUsage
  [key: string]: unknown
}

/** `POST /v1/ai/images/generations` 的请求。`n` 最多 4；`quality` 一律钉成 `medium`。 */
export interface AiImageRequest {
  model: string
  prompt: string
  n?: number
  [key: string]: unknown
}

/**
 * WP268（决策 213）：**参考图改图** `POST /v1/ai/images/edits` 的请求（OpenAI 形态，`multipart/form-data`）。
 *
 * 字段：`model`、`prompt`、`image[]`（1–4 张参考图，png / jpeg / webp，单张 ≤ 20 MB）、可选 `mask`（png）、
 * `n`（≤ 4）、`size`、可选 `input_fidelity`（`high` / `low`）。回包同 {@link AiImages}。
 *
 * **还没进 {@link CloudApi}**（同 WP265 云上那几条的做法）：私有仓实现转发与按张计费之后，
 * 再把路由加进 `CloudApi` 并重出 `cloud-openapi.json`（见 WP268 报告「云端配合清单」）。
 * 这里先钉住形状，本机实现与假云端测试按它来。
 */
export interface AiImageEditRequest {
  model: string
  prompt: string
  /** multipart 里是重复的 `image[]` 字段；这里写成数组说明张数。 */
  image: { filename: string; content_type: string; bytes: number }[]
  mask?: { filename: string; content_type: string; bytes: number }
  n?: number
  size?: string
  input_fidelity?: 'high' | 'low'
}

/** WP268：改图的计费能力名（云上价目表那一行；没有这一行时按 `ai.image` 算）。 */
export const AI_IMAGE_EDIT_CAPABILITY = 'ai.image_edit'

/** 生图回包（上游原样；按 `data` 里真回来几张结算）。 */
export interface AiImages {
  data: unknown[]
  [key: string]: unknown
}

/** `GET /v1/ai/models`：带 `X-Agentsws-Region: cn` 时只列境内可用的。 */
export interface AiModelList {
  object: 'list'
  data: { id?: string; [key: string]: unknown }[]
}

/* ------------------------------------------------------------------ */
/* 搜索数据（`/v1/data/search/*`，docs/81）                             */
/* ------------------------------------------------------------------ */

/** 某个平台这次没查成 / 查不了（不收钱）。 */
export interface SearchDataSkippedPlatform {
  platform: AiPlatform
  code: string
  message: string
}

/** `POST /v1/data/search/ai-answers` 的回包：每个平台一次，只收成功的。 */
export interface SearchDataAiAnswers {
  results: AiAnswerResult[]
  skipped: SearchDataSkippedPlatform[]
  credits: number
}

/* ------------------------------------------------------------------ */
/* 路由表：账号、登录、工作区关联                                        */
/* ------------------------------------------------------------------ */

/** 账号那一层通用的错误码。 */
interface CloudAccountErrors {
  400: 'invalid_input'
  401: 'unauthenticated'
  429: 'rate_limited'
}

/** WP165：公开价目带的缓存头。 */
export interface PricingCatalogHeaders {
  /** `public, max-age=300`（见 `PRICING_CATALOG_MAX_AGE_S`）。 */
  'Cache-Control': string
}

export interface CloudAccountApi {
  /** 活着没有：版本、各模块挂没挂上、模型汇聚层通不通（不回任何密钥与地址） */
  'GET /v1/cloud/health': {
    auth: 'public'
    tag: 'account'
    ok: { status: 200; body: CloudOkEnvelope<CloudHealthView> }
    errorBody: CloudErrorBody
  }
  /**
   * 发一封登录邮件（一次性 token 只进邮件，不进响应）
   * 第一次见到这个邮箱就建账号 + 隐式建组织；响应对"这个邮箱注册过没有"一个字都不透露。
   */
  'POST /v1/cloud/auth/magic-link': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: MagicLinkRequest
    ok: { status: 200; body: CloudOkEnvelope<MagicLinkSent> }
    errors: {
      400: 'invalid_input'
      409: 'idempotency_conflict'
      429: 'rate_limited'
      /** 信没发出去（照实说，不假装发出去了） */
      503: 'provider_unavailable'
    }
    errorBody: CloudErrorBody
  }
  /** WP231：注册 / 登录界面要知道的几样（密码最短几位、验证码几位、条款版本、Turnstile 公开 key） */
  'GET /v1/cloud/auth/config': {
    auth: 'public'
    tag: 'account'
    ok: { status: 200; body: CloudOkEnvelope<CloudAuthConfig> }
    errorBody: CloudErrorBody
  }
  /**
   * WP231：注册——名字 + 邮箱 + 密码 + 同意条款，发一封 6 位注册验证码（5 分钟、最多试 5 次）
   * 邮箱已注册 → 409 conflict（details.reason = already_registered），不发信。按邮箱 + IP 限流。
   */
  'POST /v1/cloud/auth/signup': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudSignupRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudCodeSent> }
    errors: {
      /** `details` 是 {@link CloudAuthReasonDetails}（weak_password / consent_required / captcha_required） */
      400: 'invalid_input'
      /** `conflict` 时 details.reason = already_registered */
      409: 'conflict' | 'idempotency_conflict'
      429: 'rate_limited'
      503: 'provider_unavailable'
    }
    errorBody: CloudErrorBody
  }
  /** WP231：注册验证码过了 → 建号、送注册积分、记同意，回一张云账号会话（registered = true） */
  'POST /v1/cloud/auth/signup/verify': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudCodeVerifyRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudSessionIssued> }
    errors: {
      400: 'invalid_input'
      /** details.reason = invalid_code / code_expired / too_many_attempts */
      401: 'unauthenticated'
      409: 'conflict' | 'idempotency_conflict'
      429: 'rate_limited'
    }
    errorBody: CloudErrorBody
  }
  /** WP231：发一封登录验证码。没注册的邮箱**静默成功**（不发信、不建号，回包一模一样）。按邮箱 + IP 限流 */
  'POST /v1/cloud/auth/otp': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudOtpRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudCodeSent> }
    errors: {
      400: 'invalid_input'
      409: 'idempotency_conflict'
      429: 'rate_limited'
      503: 'provider_unavailable'
    }
    errorBody: CloudErrorBody
  }
  /** WP231：登录验证码过了 → 一张云账号会话 */
  'POST /v1/cloud/auth/otp/verify': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudCodeVerifyRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudSessionIssued> }
    errors: CloudAccountErrors & { 409: 'idempotency_conflict' }
    errorBody: CloudErrorBody
  }
  /**
   * WP231：密码登录。邮箱没注册 / 密码不对 / 没设过密码一律同一句（details.reason = bad_credentials）；
   * 连错多次临时锁定（429，details.reason = locked）
   */
  'POST /v1/cloud/auth/password': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudPasswordLoginRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudSessionIssued> }
    errors: CloudAccountErrors & { 409: 'idempotency_conflict' }
    errorBody: CloudErrorBody
  }
  /** WP231：忘记密码——发一封重置验证码（没注册的邮箱静默成功） */
  'POST /v1/cloud/auth/password/forgot': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudPasswordForgotRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudCodeSent> }
    errors: {
      400: 'invalid_input'
      409: 'idempotency_conflict'
      429: 'rate_limited'
      503: 'provider_unavailable'
    }
    errorBody: CloudErrorBody
  }
  /** WP231：验证码 + 新密码 → 设好新密码，这个账号别的会话全部失效，回一张新会话 */
  'POST /v1/cloud/auth/password/reset': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CloudPasswordResetRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudSessionIssued> }
    errors: CloudAccountErrors & { 409: 'idempotency_conflict' }
    errorBody: CloudErrorBody
  }
  /** 验一次性 token，换云账号会话（用过 / 过期 / 不存在一律 401 同一句话） */
  'POST /v1/cloud/auth/verify': {
    auth: 'public'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: MagicLinkVerifyRequest
    ok: { status: 200; body: CloudOkEnvelope<CloudSessionIssued> }
    errors: CloudAccountErrors
    errorBody: CloudErrorBody
  }
  /** 当前云账号：是谁、组织是哪个 */
  'GET /v1/cloud/me': {
    auth: 'session'
    tag: 'account'
    ok: { status: 200; body: CloudOkEnvelope<CloudMeView> }
    errors: CloudAccountErrors & { 404: 'not_found' }
    errorBody: CloudErrorBody
  }
  /** 注销：撤销这一张会话 token */
  'POST /v1/cloud/auth/logout': {
    auth: 'session'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    ok: { status: 200; body: CloudOkEnvelope<CloudLogoutResult> }
    errors: CloudAccountErrors
    errorBody: CloudErrorBody
  }
  /** 给一个工作区签一把服务令牌（明文只回一次） */
  'POST /v1/cloud/links': {
    auth: 'session'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CreateWorkspaceLinkRequest
    ok: { status: 201; body: CloudOkEnvelope<IssuedWorkspaceLinkView> }
    errors: CloudAccountErrors & {
      /** 这个工作区已经关联到另一个账号了 */
      409: 'conflict' | 'idempotency_conflict'
    }
    errorBody: CloudErrorBody
  }
  /** 本组织的全部关联（含已撤销的：撤过什么必须看得到） */
  'GET /v1/cloud/links': {
    auth: 'session'
    tag: 'account'
    ok: { status: 200; body: CloudOkEnvelope<WorkspaceLinkList> }
    errors: CloudAccountErrors
    errorBody: CloudErrorBody
  }
  /** 这把令牌自己是谁（本地"关联状态"那一格靠它刷新） */
  'GET /v1/cloud/links/current': {
    auth: 'workspace_token'
    tag: 'account'
    ok: { status: 200; body: CloudOkEnvelope<CurrentWorkspaceLinkView> }
    errors: CloudAccountErrors & { 404: 'not_found' }
    errorBody: CloudErrorBody
  }
  /**
   * 给同一组织下的另一个工作区补签一把服务令牌（明文只回一次）
   * 组织从调用者那条关联上取；补签出来的那一把与调用者同权。
   */
  'POST /v1/cloud/links/sibling': {
    auth: 'workspace_token'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    body: CreateWorkspaceLinkRequest
    ok: { status: 201; body: CloudOkEnvelope<IssuedWorkspaceLinkView> }
    errors: CloudAccountErrors & { 404: 'not_found'; 409: 'conflict' | 'idempotency_conflict' }
    errorBody: CloudErrorBody
  }
  /** 这台机器自己解除关联（本地"解除关联"按钮走这条） */
  'POST /v1/cloud/links/current/revoke': {
    auth: 'workspace_token'
    tag: 'account'
    headers: CloudIdempotencyHeaders
    ok: { status: 200; body: CloudOkEnvelope<WorkspaceLinkView> }
    errors: CloudAccountErrors & { 404: 'not_found' }
    errorBody: CloudErrorBody
  }
  /** 续期 = 换一把新的（旧明文当场作废） */
  'POST /v1/cloud/links/{id}/renew': {
    auth: 'session'
    tag: 'account'
    params: { id: string }
    headers: CloudIdempotencyHeaders
    body: RenewWorkspaceLinkRequest
    ok: { status: 200; body: CloudOkEnvelope<IssuedWorkspaceLinkView> }
    errors: CloudAccountErrors & { 404: 'not_found' }
    errorBody: CloudErrorBody
  }
  /** 撤掉一条关联（写 revoked_at，不删行） */
  'POST /v1/cloud/links/{id}/revoke': {
    auth: 'session'
    tag: 'account'
    params: { id: string }
    headers: CloudIdempotencyHeaders
    ok: { status: 200; body: CloudOkEnvelope<WorkspaceLinkView> }
    errors: CloudAccountErrors & { 404: 'not_found' }
    errorBody: CloudErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：钱包、充值                                                   */
/* ------------------------------------------------------------------ */

/** 入口那一层带令牌的路由都会有的错误。 */
interface EntryAuthErrors {
  401: 'unauthenticated'
  /** 令牌没有这条路由要的动作（`details.required_scope`） */
  403: 'forbidden'
}

export interface CloudWalletApi {
  /** 余额：永不过期的 / 有期限的 / 即将过期的 / 预扣中的 */
  'GET /v1/wallet': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    ok: { status: 200; body: CloudDataEnvelope<WalletBalance> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /**
   * 用量明细（按能力 / 按工作区 / 按天 / 按人）
   * 只聚合计量事件，聚合不出正文。带 `wallet:admin` 的看整个组织，否则只看自己这个工作区。
   * `group=member`（WP279）回按人的那一份：每人积分、价目表三块、次数，标不出是谁的单独一格。
   */
  'GET /v1/wallet/usage': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    query: WalletUsageQuery
    ok: { status: 200; body: CloudDataEnvelope<UsageReport | MemberUsageReport> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
  /**
   * 公开价目：价目表 + 充值档位一次给齐（WP165，docs/83 §2「价目表只放云上」）
   * 不要令牌、可缓存（`Cache-Control: public, max-age=300`）；和带令牌的 `/v1/wallet/pricing`、
   * `/v1/wallet/topup/tiers` 是同一份数据。本机没关联账号也据此显示价格，并缓存一份离线看。
   */
  'GET /v1/pricing': {
    auth: 'public'
    tag: 'wallet'
    ok: {
      status: 200
      body: CloudDataEnvelope<PricingCatalog>
      headers: PricingCatalogHeaders
    }
    errorBody: CloudEntryErrorBody
  }
  /** 价目表（能力 → 单位 → 积分）。对用户只显示最终积分价 */
  'GET /v1/wallet/pricing': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    ok: { status: 200; body: CloudDataEnvelope<Pricing> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 充值档位（usd / credits） */
  'GET /v1/wallet/topup/tiers': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    ok: { status: 200; body: CloudDataEnvelope<TopupTiers> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /**
   * 建一笔充值单（按档位；这一版只做 Stripe）
   * 回来的 `checkout_url` 在新窗口打开；付完由 Stripe 的 webhook 入账（那一条不在对外契约里）。
   */
  'POST /v1/wallet/topup': {
    auth: 'workspace_token'
    scope: 'wallet:topup'
    tag: 'wallet'
    body: TopupRequest
    ok: { status: 201; body: CloudDataEnvelope<TopupOrder> }
    errors: EntryAuthErrors & {
      400: 'invalid_input'
      /** 微信 / 支付宝这一版还没做 */
      501: 'not_implemented'
      502: 'provider_error'
    }
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：AI（OpenAI 兼容）                                            */
/* ------------------------------------------------------------------ */

/**
 * AI 口的错误。**上游拒了的那种不在这里**：状态码与正文原样透传（通常是 OpenAI 形状的
 * `{ error: { message } }`），预扣整笔释放、一分不扣。
 */
interface AiErrors extends EntryAuthErrors {
  400: 'invalid_input'
  /** 余额不够这一次的预扣（只拒这一次，不冻结）；或本人 / 岗位本月额度到了（WP194，`details.reason`） */
  402: 'insufficient_credits'
  /** 数据驻留：`X-Agentsws-Region: cn` 却点了境外模型 */
  422: 'residency_blocked'
  /** 云侧没配上游密钥 / 价目表缺这一项（没扣积分） */
  500: 'internal'
  /** 上游连不上（没扣积分） */
  502: 'provider_error'
}

export interface CloudAiApi {
  /**
   * OpenAI 兼容的对话口（流式与非流式都支持）；按 token 预扣后结算
   * `stream: true` 时回 `text/event-stream`，最后一块带 `usage`，以 `data: [DONE]` 结束。
   */
  'POST /v1/ai/chat/completions': {
    auth: 'workspace_token'
    scope: 'ai'
    tag: 'ai'
    headers: AiRegionHeaders
    body: AiChatCompletionRequest
    ok: { status: 200; body: AiChatCompletion; sse: AiChatCompletionChunk }
    errors: AiErrors
    errorBody: CloudEntryErrorBody
  }
  /** OpenAI 兼容的向量口；按 token 预扣后结算 */
  'POST /v1/ai/embeddings': {
    auth: 'workspace_token'
    scope: 'ai'
    tag: 'ai'
    headers: AiRegionHeaders
    body: AiEmbeddingsRequest
    ok: { status: 200; body: AiEmbeddings }
    errors: AiErrors
    errorBody: CloudEntryErrorBody
  }
  /** OpenAI 兼容的生图口；按张预扣，按真回来的张数结算 */
  'POST /v1/ai/images/generations': {
    auth: 'workspace_token'
    scope: 'ai'
    tag: 'ai'
    headers: AiRegionHeaders
    body: AiImageRequest
    ok: { status: 200; body: AiImages }
    errors: AiErrors
    errorBody: CloudEntryErrorBody
  }
  /** 这把令牌能用的模型清单（不扣积分）；带 `X-Agentsws-Region: cn` 时只列境内可用的 */
  'GET /v1/ai/models': {
    auth: 'workspace_token'
    scope: 'ai'
    tag: 'ai'
    headers: AiRegionHeaders
    ok: { status: 200; body: AiModelList }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：搜索数据                                                     */
/* ------------------------------------------------------------------ */

interface SearchErrors extends EntryAuthErrors {
  400: 'invalid_input'
  402: 'insufficient_credits'
  /** 这个节点没配搜索数据（一分不扣） */
  501: 'not_implemented'
  502: 'provider_error'
}

export interface CloudSearchDataApi {
  /** 搜索数据开没开通、能查哪些引擎 / 平台、单价多少（不收钱） */
  'GET /v1/data/search/status': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-search'
    ok: { status: 200; body: SearchDataStatus }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 查一次搜索结果页（按国家 / 语言 / 设备）；按次扣积分，命中缓存同价，失败不扣 */
  'POST /v1/data/search/serp': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-search'
    headers: AttributionHeaders
    body: SerpQuery
    ok: { status: 200; body: SerpResult }
    errors: SearchErrors
    errorBody: CloudEntryErrorBody
  }
  /** 问几个 AI 平台同一个问题，看有没有提到你、引用了谁；每个平台一次，只收成功的 */
  'POST /v1/data/search/ai-answers': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-search'
    headers: AttributionHeaders
    body: AiAnswerProbe
    ok: { status: 200; body: SearchDataAiAnswers }
    errors: SearchErrors
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：官方数据接口的统一能力口（WP192，docs/83 §4）                  */
/* ------------------------------------------------------------------ */

interface DataServiceErrors extends EntryAuthErrors {
  400: 'invalid_input'
  402: 'insufficient_credits'
  /** 没有这项能力 / 没有这个任务（别的组织的任务也是这一句） */
  404: 'not_found'
  /** 境外渠道被数据驻留挡住 */
  422: 'residency_blocked'
  /** 这个组织今天的次数 / 同时在跑的任务到上限了（后台可调） */
  429: 'rate_limited'
  /** 这项能力云上还没开通（一分不扣） */
  501: 'not_implemented'
  502: 'provider_error'
}

export interface CloudDataServiceApi {
  /** 能用哪些数据能力：同步 / 异步、单价、上限、开没开通（不收钱） */
  'GET /v1/data/capabilities': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    headers: DataRegionHeaders
    ok: { status: 200; body: CloudDataEnvelope<DataCapabilityList> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 同步调用一项能力（查一次就回）；先预扣，命中共享缓存照价收，失败 / 0 条不收 */
  'POST /v1/data/call/{capability}': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    params: DataCallParams
    headers: DataRegionHeaders
    body: DataCallRequest
    ok: { status: 200; body: CloudDataEnvelope<DataCallResult> }
    errors: DataServiceErrors
    errorBody: CloudEntryErrorBody
  }
  /** 提交一个异步任务（带幂等键）；按上限条数预扣，跑完按实际条数结算，失败 / 超时全退 */
  'POST /v1/data/tasks': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    headers: DataRegionHeaders
    body: DataTaskSubmit
    ok: { status: 202; body: CloudDataEnvelope<DataTaskView>; description: '已受理（排队中）' }
    alt: {
      status: 200
      body: CloudDataEnvelope<DataTaskView>
      description: '同一个幂等键已经有这个任务了：原样回它现在的样子'
    }
    errors: DataServiceErrors
    errorBody: CloudEntryErrorBody
  }
  /** 看一个任务现在怎么样 */
  'GET /v1/data/tasks/{id}': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    params: DataTaskParams
    ok: { status: 200; body: CloudDataEnvelope<DataTaskView> }
    errors: EntryAuthErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /** 分页取一个任务的结果（每页最多 100 条） */
  'GET /v1/data/tasks/{id}/items': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    params: DataTaskParams
    query: DataTaskItemsQuery
    ok: { status: 200; body: CloudDataEnvelope<DataTaskItemsPage> }
    errors: EntryAuthErrors & {
      400: 'invalid_input'
      404: 'not_found'
      /** 还没跑完 */
      409: 'conflict'
      /** 结果过了保留期，已经删了 */
      410: 'gone'
    }
    errorBody: CloudEntryErrorBody
  }
  /** 取消一个任务（已经拿到的那几条照收，其余退回；已经结束的原样回） */
  'POST /v1/data/tasks/{id}/cancel': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'data-service'
    params: DataTaskParams
    ok: { status: 200; body: CloudDataEnvelope<DataTaskView> }
    errors: EntryAuthErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
}

/**
 * 云端对外契约：客户端与其他产品会调的全部云端路径（docs/83 §2 第 1 条）。
 */

/* ------------------------------------------------------------------ */
/* 公共红人库（`/v1/data/kol/*`）的请求与回包                            */
/* ------------------------------------------------------------------ */

/** `GET /v1/data/kol/creators`：浏览（按次扣 `data.kol.lookup`；10 分钟内同一查询翻页不再扣）。 */
export interface KolPublicBrowseResult {
  creators: PublicCreatorCard[]
  /** 这一次扣了多少积分（命中缓存与未命中同价；窗口内重复搜索为 0）。 */
  credits: number
}

/** `POST …/refresh`：去外部源刷新一次。 */
export interface KolPublicRefreshResult {
  /** 有没有真的去外部取一次数。 */
  refreshed: boolean
  used: 'youtube' | 'apify' | 'none'
  reason?: 'residency' | 'quota_exhausted' | 'no_source' | 'not_found'
  message: string
  credits: number
  card?: PublicCreatorCard
}

/** `GET /v1/data/kol/benchmarks`：k-匿名基准。 */
export interface KolPublicBenchmarkResult extends Benchmark {
  note: string
  /** 这一次扣了多少积分（桶不够 k 不收钱 → 0）。 */
  credits: number
}

/** `POST …/disputes`：争议只记不裁。 */
export interface KolPublicDisputeResult {
  dispute: Dispute
  message: string
}

/** `GET /v1/data/kol/benchmarks` 的查询参数（`followers_band` 与 `followers` 二选一）。 */
export interface KolPublicBenchmarkQuery {
  channel: KolChannel
  category?: string
  followers_band?: FollowersBand
  /** 给粉丝数时按它落到对应的量级档。 */
  followers?: number
}

/** `{channel}/{handle}` 这一对路径参数。 */
export interface KolPublicCreatorParams {
  channel: KolChannel
  handle: string
}

/** 手动加观察：一批，或者直接一条观察当正文（路径里的 channel / handle 说了算）。 */
export interface KolPublicObservationsRequest {
  observations?: PublicCreatorObservation[]
  /** 本机服务转发插件观测时带 `extension`（来源记 plugin）。 */
  via?: 'extension'
}

/** 插件上报一批观察（`plg_…`，一批最多 100 条）。 */
export interface KolPluginObservationsRequest {
  observations: PublicCreatorObservation[]
}

/** 内容观测一批。 */
export interface KolContentObservationsRequest {
  observations: PublicContentObservation[]
}

/** 联系方式回填（回填者得奖励）。 */
export interface KolPublicContactRequest {
  email: string
  source?: string
}

/** 提一条争议（`field` ≤ 60 字，`claim` ≤ 500 字）。 */
export interface KolPublicDisputeRequest {
  field: string
  claim: string
}

/** 插件配对：用工作区令牌换一把 `plg_…`（明文只回这一次，30 天有效）。 */
export interface KolPluginPairRequest {
  label?: string
}

/** 撤掉了。 */
export interface KolRevokedResult {
  revoked: true
}

/* ------------------------------------------------------------------ */
/* 云端红人库同步（`/v1/kol/*`）的请求                                   */
/* ------------------------------------------------------------------ */

/** `POST /v1/kol/sync/conflicts/resolve`。 */
export interface KolSyncConflictResolveRequest {
  kind: string
  id: string
}

/** `GET /v1/kol/sync/pull` 的查询参数。 */
export interface KolSyncPullQuery {
  cursor?: string
  writer?: string
  limit?: number
}

/* ------------------------------------------------------------------ */
/* 在线值守（`/v1/standby/*`，只在自建 / Node 形态的云上有）              */
/* ------------------------------------------------------------------ */

/** `GET /v1/standby/workspaces`。 */
export interface StandbyWorkspaceList {
  workspaces: StandbyWorkspace[]
  /** 一个座位一个月多少积分。 */
  seat_price: number
}

/** `POST /v1/standby/workspaces`：开一个值守工作区。 */
export interface StandbyOpenRequest {
  /** 缺省 1。 */
  seats?: number
}

/** `POST /v1/standby/workspaces/{id}/import` 的查询参数。 */
export interface StandbyImportQuery {
  seats?: number
  /** `true` = 覆盖已有的那一份。 */
  force?: 'true'
}

/** 值守路由的路径参数：`id` 必须是令牌自己那个工作区。 */
export interface StandbyWorkspaceParams {
  id: WorkspaceId
}

/* ------------------------------------------------------------------ */
/* 托管实例快照                                                         */
/* ------------------------------------------------------------------ */

/** 取回快照时带的两个响应头。 */
export interface HostedSnapshotHeaders {
  'x-agentsws-snapshot-at': Iso8601
  'X-Agentsws-Snapshot-Source': 'hosted' | 'local'
}

/** 访客面路径里的那个工作区。 */
export interface RelayWorkspaceParams {
  workspace: WorkspaceId
}

/** 访客面带会话 id 的那几条。 */
export interface RelaySessionParams {
  workspace: WorkspaceId
  id: string
}

/** 访客面要带浏览器的来源（白名单只按它判）。 */
export interface RelayOriginHeaders {
  Origin?: string
}

/* ------------------------------------------------------------------ */
/* 路由表：公共红人库                                                   */
/* ------------------------------------------------------------------ */

/** 红人库带工作区令牌的路由都会有的错误（要 `data` 动作）。 */
interface KolAuthErrors extends EntryAuthErrors {
  400: 'invalid_input'
}

/** 收费的那几条多出来的错误。 */
interface KolChargedErrors extends KolAuthErrors {
  /** 余额不够（入口先预扣，钱一分没动） */
  402: 'insufficient_credits'
}

export interface CloudKolPublicApi {
  /** 浏览公共红人库（按次扣 `data.kol.lookup`；10 分钟内同一查询翻页不再扣） */
  'GET /v1/data/kol/creators': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    query: PublicCreatorQuery
    headers: AiRegionHeaders
    ok: { status: 200; body: CloudDataEnvelope<KolPublicBrowseResult> }
    errors: KolChargedErrors
    errorBody: CloudEntryErrorBody
  }
  /** 免费体检报告（基础档） */
  'GET /v1/data/kol/creators/{channel}/{handle}/audit': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    ok: { status: 200; body: CloudDataEnvelope<AuditReport> }
    errors: KolChargedErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /** 付费揭示联系方式（`data.kol.reveal`；按次揭示 + 审计，不当缓存卖） */
  'POST /v1/data/kol/creators/{channel}/{handle}/reveal': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    ok: { status: 200; body: CloudDataEnvelope<RevealedContact> }
    errors: KolChargedErrors & { 404: 'not_found'; 501: 'not_implemented' }
    errorBody: CloudEntryErrorBody
  }
  /** 付费深度体检（`data.kol.audit`；样本不够不收） */
  'POST /v1/data/kol/creators/{channel}/{handle}/deep-audit': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    ok: { status: 200; body: CloudDataEnvelope<AuditReport> }
    errors: KolChargedErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /** 去外部源刷新一次（`social.fetch`；`X-Agentsws-Region: cn` 只查库） */
  'POST /v1/data/kol/creators/{channel}/{handle}/refresh': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    headers: AiRegionHeaders
    ok: { status: 200; body: CloudDataEnvelope<KolPublicRefreshResult> }
    errors: KolChargedErrors
    errorBody: CloudEntryErrorBody
  }
  /** k-匿名基准（只回分位数，不回个体；桶不够 k 不收钱） */
  'GET /v1/data/kol/benchmarks': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    query: KolPublicBenchmarkQuery
    ok: { status: 200; body: CloudDataEnvelope<KolPublicBenchmarkResult> }
    errors: KolChargedErrors
    errorBody: CloudEntryErrorBody
  }
  /** 手动加观察（免费；本机服务转发插件观测也走这条） */
  'POST /v1/data/kol/creators/{channel}/{handle}/observations': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    body: KolPublicObservationsRequest | PublicCreatorObservation
    ok: { status: 201; body: CloudDataEnvelope<ContributionEvent> }
    errors: KolAuthErrors & { 429: 'rate_limited' }
    errorBody: CloudEntryErrorBody
  }
  /** 内容观测（免费；本机服务转发插件采到的内容走这条） */
  'POST /v1/data/kol/content-observations': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    body: KolContentObservationsRequest
    ok: { status: 201; body: CloudDataEnvelope<ContributionEvent> }
    errors: KolAuthErrors & { 429: 'rate_limited'; 501: 'not_implemented' }
    errorBody: CloudEntryErrorBody
  }
  /** 联系方式回填（回填者得奖励） */
  'POST /v1/data/kol/creators/{channel}/{handle}/contact': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    body: KolPublicContactRequest
    ok: { status: 201; body: CloudDataEnvelope<ContributionEvent> }
    errors: KolAuthErrors & { 404: 'not_found'; 501: 'not_implemented' }
    errorBody: CloudEntryErrorBody
  }
  /** 提一条争议（只记不裁） */
  'POST /v1/data/kol/creators/{channel}/{handle}/disputes': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: KolPublicCreatorParams
    body: KolPublicDisputeRequest
    ok: { status: 201; body: CloudDataEnvelope<KolPublicDisputeResult> }
    errors: KolAuthErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /** 插件配对：用工作区令牌换一把 `plg_…`（明文只回这一次） */
  'POST /v1/data/kol/plugins/pair': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    body: KolPluginPairRequest
    ok: { status: 201; body: CloudDataEnvelope<IssuedPluginToken> }
    errors: KolAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 撤一把插件令牌（按它的 sha256） */
  'POST /v1/data/kol/plugins/{sha}/revoke': {
    auth: 'workspace_token'
    scope: 'data'
    tag: 'kol-public'
    params: { sha: string }
    ok: { status: 200; body: CloudDataEnvelope<KolRevokedResult> }
    errors: KolAuthErrors & { 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /**
   * 插件上报观察（只认 `plg_…`，不认工作区令牌）
   * 一批最多 100 条；一把插件令牌一天最多 500 条。
   */
  'POST /v1/data/kol/plugins/observations': {
    auth: 'plugin_token'
    tag: 'kol-public'
    body: KolPluginObservationsRequest
    ok: { status: 201; body: CloudDataEnvelope<ContributionEvent> }
    errors: { 400: 'invalid_input'; 401: 'unauthenticated'; 429: 'rate_limited' }
    errorBody: CloudEntryErrorBody
  }
  /** 插件上报内容观测（只认 `plg_…`） */
  'POST /v1/data/kol/plugins/content-observations': {
    auth: 'plugin_token'
    tag: 'kol-public'
    body: KolContentObservationsRequest
    ok: { status: 201; body: CloudDataEnvelope<ContributionEvent> }
    errors: {
      400: 'invalid_input'
      401: 'unauthenticated'
      429: 'rate_limited'
      501: 'not_implemented'
    }
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：云端红人库（红人营销增值服务，按月订阅）                        */
/* ------------------------------------------------------------------ */

/** 要 `kol` 动作。 */
interface KolCloudErrors extends EntryAuthErrors {
  400: 'invalid_input'
}

/** 同步那几条：没订阅 / 欠费停了回 402（`details: { status, service_id }`）。 */
interface KolCloudSyncErrors extends KolCloudErrors {
  402: 'payment_required'
}

export interface CloudKolCloudApi {
  /** 同步状态：订阅、对象数、最后一次推拉（没订阅也能看） */
  'GET /v1/kol/sync/status': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    ok: { status: 200; body: CloudDataEnvelope<KolSyncStatus> }
    errors: KolCloudErrors
    errorBody: CloudEntryErrorBody
  }
  /** 冲突清单 */
  'GET /v1/kol/sync/conflicts': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    query: { limit?: number }
    ok: { status: 200; body: CloudDataEnvelope<KolSyncConflictList> }
    errors: KolCloudSyncErrors
    errorBody: CloudEntryErrorBody
  }
  /** 标记一条冲突已处理 */
  'POST /v1/kol/sync/conflicts/resolve': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    body: KolSyncConflictResolveRequest
    ok: { status: 200; body: CloudDataEnvelope<KolSyncConflictResolveResult> }
    errors: KolCloudSyncErrors
    errorBody: CloudEntryErrorBody
  }
  /** 推一批对象上云（一批最多 500） */
  'POST /v1/kol/sync/push': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    body: KolSyncPushRequest
    ok: { status: 200; body: CloudDataEnvelope<KolSyncPushResult> }
    errors: KolCloudSyncErrors
    errorBody: CloudEntryErrorBody
  }
  /** 从某个游标往后拉 */
  'GET /v1/kol/sync/pull': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    query: KolSyncPullQuery
    ok: { status: 200; body: CloudDataEnvelope<KolSyncPullResult> }
    errors: KolCloudSyncErrors
    errorBody: CloudEntryErrorBody
  }
  /** 开通（按月 30 积分；钱不够照开、状态进宽限，不回 402） */
  'POST /v1/kol/subscription': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    ok: { status: 200; body: CloudDataEnvelope<KolServiceSubscription> }
    errors: KolCloudErrors
    errorBody: CloudEntryErrorBody
  }
  /** 取消（当期用完为止） */
  'DELETE /v1/kol/subscription': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    ok: { status: 200; body: CloudDataEnvelope<KolServiceSubscription> }
    errors: KolCloudErrors
    errorBody: CloudEntryErrorBody
  }
  /** 把云端这一份整个导出来（随时能带走） */
  'GET /v1/kol/cloud/export': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    ok: { status: 200; body: CloudDataEnvelope<KolCloudExport> }
    errors: KolCloudErrors
    errorBody: CloudEntryErrorBody
  }
  /** 把云端这一份整个删掉 */
  'DELETE /v1/kol/cloud': {
    auth: 'workspace_token'
    scope: 'kol'
    tag: 'kol-cloud'
    ok: { status: 200; body: CloudDataEnvelope<KolCloudDeleteResult> }
    errors: KolCloudErrors
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：客服增值服务、聊天转发                                        */
/* ------------------------------------------------------------------ */

/** owner 面：任何有效的工作区令牌都行（不查动作集），对象按令牌的工作区取。 */
interface RelayOwnerErrors {
  401: 'unauthenticated'
  /** 这个节点没开转发器，或方法不对 */
  404: 'not_found'
}

/** 访客面常见的错误。 */
interface RelayVisitorErrors {
  400: 'invalid_input'
  401: 'unauthorized'
  403: 'origin_not_allowed'
  429: 'rate_limited'
  /** 这个节点的转发器密钥没配好（`retry-after: 300`） */
  503: 'relay_unavailable'
}

export interface CloudChatRelayApi {
  /** 客服增值服务：现在订了没有 */
  'GET /v1/support/subscription': {
    auth: 'workspace_token'
    tag: 'support'
    ok: { status: 200; body: CloudDataEnvelope<SupportSubscriptionView> }
    errors: RelayOwnerErrors
    errorBody: CloudEntryErrorBody
  }
  /**
   * 客服增值服务：开通（按月 30 积分）
   * 钱不够不回 402：订阅照开、状态进 `grace`，`charged` 里那一期 `ok: false`。
   */
  'POST /v1/support/subscription': {
    auth: 'workspace_token'
    tag: 'support'
    ok: { status: 200; body: CloudDataEnvelope<SupportSubscriptionStarted> }
    errors: RelayOwnerErrors
    errorBody: CloudEntryErrorBody
  }
  /** 客服增值服务：取消（当期用完为止；托管实例到期那一拍再停） */
  'DELETE /v1/support/subscription': {
    auth: 'workspace_token'
    tag: 'support'
    ok: { status: 200; body: CloudDataEnvelope<SupportSubscriptionCancelled> }
    errors: RelayOwnerErrors
    errorBody: CloudEntryErrorBody
  }
  /** 签发转发器的配对密钥与留言密钥（只给一次） */
  'POST /v1/chat/relay/pairing': {
    auth: 'workspace_token'
    tag: 'chat-relay'
    ok: { status: 200; body: CloudDataEnvelope<RelayPairingIssued> }
    errors: RelayOwnerErrors & {
      /** 已经签发过（重发等于再泄露一遍） */
      409: 'already_issued'
    }
    errorBody: CloudEntryErrorBody
  }
  /** 转发器状态：本月对话数 / 上限 / 对端在线 / 留言数 / 提醒 */
  'GET /v1/chat/relay/status': {
    auth: 'workspace_token'
    tag: 'chat-relay'
    ok: { status: 200; body: CloudDataEnvelope<RelayOwnerStatus> }
    errors: RelayOwnerErrors
    errorBody: CloudEntryErrorBody
  }
  /** 拉走暂存的访客留言（拉走即清除；密文原样给） */
  'POST /v1/chat/relay/offline-messages': {
    auth: 'workspace_token'
    tag: 'chat-relay'
    ok: { status: 200; body: CloudDataEnvelope<RelayOfflineMessages> }
    errors: RelayOwnerErrors
    errorBody: CloudEntryErrorBody
  }
  /**
   * 商家本机 / 托管实例连上转发器（WebSocket）
   * `Upgrade: websocket` → 101。HTTP 层不验身份：第一帧必须是 `hello`，带配对密钥与协议版本；
   * 之后按 `x-websocket` 的两个方向收发 JSON 帧，15 秒没动静就发 `ping`。
   */
  'GET /relay/{workspace}/connect': {
    auth: 'public'
    tag: 'chat-relay'
    params: RelayWorkspaceParams
    ok: { status: 101; description: '切到 WebSocket' }
    errors: { 426: 'upgrade_required' }
    ws: { client: RelayClientFrame; server: RelayServerFrame }
  }
  /** 挂件脚本（公开资源，谁都能拉；能不能建会话由来源白名单说了算） */
  'GET /relay/{workspace}/widget.js': {
    auth: 'public'
    tag: 'chat-relay'
    params: RelayWorkspaceParams
    ok: { status: 200; body: string; content: 'javascript' }
  }
  /** 挂件外观（来源不在白名单里就回 `enabled: false`） */
  'GET /relay/{workspace}/v1/chat/widget-config': {
    auth: 'public'
    tag: 'chat-relay'
    params: RelayWorkspaceParams
    headers: RelayOriginHeaders
    ok: { status: 200; body: CloudDataEnvelope<RelayWidgetPublicConfig> }
    errors: { 503: 'relay_unavailable' }
    errorBody: RelayVisitorErrorBody
  }
  /** 访客开一个会话（按来源限流：每分钟 10、每小时 60） */
  'POST /relay/{workspace}/v1/chat/public/sessions': {
    auth: 'public'
    tag: 'chat-relay'
    params: RelayWorkspaceParams
    headers: RelayOriginHeaders
    ok: { status: 200; body: CloudDataEnvelope<RelayVisitorSession> }
    errors: RelayVisitorErrors
    errorBody: RelayVisitorErrorBody
  }
  /** 访客在打字（只承载布尔） */
  'POST /relay/{workspace}/v1/chat/public/sessions/{id}/typing': {
    auth: 'visitor'
    tag: 'chat-relay'
    params: RelaySessionParams
    body: RelayVisitorTypingRequest
    ok: { status: 200; body: CloudDataEnvelope<RelayVisitorOk> }
    errors: RelayVisitorErrors
    errorBody: RelayVisitorErrorBody
  }
  /**
   * 访客发一条消息（只确认收到；回复从 SSE 流回来）
   * 202 = 转给对面了；200 = 对面不在或额度到顶，挂件改成留言表单。
   */
  'POST /relay/{workspace}/v1/chat/public/sessions/{id}/messages': {
    auth: 'visitor'
    tag: 'chat-relay'
    params: RelaySessionParams
    headers: RelayOriginHeaders
    body: RelayVisitorMessageRequest
    ok: {
      status: 202
      body: CloudDataEnvelope<RelayVisitorMessageResult>
      description: '转给对面了'
    }
    alt: {
      status: 200
      body: CloudDataEnvelope<RelayVisitorMessageResult>
      description: '对面不在 / 额度到顶（status: offline）'
    }
    errors: RelayVisitorErrors
    errorBody: RelayVisitorErrorBody
  }
  /** 访客留言（对面不在时；封箱存 7 天） */
  'POST /relay/{workspace}/v1/chat/public/offline-messages': {
    auth: 'public'
    tag: 'chat-relay'
    params: RelayWorkspaceParams
    headers: RelayOriginHeaders
    body: RelayOfflineMessageRequest
    ok: { status: 200; body: CloudDataEnvelope<RelayVisitorOk> }
    errors: Omit<RelayVisitorErrors, 401 | 503> & {
      /** 商家还没领留言密钥（不收），或转发器密钥没配好 */
      503: 'offline_unavailable' | 'relay_unavailable'
    }
    errorBody: RelayVisitorErrorBody
  }
  /** 访客的回复流（SSE；第一条恒为 `open`） */
  'GET /relay/{workspace}/v1/chat/public/sessions/{id}/stream': {
    auth: 'visitor'
    tag: 'chat-relay'
    params: RelaySessionParams
    ok: { status: 200; content: 'sse'; sse: RelayVisitorEvent }
    errors: { 401: 'unauthorized'; 503: 'relay_unavailable' }
    errorBody: RelayVisitorErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：托管实例                                                     */
/* ------------------------------------------------------------------ */

interface HostedSnapshotErrors {
  400: 'invalid_input'
  /** 令牌不对，或这把令牌不能用在这里（托管令牌与工作区令牌互不通用） */
  401: 'unauthenticated'
  /** 超过 512 MB */
  413: 'invalid_input'
  /** 这个节点没绑快照桶 */
  503: 'provider_unavailable'
}

export interface CloudHostedApi {
  /** 商家看托管实例的状态（从没开通过 `workspace_id` 是空串） */
  'GET /v1/support/hosted': {
    auth: 'workspace_token'
    tag: 'hosted'
    ok: { status: 200; body: CloudDataEnvelope<HostedInstanceStatus> }
    errors: { 401: 'unauthenticated'; 404: 'not_found' }
    errorBody: CloudEntryErrorBody
  }
  /** 商家取回云端最新的那份快照 */
  'GET /v1/support/hosted/snapshot': {
    auth: 'workspace_token'
    tag: 'hosted'
    ok: { status: 200; body: unknown; content: 'zip'; headers: HostedSnapshotHeaders }
    alt: { status: 204; description: '云上还没有快照' }
    errors: HostedSnapshotErrors
    errorBody: CloudEntryErrorBody
  }
  /** 商家用本机这一份覆盖云端（记成 `local`） */
  'PUT /v1/support/hosted/snapshot': {
    auth: 'workspace_token'
    tag: 'hosted'
    body: unknown
    bodyContent: 'zip'
    ok: { status: 200; body: CloudDataEnvelope<HostedSnapshotStored> }
    errors: HostedSnapshotErrors
    errorBody: CloudEntryErrorBody
  }
  /** 托管实例容器拉快照（只认托管令牌） */
  'GET /v1/hosted/snapshot': {
    auth: 'hosted_instance'
    tag: 'hosted'
    ok: { status: 200; body: unknown; content: 'zip'; headers: HostedSnapshotHeaders }
    alt: { status: 204; description: '云上还没有快照' }
    errors: HostedSnapshotErrors
    errorBody: CloudEntryErrorBody
  }
  /** 托管实例容器推快照（只认托管令牌；记成 `hosted`） */
  'PUT /v1/hosted/snapshot': {
    auth: 'hosted_instance'
    tag: 'hosted'
    body: unknown
    bodyContent: 'zip'
    ok: { status: 200; body: CloudDataEnvelope<HostedSnapshotStored> }
    errors: HostedSnapshotErrors
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：在线值守（只在自建 / Node 形态的云上有；Workers 形态没挂）       */
/* ------------------------------------------------------------------ */

/** 要 `standby` 动作（不在默认动作集里）；`{id}` 必须是令牌自己那个工作区。 */
interface StandbyErrors extends EntryAuthErrors {
  400: 'invalid_input'
  404: 'not_found'
}

export interface CloudStandbyApi {
  /** 本组织的值守工作区（成功直接是正文，没有 `data` 信封） */
  'GET /v1/standby/workspaces': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    ok: { status: 200; body: StandbyWorkspaceList }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 开一个值守工作区（按座位预扣一期） */
  'POST /v1/standby/workspaces': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    body: StandbyOpenRequest
    ok: { status: 201; body: StandbyWorkspace }
    errors: StandbyErrors & {
      402: 'insufficient_credits'
      409: 'conflict'
      503: 'unavailable'
    }
    errorBody: CloudEntryErrorBody
  }
  /** 看一个值守工作区 */
  'GET /v1/standby/workspaces/{id}': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    params: StandbyWorkspaceParams
    ok: { status: 200; body: StandbyWorkspace }
    errors: StandbyErrors
    errorBody: CloudEntryErrorBody
  }
  /** 停掉值守 */
  'POST /v1/standby/workspaces/{id}/stop': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    params: StandbyWorkspaceParams
    ok: { status: 200; body: StandbyWorkspace }
    errors: StandbyErrors
    errorBody: CloudEntryErrorBody
  }
  /** 上传本机导出的工作区包并起值守（zip，上限 512 MB） */
  'POST /v1/standby/workspaces/{id}/import': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    params: StandbyWorkspaceParams
    query: StandbyImportQuery
    body: unknown
    bodyContent: 'zip'
    ok: { status: 201; body: StandbyWorkspace }
    errors: StandbyErrors & {
      402: 'insufficient_credits'
      409: 'conflict'
      /** 包坏了 */
      422: 'corrupt_package'
      503: 'unavailable'
    }
    errorBody: CloudEntryErrorBody
  }
  /** 把值守那一份导回来（zip） */
  'GET /v1/standby/workspaces/{id}/export': {
    auth: 'workspace_token'
    scope: 'standby'
    tag: 'standby'
    params: StandbyWorkspaceParams
    ok: { status: 200; body: unknown; content: 'zip' }
    errors: StandbyErrors
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 路由表：成员 / 岗位额度（WP194）                                     */
/* ------------------------------------------------------------------ */

/**
 * WP194：公司共用余额上的「每月上限」（按人 / 按岗位）。
 *
 * 谁能管由本机判（公司的 owner / admin 才看得到那一页、才会发这几条）；云上认的是
 * 工作区令牌的动作集：看用 `wallet:read`，改用 `wallet:topup`（能管钱的那把）。
 * 「谁」是本机在 {@link AttributionHeaders} 里声明的成员 / 岗位 id。
 */
export interface CloudAllocationApi {
  /** 本月额度与用量：按人、按岗位、按能力（AI / 数据 / 任务 / 其它），以及 80% / 100% 提醒 */
  'GET /v1/wallet/allocation': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    query: AllocationReportQuery
    ok: { status: 200; body: CloudDataEnvelope<AllocationReport> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
  /** 成员自己的「本月额度：已用 X / 上限 Y」（按 `X-Agentsws-Member` / `X-Agentsws-Position`） */
  'GET /v1/wallet/allocation/me': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    headers: AttributionHeaders
    ok: { status: 200; body: CloudDataEnvelope<MyAllocation> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /** 设 / 清一个成员或岗位的每月上限（`null` = 不设上限）；每次改都记审计（谁、从多少改到多少） */
  'POST /v1/wallet/allocation/limits': {
    auth: 'workspace_token'
    scope: 'wallet:topup'
    tag: 'wallet'
    headers: AttributionHeaders
    body: AllocationLimitRequest
    ok: { status: 200; body: CloudDataEnvelope<AllocationLimitChanged> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
  /** 公司时区（自然月按它切；缺省 Asia/Shanghai）与用到 100% 时提醒信发给谁 */
  'POST /v1/wallet/allocation/settings': {
    auth: 'workspace_token'
    scope: 'wallet:topup'
    tag: 'wallet'
    body: AllocationSettings
    ok: { status: 200; body: CloudDataEnvelope<AllocationSettingsView> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
  /** 删成员：清掉他的额度行（历史用量保留，账对得上） */
  'POST /v1/wallet/allocation/members/remove': {
    auth: 'workspace_token'
    scope: 'wallet:topup'
    tag: 'wallet'
    headers: AttributionHeaders
    body: AllocationMemberRemoveRequest
    ok: { status: 200; body: CloudDataEnvelope<AllocationMemberRemoved> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
  /** 最近的改额度记录（新的在前，最多 100 条） */
  'GET /v1/wallet/allocation/audit': {
    auth: 'workspace_token'
    scope: 'wallet:read'
    tag: 'wallet'
    ok: { status: 200; body: CloudDataEnvelope<AllocationAuditList> }
    errors: EntryAuthErrors
    errorBody: CloudEntryErrorBody
  }
  /**
   * WP206：本机把这个工作区的名册推上来（成员 id + 名字 + 持有的岗位、岗位 id + 名字；不带业务内容）。
   * 名册里没了的成员 / 岗位云上自动收回（停用），见 {@link AllocationRosterRequest}
   */
  'POST /v1/wallet/allocation/roster': {
    auth: 'workspace_token'
    scope: 'wallet:topup'
    tag: 'wallet'
    headers: AttributionHeaders
    body: AllocationRosterRequest
    ok: { status: 200; body: CloudDataEnvelope<AllocationRosterSynced> }
    errors: EntryAuthErrors & { 400: 'invalid_input' }
    errorBody: CloudEntryErrorBody
  }
}

/* ------------------------------------------------------------------ */
/* 总表                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 云端对外契约：客户端与其他产品会调的全部云端路径（docs/83 §2 第 1 条）。
 *
 * 真源是 `packages/contracts/src/cloud-api.ts` 的 `CloudApi` 类型；本文件由
 * `node scripts/gen-cloud-contract.mjs` 生成，CI 跑 `--check` 核对零漂移。
 * 三种响应外形照实际行为写：账号层 `{ data, trace_id }`；钱包、红人、转发、托管 `{ data }`；
 * AI、搜索数据、值守直接是正文。运营后台（`/v1/admin/*`）与 Stripe 的回调不在这里；
 * 值守的公网反代 `/w/{workspace_id}/*` 原样转给值守子进程（即 `apps/server` 自己的 API），
 * 也不在这里。
 */
export interface CloudApi
  extends CloudAccountApi,
    CloudWalletApi,
    CloudAllocationApi,
    CloudAiApi,
    CloudSearchDataApi,
    CloudDataServiceApi,
    CloudKolPublicApi,
    CloudKolCloudApi,
    CloudChatRelayApi,
    CloudHostedApi,
    CloudStandbyApi {}

/** 编译期检查：表里每一条都长成 {@link CloudApiOperation} 的样子（写错一个键名就红）。 */
type AssertOperations<T extends Record<keyof T, CloudApiOperation>> = T
export type CloudApiChecked = AssertOperations<CloudApi>
