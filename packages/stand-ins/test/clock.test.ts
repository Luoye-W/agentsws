import { describe, expect, it } from 'vitest'
import { createSyntheticClock, StandInError, SyntheticClock } from '../src/index.js'

const START = '2026-09-07T09:00:00.000Z'

describe('合成时钟（25 §4）', () => {
  it('advance / advanceTo / nowMs', () => {
    const clock = new SyntheticClock(START)
    expect(clock.now()).toBe(START)
    clock.advance(3600_000)
    expect(clock.now()).toBe('2026-09-07T10:00:00.000Z')
    clock.advanceTo('2026-09-08T09:00:00.000Z')
    expect(clock.nowMs()).toBe(Date.parse('2026-09-08T09:00:00.000Z'))
    expect(createSyntheticClock(Date.parse(START)).now()).toBe(START)
  })

  it('不允许回拨；非法时刻报错', () => {
    const clock = new SyntheticClock(START)
    expect(() => clock.advanceTo('2026-09-06T09:00:00.000Z')).toThrow(StandInError)
    expect(() => clock.advanceTo('昨天')).toThrowError(/ISO-8601/)
  })

  it('sleep 不真等，只推进虚拟时间', async () => {
    const clock = new SyntheticClock(START)
    const wall = Date.now()
    await clock.sleep(86_400_000)
    expect(clock.now()).toBe('2026-09-08T09:00:00.000Z')
    expect(Date.now() - wall).toBeLessThan(1000)
  })

  it('runUntil 的步数与 hook 调用次数正确', async () => {
    const clock = new SyntheticClock(START)
    const seen: string[] = []
    const steps = await clock.runUntil('2026-09-07T13:00:00.000Z', 3600_000, (now) => {
      seen.push(now)
    })
    expect(steps).toBe(4)
    expect(seen).toEqual([
      '2026-09-07T10:00:00.000Z',
      '2026-09-07T11:00:00.000Z',
      '2026-09-07T12:00:00.000Z',
      '2026-09-07T13:00:00.000Z',
    ])
    expect(clock.now()).toBe('2026-09-07T13:00:00.000Z')
  })

  it('最后一步不越过终点；已经到点则零步', async () => {
    const clock = new SyntheticClock(START)
    let calls = 0
    const steps = await clock.runUntil('2026-09-07T09:00:01.000Z', 400, () => {
      calls += 1
    })
    expect(steps).toBe(3)
    expect(calls).toBe(3)
    expect(clock.now()).toBe('2026-09-07T09:00:01.000Z')
    expect(await clock.runUntil('2026-09-07T09:00:01.000Z', 100)).toBe(0)
  })

  it('runUntil 支持异步 hook，30 天快进的时间戳单调', async () => {
    const clock = new SyntheticClock(START)
    const stamps: number[] = []
    const steps = await clock.runUntil('2026-10-07T09:00:00.000Z', 86_400_000, async (now) => {
      await Promise.resolve()
      stamps.push(Date.parse(now))
    })
    expect(steps).toBe(30)
    expect(stamps).toHaveLength(30)
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] as number).toBeGreaterThan(stamps[i - 1] as number)
    }
  })

  it('非法参数', async () => {
    const clock = new SyntheticClock(START)
    await expect(clock.runUntil('不是时间', 100)).rejects.toThrowError(/ISO-8601/)
    await expect(clock.runUntil('2026-09-08T09:00:00.000Z', 0)).rejects.toThrowError(/stepMs/)
    await expect(clock.runUntil('2026-09-08T09:00:00.000Z', 1.5)).rejects.toThrowError(/stepMs/)
    expect(() => new SyntheticClock('nope')).toThrow(RangeError)
  })
})
