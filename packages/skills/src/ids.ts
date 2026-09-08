import type { Clock } from '@agentsws/contracts'
import { invalidInput } from './errors.js'

/** Crockford base32（ULID 字母表）。 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RAND_LEN = 16

export type IdFactory = () => string

/**
 * 24 §1：段 id = 隐藏 ULID。时间经注入 Clock，随机经注入 random，
 * 同一毫秒内单调递增，保证在冻结时钟的测试里也不会撞 id。
 */
export function createUlidFactory(clock: Clock, random: () => number): IdFactory {
  let lastMs = Number.NaN
  let lastRand: number[] = []

  return () => {
    const ms = Date.parse(clock.now())
    if (!Number.isFinite(ms)) throw invalidInput(`clock.now() 不是合法 ISO8601：${clock.now()}`)
    if (ms === lastMs) {
      // 单调递增随机部分
      for (let i = RAND_LEN - 1; i >= 0; i--) {
        const v = (lastRand[i] ?? 0) + 1
        if (v < 32) {
          lastRand[i] = v
          break
        }
        lastRand[i] = 0
      }
    } else {
      lastMs = ms
      lastRand = Array.from({ length: RAND_LEN }, () => Math.floor(random() * 32) % 32)
    }
    let time = ''
    let n = ms
    for (let i = 0; i < TIME_LEN; i++) {
      time = (B32[n % 32] ?? '0') + time
      n = Math.floor(n / 32)
    }
    return time + lastRand.map((r) => B32[r] ?? '0').join('')
  }
}
