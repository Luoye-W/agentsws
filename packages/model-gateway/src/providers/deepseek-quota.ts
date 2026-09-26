/**
 * WP151：DeepSeek **余额不足**——怎么判、说什么、引到哪儿去充值。
 *
 * 判定照官方（MIT，`@deepseek-ai/dsh-llm@0.1.7-rc.2` 与 `dsh-llm-deepseek@0.1.7-rc.2`）：
 *
 * - 官方 `providerError`（`dsh-llm-deepseek` `lib/index.js`）的次序：**401 / 403 先算"凭据"**，
 *   然后才是"余额 / 额度"——`isQuotaExceededError(错误的 type + code + message) || status === 402`
 *   就是 `QUOTA`；
 * - 账号那一路（`dsh-llm-deepseek-account` `lib/index.js` 的 `onRequestError`）把 `QUOTA` 改写成
 *   `ACCOUNT_QUOTA`：只有这一码的提示里有"去充值"（充到登录的那个账号）；API key 那一路保留 `QUOTA`，
 *   官方 README 原话「账号路由的充值操作不会出现在 API Key 或第三方失败上」——rc.2 发布说明里的
 *   「避免 API Key 用户误充到登录账号」。
 *
 * 我们的对应：provider 以 `GatewayError('provider_error', 人话, { reason })` 失败，`reason` 是
 * `account_quota`（账号路）或 `quota`（API key 路）；网关不降级、原样往上抛；运行的失败原因就是这句人话。
 * **不是登录失效**（WP150 那条只认 401），不碰登录状态；也**不自动换别的模型**。
 *
 * `isQuotaExceededError` 的正则逐字移植自官方 `dsh-llm` `lib/index.js`。
 */
import { GatewayError } from '../types.js'

/** 账号路余额不足：那一次运行的失败原因、事项时间线、卡片上的提示都是这一句。 */
export const DEEPSEEK_ACCOUNT_QUOTA_MESSAGE = 'DeepSeek 账号余额不足，充值后再让它接着做。'

/** API key 路余额不足（钱从开放平台扣，不是从登录的账号扣）。 */
export const DEEPSEEK_API_QUOTA_MESSAGE = 'DeepSeek API 余额不足。用建这把 key 的那个 DeepSeek 账号登录开放平台，充值后再试。'

/**
 * API key 路的充值页：开放平台的充值页（官方账号模块 `links.topUpUrl` 同一个平台源
 * `https://platform.deepseek.com` + `/top_up`）。账号路用官方 `links.topUpUrl`，不用这个常量。
 */
export const DEEPSEEK_PLATFORM_TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** 余额不足是哪一路的：账号（官方 `ACCOUNT_QUOTA`）还是 API key（官方 `QUOTA`）。 */
export type DeepSeekQuotaKind = 'account' | 'api_key'

/**
 * provider 报"余额是不是够"的回调：上游说余额不足（`true`）、一次调用成功（`false`，说明又够了）。
 * 装配方据此在模型卡 / 顶栏上出、收那一行提示。
 */
export type DeepSeekBalanceListener = (insufficient: boolean) => void

/** 官方 `isQuotaExceededError`（逐字移植）：只认"额度 / 余额 / 点数用完"的措辞，不认限流。 */
export function isQuotaExceededError(detail: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
  )
}

/**
 * 官方拿来判的那段文字：**只看**错误信封里的 `type` / `code` / `message`（官方 `providerError`
 * 同款）。正文不是这种信封（代理页、纯文本）就不拿措辞判，只认 402。
 */
function detailOf(body: string): string {
  try {
    const raw = JSON.parse(body) as { error?: unknown } | null
    const error = raw?.error
    if (typeof error === 'object' && error !== null) {
      const f = error as { type?: unknown; code?: unknown; message?: unknown }
      return [f.type, f.code, f.message].filter((v) => typeof v === 'string').join(' ')
    }
  } catch {}
  return ''
}

/** 这一次失败算不算余额不足（照官方次序：401 / 403 先算凭据问题，不算余额）。 */
export function isDeepSeekQuotaFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return false
  return status === 402 || isQuotaExceededError(detailOf(body))
}

/** 余额不足那一次调用抛的错（网关认它、原样往上抛）。 */
export function deepseekQuotaError(
  kind: DeepSeekQuotaKind,
  status: number,
  message?: string,
): GatewayError {
  return new GatewayError(
    'provider_error',
    message ?? (kind === 'account' ? DEEPSEEK_ACCOUNT_QUOTA_MESSAGE : DEEPSEEK_API_QUOTA_MESSAGE),
    {
      source: kind === 'account' ? 'deepseek_account' : 'deepseek',
      reason: kind === 'account' ? 'account_quota' : 'quota',
      status,
    },
  )
}

/**
 * 一个错误是不是"DeepSeek 余额不足"、是哪一路的。只看形状（`code` + `details.reason`），
 * 不认 `instanceof`——错误可能经过转发层。
 */
export function deepseekQuotaKindOf(e: unknown): DeepSeekQuotaKind | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const { code, details } = e as { code?: unknown; details?: unknown }
  if (code !== 'provider_error' || typeof details !== 'object' || details === null) return undefined
  const reason = (details as { reason?: unknown }).reason
  if (reason === 'account_quota') return 'account'
  if (reason === 'quota') return 'api_key'
  return undefined
}
