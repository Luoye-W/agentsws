import type { Clock, RunResult } from '@agentsws/contracts'

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

interface Entry {
  at_ms: number
  result: RunResult
}

/**
 * 17 §5.7 幂等：同一个 `idempotency_key` 的 RunRequest 在 24h 窗口内返回**原来那份** RunResult，
 * 不重跑、不重发事件。内存表（进程内）；持久化留给协同服务。
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS,
  ) {}

  get(key: string): RunResult | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    if (Date.parse(this.clock.now()) - hit.at_ms >= this.windowMs) {
      this.entries.delete(key)
      return undefined
    }
    return hit.result
  }

  put(key: string, result: RunResult): void {
    this.entries.set(key, { at_ms: Date.parse(this.clock.now()), result })
  }

  get size(): number {
    return this.entries.size
  }
}
