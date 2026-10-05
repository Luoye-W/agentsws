/**
 * WP236：运行看门狗按真实口径（每 10 秒一个事件、总长 2 分钟不被停；静默 3 分钟才停；20 分钟封顶）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelledEvent,
  cancelReasonOf,
  createRunWatchdog,
  DEFAULT_RUN_TIME_LIMITS,
  resolveRunTimeLimits,
} from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
})

const ms = (s: number): number => s * 1000

describe('WP236 createRunWatchdog', () => {
  it('每 10 秒一个事件、总长 2 分钟：不响', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const dog = createRunWatchdog({
      idleMs: ms(DEFAULT_RUN_TIME_LIMITS.idle_timeout_seconds),
      maxMs: ms(DEFAULT_RUN_TIME_LIMITS.max_duration_seconds),
      onFire: (r) => fired.push(r),
    })
    for (let t = 0; t < 12; t += 1) {
      vi.advanceTimersByTime(ms(10))
      dog.touch()
    }
    expect(fired).toEqual([])
    dog.stop()
    vi.advanceTimersByTime(ms(3600))
    expect(fired).toEqual([])
  })

  it('静默 3 分钟才响 idle_timeout，只响一次', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const dog = createRunWatchdog({
      idleMs: ms(180),
      maxMs: ms(1200),
      onFire: (r) => fired.push(r),
    })
    vi.advanceTimersByTime(ms(179))
    expect(fired).toEqual([])
    vi.advanceTimersByTime(ms(1))
    expect(fired).toEqual(['idle_timeout'])
    expect(dog.fired()).toBe('idle_timeout')
    dog.touch()
    vi.advanceTimersByTime(ms(2000))
    expect(fired).toEqual(['idle_timeout'])
  })

  it('一直忙也在 20 分钟封顶：max_duration', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const dog = createRunWatchdog({
      idleMs: ms(180),
      maxMs: ms(1200),
      onFire: (r) => fired.push(r),
    })
    for (let t = 0; t < 130; t += 1) {
      vi.advanceTimersByTime(ms(10))
      dog.touch()
    }
    expect(fired).toEqual(['max_duration'])
  })
})

describe('WP236 resolveRunTimeLimits', () => {
  it('职责阈值 → 设置 → 缺省；坏值不算；空闲线不长过总时长', () => {
    expect(resolveRunTimeLimits({})).toEqual(DEFAULT_RUN_TIME_LIMITS)
    expect(
      resolveRunTimeLimits({ settings: { idle_timeout_seconds: 300, max_duration_seconds: 1800 } }),
    ).toEqual({ idle_timeout_seconds: 300, max_duration_seconds: 1800 })
    expect(
      resolveRunTimeLimits({
        thresholds: { run_max_duration_seconds: 3600, run_idle_timeout_seconds: -1 },
        settings: { idle_timeout_seconds: 240, max_duration_seconds: 1800 },
      }),
    ).toEqual({ idle_timeout_seconds: 240, max_duration_seconds: 3600 })
    expect(
      resolveRunTimeLimits({ thresholds: { run_max_duration_seconds: 100 } }).idle_timeout_seconds,
    ).toBe(100)
  })
})

describe('WP236 取消原因', () => {
  it('signal.reason 认得就带上，不认得 / 没给 → 事件不写 reason、读的一方当 user', () => {
    const c = new AbortController()
    c.abort('idle_timeout')
    expect(cancelReasonOf(c.signal)).toBe('idle_timeout')
    expect(cancelledEvent(c.signal)).toEqual({ type: 'run.cancelled', reason: 'idle_timeout' })
    const plain = new AbortController()
    plain.abort()
    expect(cancelReasonOf(plain.signal)).toBe('user')
    expect(cancelledEvent(plain.signal)).toEqual({ type: 'run.cancelled' })
  })
})
