/** 日程与冲突：撞不撞、为什么撞、往后哪几个时段能约（41 §1.2 第二行）。 */
import { describe, expect, it } from 'vitest'
import {
  type Availability,
  alternativeSlots,
  busySlots,
  checkAgenda,
  DEFAULT_AVAILABILITY,
  parseHm,
  withinAvailability,
} from '../src/index.js'
import { meeting, T0, TZ } from './helpers.js'

/** 工作日 09:00–18:00（本地 +8）→ UTC 01:00–10:00。 */
const WORK: Availability = DEFAULT_AVAILABILITY

const slot = (from: string, to: string) => ({ start: from, end: to })

describe('时间小工具', () => {
  it('HH:MM', () => {
    expect(parseHm('09:00')).toBe(540)
    expect(parseHm('9:30')).toBe(570)
    expect(parseHm('乱写')).toBeUndefined()
    expect(parseHm('25:00')).toBeUndefined()
  })
})

describe('在不在可用时段里', () => {
  it('周一 10:00–10:30（本地）在 9–18 里', () => {
    expect(
      withinAvailability(slot('2026-09-07T02:00:00.000Z', '2026-09-07T02:30:00.000Z'), WORK, TZ),
    ).toBe(true)
  })

  it('周一 20:00（本地）不在', () => {
    expect(
      withinAvailability(slot('2026-09-07T12:00:00.000Z', '2026-09-07T12:30:00.000Z'), WORK, TZ),
    ).toBe(false)
  })

  it('周六不在（规则只写了周一到周五）', () => {
    expect(
      withinAvailability(slot('2026-09-12T02:00:00.000Z', '2026-09-12T02:30:00.000Z'), WORK, TZ),
    ).toBe(false)
  })
})

describe('撞不撞', () => {
  const items = [meeting('m1', '2026-09-07T02:00:00.000Z', '2026-09-07T03:00:00.000Z', '周会')]

  it('空档能约', () => {
    const r = checkAgenda({
      slot: slot('2026-09-07T05:00:00.000Z', '2026-09-07T05:30:00.000Z'),
      items,
      availability: WORK,
      tz_offset_minutes: TZ,
      now: T0,
    })
    expect(r.ok).toBe(true)
    expect(r.alternatives).toEqual([])
  })

  it('撞上已有的会：说清楚撞的是哪一条，并给替代时段', () => {
    const r = checkAgenda({
      slot: slot('2026-09-07T02:30:00.000Z', '2026-09-07T03:00:00.000Z'),
      items,
      availability: WORK,
      tz_offset_minutes: TZ,
      now: T0,
    })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('busy')
    expect(r.conflicts[0]?.title).toBe('周会')
    expect(r.alternatives.length).toBeGreaterThan(0)
    // 替代时段自己不能再撞
    for (const alt of r.alternatives) {
      expect(
        checkAgenda({
          slot: alt,
          items,
          availability: WORK,
          tz_offset_minutes: TZ,
          now: T0,
        }).ok,
      ).toBe(true)
    }
  })

  it('不在可用时段里也算撞，理由不一样', () => {
    const r = checkAgenda({
      slot: slot('2026-09-07T13:00:00.000Z', '2026-09-07T13:30:00.000Z'),
      items,
      availability: WORK,
      tz_offset_minutes: TZ,
      now: T0,
    })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('outside_availability')
    expect(r.reasons).not.toContain('busy')
  })

  it('已经过去的时段不给约', () => {
    const r = checkAgenda({
      slot: slot('2026-09-04T02:00:00.000Z', '2026-09-04T02:30:00.000Z'),
      items: [],
      availability: WORK,
      tz_offset_minutes: TZ,
      now: T0,
    })
    expect(r.reasons).toContain('in_the_past')
  })

  it('一天最多两场：满了就不给约', () => {
    const busy: Availability = { ...WORK, max_meetings_per_day: 2 }
    const two = [
      meeting('m1', '2026-09-07T02:00:00.000Z', '2026-09-07T03:00:00.000Z'),
      meeting('m2', '2026-09-07T06:00:00.000Z', '2026-09-07T07:00:00.000Z'),
    ]
    const r = checkAgenda({
      slot: slot('2026-09-07T04:00:00.000Z', '2026-09-07T04:30:00.000Z'),
      items: two,
      availability: busy,
      tz_offset_minutes: TZ,
      now: T0,
    })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('too_many_meetings')
    // 替代时段跳到第二天
    expect(r.alternatives[0]?.start.slice(0, 10)).toBe('2026-09-08')
  })
})

describe('替代时段', () => {
  it('确定的：同样的输入永远出同样的几个', () => {
    const input = {
      from: T0,
      duration_minutes: 30,
      items: [meeting('m1', '2026-09-07T01:00:00.000Z', '2026-09-07T02:00:00.000Z')],
      availability: WORK,
      tz_offset_minutes: TZ,
      limit: 3,
    }
    expect(alternativeSlots(input)).toEqual(alternativeSlots(input))
    expect(alternativeSlots(input)).toHaveLength(3)
    // 第一场会占了 09:00–10:00，所以第一个空档是 10:00
    expect(alternativeSlots(input)[0]?.start).toBe('2026-09-07T02:00:00.000Z')
  })

  it('周末跳过去（可用时段只写了工作日）', () => {
    const alts = alternativeSlots({
      // 周五本地 18:30，工作时段已经过了
      from: '2026-09-11T10:30:00.000Z',
      duration_minutes: 30,
      items: [],
      availability: WORK,
      tz_offset_minutes: TZ,
      limit: 1,
    })
    // 周六周日不在规则里 → 下一个是周一早上
    expect(alts[0]?.start).toBe('2026-09-14T01:00:00.000Z')
  })
})

describe('忙闲只报时段', () => {
  it('相邻的合并成一段，标题一个字都不带', () => {
    const slots = busySlots([
      meeting('m1', '2026-09-07T02:00:00.000Z', '2026-09-07T03:00:00.000Z', '和王岚聊定价'),
      meeting('m2', '2026-09-07T03:00:00.000Z', '2026-09-07T04:00:00.000Z', '一对一'),
      meeting('m3', '2026-09-07T06:00:00.000Z', '2026-09-07T07:00:00.000Z', '复盘'),
    ])
    expect(slots).toEqual([
      { start: '2026-09-07T02:00:00.000Z', end: '2026-09-07T04:00:00.000Z' },
      { start: '2026-09-07T06:00:00.000Z', end: '2026-09-07T07:00:00.000Z' },
    ])
    expect(JSON.stringify(slots)).not.toContain('王岚')
  })

  it('全天项（待办到期 / 卡片到期）不算"在开会"', () => {
    expect(
      busySlots([
        {
          id: 'cal_todo_1',
          source: 'todo',
          title: '交周报',
          start: '2026-09-07T00:00:00.000Z',
          all_day: true,
          ref: { type: 'todo', id: 't1' },
        },
      ]),
    ).toEqual([])
  })
})
