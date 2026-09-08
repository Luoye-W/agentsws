/**
 * 28 §2 幂等：所有 POST 接受 `Idempotency-Key`，24h 内同键重放原响应；
 * 同键不同请求指纹 → `idempotency_conflict`（409）。
 */

import { createHash } from 'node:crypto'
import type { Clock } from '@agentsws/contracts'

export interface IdempotencyRecord {
  fingerprint: string
  status: number
  body: string
  content_type: string
  stored_at: number
}

export interface IdempotencyStore {
  get(scope: string, key: string, nowMs: number): IdempotencyRecord | undefined
  put(scope: string, key: string, record: IdempotencyRecord): void
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export function fingerprint(method: string, path: string, body: string): string {
  return createHash('sha256').update(`${method}\n${path}\n${body}`).digest('hex')
}

/** 内存表；换 SQLite 时接口不变。 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #rows = new Map<string, IdempotencyRecord>()
  readonly #ttl: number

  constructor(ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS) {
    this.#ttl = ttlMs
  }

  get(scope: string, key: string, nowMs: number): IdempotencyRecord | undefined {
    const k = `${scope}|${key}`
    const row = this.#rows.get(k)
    if (!row) return undefined
    if (nowMs - row.stored_at >= this.#ttl) {
      this.#rows.delete(k)
      return undefined
    }
    return row
  }

  put(scope: string, key: string, record: IdempotencyRecord): void {
    this.#rows.set(`${scope}|${key}`, record)
  }

  /** 过期清理（由宿主定时调用；不用裸 Date.now）。 */
  sweep(clock: Clock): number {
    const now = Date.parse(clock.now())
    let removed = 0
    for (const [k, row] of this.#rows)
      if (now - row.stored_at >= this.#ttl) {
        this.#rows.delete(k)
        removed += 1
      }
    return removed
  }
}
