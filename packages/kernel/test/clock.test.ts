import { describe, expect, it } from 'vitest'
import { FixedClock, seededRandom, systemClock, systemRandom } from '../src/index.js'

describe('注入点：时钟与随机', () => {
  it('systemClock 给 ISO-8601，sleep 可等待', async () => {
    expect(Date.parse(systemClock.now())).not.toBeNaN()
    expect(systemClock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await systemClock.sleep?.(1)
  })

  it('systemRandom 落在 [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const r = systemRandom()
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })

  it('FixedClock 不走动，advance / sleep 才推进', async () => {
    const clock = new FixedClock('2026-09-08T09:00:00.000Z')
    expect(clock.now()).toBe('2026-09-08T09:00:00.000Z')
    expect(clock.now()).toBe('2026-09-08T09:00:00.000Z')
    clock.advance(1500)
    expect(clock.now()).toBe('2026-09-08T09:00:01.500Z')
    await clock.sleep(500)
    expect(clock.now()).toBe('2026-09-08T09:00:02.000Z')
    expect(new FixedClock(0).now()).toBe('1970-01-01T00:00:00.000Z')
    expect(() => new FixedClock('nope')).toThrow(/invalid clock start/)
  })

  it('seededRandom 同种子同序列、异种子异序列，且全部落在 [0, 1)', () => {
    const take = (seed: number) => Array.from({ length: 20 }, seededRandom(seed))
    expect(take(5)).toEqual(take(5))
    expect(take(5)).not.toEqual(take(6))
    for (const r of [...take(5), ...take(0)]) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })
})
