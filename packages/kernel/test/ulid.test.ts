import { describe, expect, it } from 'vitest'
import { createUlidFactory, FixedClock, isUlid, seededRandom, ULID_LEN } from '../src/index.js'

describe('ulid', () => {
  it('生成 26 位 Crockford base32，时间在前', () => {
    const next = createUlidFactory(new FixedClock('2026-09-08T00:00:00.000Z'), seededRandom(7))
    const id = next()
    expect(id).toHaveLength(ULID_LEN)
    expect(isUlid(id)).toBe(true)
  })

  it('注入时钟与随机 → 完全确定性', () => {
    const make = () =>
      createUlidFactory(new FixedClock('2026-09-08T00:00:00.000Z'), seededRandom(7))
    expect([make()(), make()()]).toSatisfy(([a, b]: string[]) => a === b)
  })

  it('同一毫秒内单调递增（随机段 +1）', () => {
    const next = createUlidFactory(new FixedClock('2026-09-08T00:00:00.000Z'), () => 0)
    const ids = [next(), next(), next()]
    expect(ids[0]?.slice(10)).toBe('0000000000000000')
    expect(ids[1]?.slice(10)).toBe('0000000000000001')
    expect(ids[2]?.slice(10)).toBe('0000000000000002')
    expect([...ids].sort()).toEqual(ids)
  })

  it('随机段到顶后拒绝回绕', () => {
    const next = createUlidFactory(new FixedClock('2026-09-08T00:00:00.000Z'), () => 0.9999999)
    const a = next()
    expect(a.slice(10)).toBe('ZZZZZZZZZZZZZZZZ')
    // 同毫秒内随机段已经到顶，再要一个 id 就必须报错，绝不允许回绕成重复 id
    expect(() => next()).toThrow(/randomness exhausted/)
  })

  it('时间前进 → 字典序仍然递增；时间回拨不破坏单调', () => {
    const clock = new FixedClock('2026-09-08T00:00:00.000Z')
    const next = createUlidFactory(clock, seededRandom(3))
    const a = next()
    clock.advance(1000)
    const b = next()
    clock.advance(-5000)
    const c = next()
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it('拒绝非法时钟与越界随机源', () => {
    expect(() => createUlidFactory({ now: () => 'not-a-date' }, () => 0)()).toThrow(/ISO-8601/)
    expect(() =>
      createUlidFactory(new FixedClock('2026-09-08T00:00:00.000Z'), () => 1.5)(),
    ).toThrow(/\[0, 1\)/)
  })
})
