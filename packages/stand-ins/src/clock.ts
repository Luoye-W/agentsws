import type { Iso8601 } from '@agentsws/contracts'
import { FixedClock } from '@agentsws/kernel'
import { StandInError } from './errors.js'

export type ClockHook = (now: Iso8601, step: number) => void | Promise<void>

/**
 * 25 §4 合成时钟：一天的公司生活几秒跑完。复用内核的 `FixedClock`（`now` / `advance` / `sleep` 不真等），
 * 只加模拟回路要的 `advanceTo` / `runUntil`。
 */
export class SyntheticClock extends FixedClock {
  /** 快进到某个时刻；不允许回拨（事件时间戳必须单调，26 §6 / 25 §6.5）。 */
  advanceTo(iso: Iso8601): void {
    const target = Date.parse(iso)
    if (!Number.isFinite(target))
      throw new StandInError('invalid_input', `不是 ISO-8601 时刻：${iso}`)
    const delta = target - this.nowMs()
    if (delta < 0)
      throw new StandInError('invalid_input', `合成时钟不能回拨：${this.now()} → ${iso}`)
    this.advance(delta)
  }

  /** 当前时刻的毫秒值。 */
  nowMs(): number {
    return Date.parse(this.now())
  }

  /**
   * 按 `stepMs` 一步步推进到 `until`，每步之后调一次 `hook`（调度器 tick、合成人 tick 都挂这里）。
   * 返回实际步数 = `ceil((until - now) / stepMs)`；最后一步不会越过 `until`。
   */
  async runUntil(until: Iso8601, stepMs: number, hook?: ClockHook): Promise<number> {
    const target = Date.parse(until)
    if (!Number.isFinite(target))
      throw new StandInError('invalid_input', `不是 ISO-8601 时刻：${until}`)
    if (!Number.isInteger(stepMs) || stepMs <= 0) {
      throw new StandInError('invalid_input', `stepMs 必须是正整数毫秒：${String(stepMs)}`)
    }
    let steps = 0
    while (this.nowMs() < target) {
      this.advance(Math.min(stepMs, target - this.nowMs()))
      steps += 1
      if (hook) await hook(this.now(), steps)
    }
    return steps
  }
}

export function createSyntheticClock(start: Iso8601 | number): SyntheticClock {
  return new SyntheticClock(start)
}
