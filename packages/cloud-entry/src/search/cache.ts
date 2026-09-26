/**
 * WP155：官方数据接口的结果缓存。
 *
 * 规矩（Luoye 09-21 定，docs/75 §2 第 1 条）：**命中缓存与未命中收同样的钱**——
 * 缓存省的是我们的上游成本，不是用户的积分。命中时我方成本记 0，收入不变。
 *
 * 这一版是进程内的 LRU + TTL（Workers 形态里就是那个组织的 `WalletDO` 的内存，
 * 对象睡着了缓存就没了——没关系，缓存只影响我们的成本，不影响用户付多少、拿到什么）。
 * 换成持久的只要实现同一个接口。
 */

export interface SearchCache {
  get(key: string, now: number): unknown
  put(key: string, value: unknown, now: number, ttlMs: number): void
}

/** SERP 与 AI 回答都缓存 24 小时：排名与回答一天之内变化不大，GEO 探测本来就是每周一次。 */
export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export class MemorySearchCache implements SearchCache {
  readonly #rows = new Map<string, { value: unknown; expires: number }>()
  readonly #max: number
  constructor(max = 500) {
    this.#max = max
  }
  get(key: string, now: number): unknown {
    const row = this.#rows.get(key)
    if (row === undefined) return undefined
    if (row.expires <= now) {
      this.#rows.delete(key)
      return undefined
    }
    // 摸一下挪到队尾（LRU）
    this.#rows.delete(key)
    this.#rows.set(key, row)
    return row.value
  }
  put(key: string, value: unknown, now: number, ttlMs: number): void {
    this.#rows.delete(key)
    this.#rows.set(key, { value, expires: now + ttlMs })
    while (this.#rows.size > this.#max) {
      const oldest = this.#rows.keys().next().value
      if (oldest === undefined) break
      this.#rows.delete(oldest)
    }
  }
}
