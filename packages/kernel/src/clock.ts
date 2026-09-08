/**
 * 注入点：时间与随机（35 §2「时间经注入的 Clock；随机经注入的 seed；不用 Date.now() / Math.random() 裸调」）。
 * 内核任何地方都不直接调用 `Date.now()` / `Math.random()`——只有这里的两个系统实现调用，
 * 它们是显式的注入默认值，测试用确定性替身覆盖。
 */
import type { Clock } from '@agentsws/contracts'

export type { Clock }

/** 随机源：返回 [0, 1) 的浮点数，与 `Math.random` 同签名，便于注入种子化实现。 */
export type Random = () => number

/** 默认时钟（系统时间）。模拟与测试用 25 §4 的合成时钟替换。 */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

/** 默认随机源。测试注入确定性实现。 */
export const systemRandom: Random = () => Math.random()

/** 固定时刻的时钟，可手动推进；测试与模拟回路用。 */
export class FixedClock implements Clock {
  private ms: number

  constructor(start: string | number) {
    this.ms = typeof start === 'number' ? start : Date.parse(start)
    if (!Number.isFinite(this.ms)) throw new RangeError(`invalid clock start: ${String(start)}`)
  }

  now(): string {
    return new Date(this.ms).toISOString()
  }

  /** 快进指定毫秒。 */
  advance(ms: number): void {
    this.ms += ms
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms)
  }
}

/** 确定性随机源（xorshift128，seed 决定序列）；替代 `Math.random` 用于可复现测试。 */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0 || 0x9e3779b9
  let b = 0x243f6a88
  let c = 0x85a308d3
  let d = 0x13198a2e
  return () => {
    const t = a ^ (a << 11)
    a = b
    b = c
    c = d
    d = d ^ (d >>> 19) ^ (t ^ (t >>> 8))
    return (d >>> 0) / 0x100000000
  }
}
