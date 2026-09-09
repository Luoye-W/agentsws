import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ON_CALENDAR,
  addWorkingMinutes,
  classifyText,
  computeSla,
  DEFAULT_BUSINESS_CALENDAR,
  DEFAULT_SLA_TARGETS,
  daysBetween,
  responseDayKey,
  SLA_CRITICAL_MINUTES,
  SLA_REMINDER_MINUTES,
  SLA_WINDOW_MINUTES,
  slaCycleStamp,
  targetsFor,
} from '../src/index.js'

const ANCHOR = '2026-09-07T01:00:00.000Z'

describe('SLA（KefuAgent amazon-sla 的三档 + 可注入的工作日历）', () => {
  it('常量与 KefuAgent 一致', () => {
    expect(SLA_WINDOW_MINUTES).toBe(1440)
    expect(SLA_REMINDER_MINUTES).toBe(720)
    expect(SLA_CRITICAL_MINUTES).toBe(240)
  })

  it('全天候日历：截止 = 锚点 + 1440 分钟，逐分钟等价', () => {
    expect(addWorkingMinutes(ANCHOR, SLA_WINDOW_MINUTES, ALWAYS_ON_CALENDAR)).toBe(
      '2026-09-08T01:00:00.000Z',
    )
  })

  it('三档：ok → reminder → critical → breached', () => {
    const at = (iso: string) => computeSla({ anchor_at: ANCHOR, now: iso }).tier
    expect(at('2026-09-07T02:00:00.000Z')).toBe('ok')
    expect(at('2026-09-07T14:00:00.000Z')).toBe('reminder')
    expect(at('2026-09-07T22:00:00.000Z')).toBe('critical')
    expect(at('2026-09-08T02:00:00.000Z')).toBe('breached')
  })

  it('回复晚于锚点 → 停表，并记下是否在时限内', () => {
    const stopped = computeSla({
      anchor_at: ANCHOR,
      now: '2026-09-09T00:00:00.000Z',
      last_outbound_at: '2026-09-07T03:00:00.000Z',
    })
    expect(stopped.stopped).toBe(true)
    expect(stopped.tier).toBe('ok')
    expect(stopped.responded_within_target).toBe(true)
    expect(stopped.first_response_remaining_minutes).toBe(1320)

    const late = computeSla({
      anchor_at: ANCHOR,
      now: '2026-09-09T00:00:00.000Z',
      last_outbound_at: '2026-09-09T00:00:00.000Z',
    })
    expect(late.responded_within_target).toBe(false)
    expect(late.first_response_breached).toBe(true)
  })

  it('回复早于锚点（上一轮的回信）不算停表', () => {
    const s = computeSla({
      anchor_at: ANCHOR,
      now: '2026-09-07T02:00:00.000Z',
      last_outbound_at: '2026-09-06T01:00:00.000Z',
    })
    expect(s.stopped).toBe(false)
  })

  it('解决时限按 resolved_at 算', () => {
    const s = computeSla({
      anchor_at: ANCHOR,
      now: '2026-09-20T00:00:00.000Z',
      resolved_at: '2026-09-08T01:00:00.000Z',
    })
    expect(s.resolution_breached).toBe(false)
    expect(s.resolution_due_at).toBe('2026-09-10T01:00:00.000Z')
    const unresolved = computeSla({ anchor_at: ANCHOR, now: '2026-09-20T00:00:00.000Z' })
    expect(unresolved.resolution_breached).toBe(true)
  })

  it('工作日历：周五下班后来的信，截止落到下周一', () => {
    // 2026-09-11 是周五；东八区 17:00 = UTC 09:00
    const friday = '2026-09-11T09:00:00.000Z'
    const due = addWorkingMinutes(friday, 120, DEFAULT_BUSINESS_CALENDAR)
    // 周五只剩 60 分钟（18:00 下班），余下 60 分钟落到周一 09:00 之后
    expect(due).toBe('2026-09-14T02:00:00.000Z')
  })

  it('工作日历：开工前来的信从开工那一刻起算', () => {
    // 东八区 06:00（UTC 前一天 22:00）
    const early = '2026-09-13T22:00:00.000Z'
    expect(addWorkingMinutes(early, 60, DEFAULT_BUSINESS_CALENDAR)).toBe('2026-09-14T02:00:00.000Z')
  })

  it('工作日历：假日整天跳过', () => {
    const cal = { ...DEFAULT_BUSINESS_CALENDAR, holidays: ['2026-09-14'] }
    // 周一 10:00（东八）落在假日 → 跳到周二
    expect(addWorkingMinutes('2026-09-14T02:00:00.000Z', 60, cal)).toBe('2026-09-15T02:00:00.000Z')
  })

  it('工作日历下的 computeSla 与全天候不同', () => {
    const business = computeSla({
      anchor_at: '2026-09-11T09:00:00.000Z',
      now: '2026-09-11T10:00:00.000Z',
      targets: { first_response_minutes: 120, resolution_minutes: 240 },
      calendar: DEFAULT_BUSINESS_CALENDAR,
    })
    expect(business.first_response_due_at).toBe('2026-09-14T02:00:00.000Z')
    expect(business.tier).toBe('ok')
  })

  it('投诉与高紧急度把首响压到 4 小时', () => {
    const complaint = classifyText({ text: 'this is a complaint about my order' }, { now: ANCHOR })
    expect(targetsFor(complaint).first_response_minutes).toBe(SLA_CRITICAL_MINUTES)
    const calm = classifyText({ text: 'where is my package for order #1' }, { now: ANCHOR })
    expect(targetsFor(calm)).toEqual(DEFAULT_SLA_TARGETS)
    expect(targetsFor(calm, { first_response_minutes: 60, resolution_minutes: 120 })).toEqual({
      first_response_minutes: 60,
      resolution_minutes: 120,
    })
    expect(targetsFor(complaint, { first_response_minutes: 60, resolution_minutes: 120 })).toEqual({
      first_response_minutes: 60,
      resolution_minutes: 120,
    })
  })

  it('分桶键与周期戳', () => {
    expect(responseDayKey('2026-09-07T23:30:00.000Z')).toBe('2026-09-07')
    expect(slaCycleStamp('2026-09-08T01:00:00.000Z')).toBe('2026-09-08 01:00 UTC')
    expect(daysBetween(ANCHOR, '2026-09-10T01:00:00.000Z')).toBe(3)
  })
})
