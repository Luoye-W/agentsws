/** 崩溃重启退避：指数 + 上限 + 可注入抖动（随机经注入的 seed，35 §2）。 */

export interface BackoffOptions {
  /** 第一次重试的等待，默认 500ms。 */
  baseMs?: number
  /** 倍数，默认 2。 */
  factor?: number
  /** 上限，默认 30s。 */
  maxMs?: number
  /** 抖动比例 0..1，默认 0（确定性）。 */
  jitter?: number
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 500,
  factor: 2,
  maxMs: 30_000,
  jitter: 0,
}

/**
 * @param attempt 第几次重试，从 1 开始；小于 1 按 1 算。
 * @param random 返回 [0,1)；只在 `jitter > 0` 时用到。
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = () => 0,
): number {
  const { baseMs, factor, maxMs, jitter } = { ...DEFAULT_BACKOFF, ...options }
  const n = attempt < 1 ? 1 : Math.floor(attempt)
  const raw = baseMs * factor ** (n - 1)
  const capped = Math.min(raw, maxMs)
  if (jitter <= 0) return Math.round(capped)
  const spread = capped * jitter
  return Math.round(Math.min(maxMs, capped - spread / 2 + spread * random()))
}
