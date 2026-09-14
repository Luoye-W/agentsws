/**
 * 聊天入站限流（WP57）。
 *
 * 按 `(workspace, visitor)` 计数：一个访客刷消息，挡的是他一个人，
 * 不该把同一个工作区里别的访客一起挡住——这是这个键选成两段的全部理由。
 *
 * 两个窗口一起看：
 * - **每分钟**：挡住手抖与脚本连发；
 * - **每小时**：挡住"慢速但持续"的那种——每分钟不超标，一小时几千条。
 *
 * 本地档为什么也要限流：聊天的每一轮 `answer` 都会花一次模型调用。
 * 没有这一层，一个循环脚本就能把商家当天的模型预算烧光，然后 22 的预算熔断
 * 会把**邮件那条流水线一起停掉**。限流是在那之前的第一道门。
 */
import type { WorkspaceId } from '@agentsws/contracts'

export interface ChatRateLimitPolicy {
  /** 每分钟每访客最多几条。 */
  per_minute: number
  /** 每小时每访客最多几条。 */
  per_hour: number
}

export const DEFAULT_CHAT_RATE_LIMIT: ChatRateLimitPolicy = { per_minute: 20, per_hour: 200 }

export interface ChatRateVerdict {
  allowed: boolean
  /** 挡下时是哪个窗口满了。 */
  window?: 'minute' | 'hour'
  /** 这两个窗口各自还剩几条。 */
  remaining: { minute: number; hour: number }
  /** 挡下时，多少秒之后再试（秒，向上取整）。 */
  retry_after?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** 一个访客在两个窗口里的时间戳（毫秒）。 */
interface Bucket {
  minute: number[]
  hour: number[]
}

/**
 * 计数器。时间由调用方按注入的 Clock 传进来（本文件没有 `Date.now()`）。
 *
 * 内存档就够：限流是**每进程**的防线，本地档只有一个服务进程；
 * 托管档的多实例限流属于 B 期（那时它会变成一个共享计数器，接口不变）。
 */
export class ChatRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly policy: ChatRateLimitPolicy

  constructor(policy: Partial<ChatRateLimitPolicy> = {}) {
    this.policy = { ...DEFAULT_CHAT_RATE_LIMIT, ...policy }
  }

  /** 取一条配额。返回 `allowed: false` 就该拒收这条消息（不入库、不起运行）。 */
  take(workspace_id: WorkspaceId, visitor_id: string, now_ms: number): ChatRateVerdict {
    const key = `${workspace_id}|${visitor_id}`
    const bucket = this.buckets.get(key) ?? { minute: [], hour: [] }
    bucket.minute = bucket.minute.filter((t) => now_ms - t < MINUTE_MS)
    bucket.hour = bucket.hour.filter((t) => now_ms - t < HOUR_MS)
    this.buckets.set(key, bucket)

    const remaining = {
      minute: Math.max(0, this.policy.per_minute - bucket.minute.length),
      hour: Math.max(0, this.policy.per_hour - bucket.hour.length),
    }
    if (remaining.minute === 0 || remaining.hour === 0) {
      const window = remaining.minute === 0 ? 'minute' : 'hour'
      const oldest = (window === 'minute' ? bucket.minute[0] : bucket.hour[0]) ?? now_ms
      const span = window === 'minute' ? MINUTE_MS : HOUR_MS
      return {
        allowed: false,
        window,
        remaining,
        retry_after: Math.max(1, Math.ceil((oldest + span - now_ms) / 1000)),
      }
    }

    bucket.minute.push(now_ms)
    bucket.hour.push(now_ms)
    return {
      allowed: true,
      remaining: { minute: remaining.minute - 1, hour: remaining.hour - 1 },
    }
  }

  /** 丢掉一小时以前的桶（宿主定时调；不调也只是多占点内存）。 */
  prune(now_ms: number): number {
    let dropped = 0
    for (const [key, bucket] of [...this.buckets]) {
      const alive = bucket.hour.some((t) => now_ms - t < HOUR_MS)
      if (!alive) {
        this.buckets.delete(key)
        dropped += 1
      }
    }
    return dropped
  }
}
