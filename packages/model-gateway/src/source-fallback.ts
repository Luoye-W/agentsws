/**
 * WP425：AI 来源顺序——**自己的 AI 优先，用不了再用工坊积分**。
 *
 * 主用是用户自己的（ChatGPT 订阅 / 自己的 API key / DeepSeek 账号），备用是工坊积分（登录了工坊账号才有）。
 * 什么时候切（三种原因）：
 *
 * - `quota`：额度用完——订阅限额（`rate_limited`）、429、402、DeepSeek 余额不足；
 * - `unreachable`：连不上——网络错、5xx、超时（provider 内部重发过之后仍失败）；
 * - `auth`：key / 登录失效——401、403、`unauthenticated`。
 *
 * 不切的：请求本身不对（400 / 工具名冲突 / 没填 key 这类配置问题）、调用方停的、已经往外吐过字的
 * （换一家从头说会把两段拼在一起）、主用本身就是工坊积分、设置页「测试」那一次（测的就是这一家）。
 *
 * 这一层只有**判断与说法**；记「这一轮切过了」与真去调备用是网关的事（{@link ../gateway.ts}）。
 */
import type { ModelRef, ModelSourceSwitchReason } from '@agentsws/contracts'
import { deepseekQuotaKindOf } from './providers/deepseek-quota.js'
import { GatewayError, ProviderError } from './types.js'

/**
 * 网关策略里的「备用」那一格。宿主（设置页那一处）装配：登录了工坊账号才给；
 * `enabled` 是开关「自己的用不了时用工坊积分接着做」（登录了默认开）。
 */
export interface SourceFallbackPolicy {
  /** 工坊积分那一条（provider id + 模型）。 */
  to: ModelRef
  /** 开关。`false` = 不切、照实停下（错误上带 {@link SourceFallbackOff}，界面据此出「用工坊积分接着做」那张卡）。 */
  enabled: boolean
  /** provider id → 给人看的来源名（「ChatGPT」「DeepSeek 官方」）。没有就说「你自己的 AI」。 */
  labels?: Record<string, string>
}

/** 开关关着、因此停下时挂在错误 `details.source_fallback` 上的那一格。 */
export interface SourceFallbackOff {
  state: 'off'
  reason: ModelSourceSwitchReason
  /** 主用那一条（provider/model）。 */
  from: string
  /** 给人看的来源名。 */
  label: string
}

/** 一次失败算不算「该切到工坊积分」的那三种之一；不算回 `undefined`。 */
export function sourceSwitchReasonOf(e: unknown): ModelSourceSwitchReason | undefined {
  if (e instanceof GatewayError) {
    if (e.code === 'rate_limited') return 'quota'
    if (e.code === 'unauthenticated') return 'auth'
    if (deepseekQuotaKindOf(e) !== undefined) return 'quota'
    // `budget_exhausted` 不算：要么是本机三级预算（换来源也是同一本账），要么是工坊积分自己的 402
    if (e.code === 'provider_unavailable') {
      const status = statusInAttempts(e.details)
      return status === undefined ? 'unreachable' : reasonOfStatus(status)
    }
    return undefined
  }
  if (e instanceof ProviderError) {
    if (e.status === undefined) return 'unreachable'
    return reasonOfStatus(e.status)
  }
  if (e instanceof Error) {
    const code = (e as { code?: string }).code
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || code === 'ETIMEDOUT')
      return 'unreachable'
  }
  return undefined
}

function reasonOfStatus(status: number): ModelSourceSwitchReason | undefined {
  if (status === 429 || status === 402) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'unreachable'
  return undefined
}

/** `provider_unavailable` 的 details（`ProviderDownPayload`）里最后一次尝试的状态码。 */
function statusInAttempts(details: unknown): number | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const attempts = (details as { attempts?: unknown }).attempts
  if (!Array.isArray(attempts)) return undefined
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const status = (attempts[i] as { status?: unknown } | undefined)?.status
    if (typeof status === 'number') return status
  }
  return undefined
}

const OWN_AI = '你自己的 AI'

/** 主用来源给人看的名字。 */
export function sourceLabelOf(policy: SourceFallbackPolicy, from: ModelRef): string {
  const label = policy.labels?.[from.provider]?.trim()
  return label === undefined || label === '' ? OWN_AI : label
}

/** 「你的 X 额度用完了」那半句。 */
function whatHappened(reason: ModelSourceSwitchReason, label: string): string {
  const name = label === OWN_AI ? label : `你的 ${label}`
  // 中英文之间空一格（「你的 ChatGPT 额度」「你的 DeepSeek 官方额度」）
  const who = /[A-Za-z0-9)]$/u.test(name) ? `${name} ` : name
  if (reason === 'quota') return `${who}额度用完了`
  if (reason === 'auth') return `${who}登录或 key 失效了`
  return `${who}连不上`
}

/** 切过去那一轮的那一句（运行记录与对话里同一句）。 */
export function sourceSwitchMessage(reason: ModelSourceSwitchReason, label: string): string {
  return `${whatHappened(reason, label)}，这一轮用工坊积分`
}

/** 开关关着时停下的那一句里固定的那半句（dsh 那一档的模型错不带码，宿主认这半句出卡）。 */
export const SOURCE_FALLBACK_OFF_MARK = '「自己的用不了时用工坊积分接着做」关着'

/** 开关关着时停下的那一句。 */
export function sourceFallbackOffMessage(reason: ModelSourceSwitchReason, label: string): string {
  return `${whatHappened(reason, label)}。${SOURCE_FALLBACK_OFF_MARK}，这一轮先停下`
}

/** 一句失败原因是不是「开关关着、停下了」（认 {@link SOURCE_FALLBACK_OFF_MARK}）。 */
export function isSourceFallbackOffText(message: string): boolean {
  return message.includes(SOURCE_FALLBACK_OFF_MARK)
}

/** 错误上有没有「开关关着、停下了」那一格（只看形状，不认 instanceof——错误可能经过转发层）。 */
export function sourceFallbackOffOf(e: unknown): SourceFallbackOff | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const details = (e as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const off = (details as { source_fallback?: unknown }).source_fallback
  if (typeof off !== 'object' || off === null) return undefined
  const o = off as Partial<SourceFallbackOff>
  if (o.state !== 'off' || typeof o.reason !== 'string' || typeof o.from !== 'string')
    return undefined
  return {
    state: 'off',
    reason: o.reason,
    from: o.from,
    label: typeof o.label === 'string' ? o.label : OWN_AI,
  }
}

/** 停下时抛的错：原来的错码照旧（老的卡片逻辑照认），话换成那一句，带上 {@link SourceFallbackOff}。 */
export function sourceFallbackOffError(
  e: unknown,
  reason: ModelSourceSwitchReason,
  from: ModelRef,
  label: string,
): GatewayError {
  const code = e instanceof GatewayError ? e.code : 'provider_unavailable'
  const base =
    e instanceof GatewayError && typeof e.details === 'object' && e.details !== null
      ? (e.details as Record<string, unknown>)
      : {}
  const off: SourceFallbackOff = {
    state: 'off',
    reason,
    from: `${from.provider}/${from.model}`,
    label,
  }
  return new GatewayError(code, sourceFallbackOffMessage(reason, label), {
    ...base,
    source_fallback: off,
  })
}
