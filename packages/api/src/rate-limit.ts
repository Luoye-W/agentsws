/** 28 §2 限流：按 workspace × kind 的令牌桶；超限 429 带 `Retry-After`。 */
import type { RateLimitPolicy } from './types.js'

export interface RateLimitVerdict {
  allowed: boolean
  /** 超限时建议的等待秒数（≥1）。 */
  retry_after: number
  remaining: number
}

interface Bucket {
  tokens: number
  updated_ms: number
}

const FALLBACK_POLICY: RateLimitPolicy = { burst: 240, per_second: 8 }

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitPolicy> = {
  default: { burst: 240, per_second: 8 },
  session: { burst: 240, per_second: 8 },
  api_key: { burst: 120, per_second: 4 },
  runtime: { burst: 240, per_second: 8 },
  internal: { burst: 600, per_second: 20 },
}

export class TokenBucketLimiter {
  readonly #buckets = new Map<string, Bucket>()
  readonly #policies: Record<string, RateLimitPolicy>

  /** 给了 `default` 就同时改掉所有没被显式覆盖的 kind——否则「调小默认值」不生效。 */
  constructor(policies: Partial<Record<string, RateLimitPolicy>> = {}) {
    const fallback = policies.default
    const merged: Record<string, RateLimitPolicy> = {}
    for (const [k, v] of Object.entries(DEFAULT_RATE_LIMITS)) merged[k] = fallback ?? v
    for (const [k, v] of Object.entries(policies)) if (v) merged[k] = v
    this.#policies = merged
  }

  policyFor(kind: string): RateLimitPolicy {
    return this.#policies[kind] ?? this.#policies.default ?? FALLBACK_POLICY
  }

  /** 取一个令牌。`nowMs` 由调用方经 Clock 给出，不用裸 Date.now。 */
  take(workspace_id: string, kind: string, nowMs: number): RateLimitVerdict {
    const policy = this.policyFor(kind)
    const key = `${workspace_id}|${kind}`
    const bucket = this.#buckets.get(key) ?? { tokens: policy.burst, updated_ms: nowMs }
    const elapsed = Math.max(0, nowMs - bucket.updated_ms) / 1000
    bucket.tokens = Math.min(policy.burst, bucket.tokens + elapsed * policy.per_second)
    bucket.updated_ms = nowMs
    if (bucket.tokens < 1) {
      const wait = policy.per_second > 0 ? (1 - bucket.tokens) / policy.per_second : 60
      this.#buckets.set(key, bucket)
      return { allowed: false, retry_after: Math.max(1, Math.ceil(wait)), remaining: 0 }
    }
    bucket.tokens -= 1
    this.#buckets.set(key, bucket)
    return { allowed: true, retry_after: 0, remaining: Math.floor(bucket.tokens) }
  }
}
