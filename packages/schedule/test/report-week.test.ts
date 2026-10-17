import { describe, expect, it } from 'vitest'
import {
  marketTimeZone,
  nextCronAfter,
  reportTimeZone,
  reportWeek,
  WEEKLY_REPORT_CRON,
  WEEKLY_REPORT_DEFAULT,
} from '../src/index.js'

describe('WP388 周报默认：每周一 16:30（工作区时区）', () => {
  it('cron 是周一 16:30；北京时间下一次是周一 08:30Z', () => {
    expect(WEEKLY_REPORT_CRON).toBe('30 16 * * 1')
    expect(WEEKLY_REPORT_DEFAULT).toEqual({ weekday: 1, time: '16:30' })
    // 2026-10-18 是周日
    const next = nextCronAfter(WEEKLY_REPORT_CRON, Date.parse('2026-10-18T00:00:00Z'), '+08:00')
    expect(new Date(next).toISOString()).toBe('2026-10-19T08:30:00.000Z')
    const sh = nextCronAfter(
      WEEKLY_REPORT_CRON,
      Date.parse('2026-10-18T00:00:00Z'),
      'Asia/Shanghai',
    )
    expect(sh).toBe(next)
  })
})

describe('WP388 目标市场 → 取数时区', () => {
  it('美国按美西；一个时区的国家照 Intl；认不出回 undefined', () => {
    expect(marketTimeZone('US')).toBe('America/Los_Angeles')
    expect(marketTimeZone('us')).toBe('America/Los_Angeles')
    expect(marketTimeZone('FR')).toBe('Europe/Paris')
    expect(marketTimeZone('ZZ')).toBeUndefined()
    expect(marketTimeZone(undefined)).toBeUndefined()
  })

  it('取第一个认得出的市场；没设目标市场用工作区时区', () => {
    expect(reportTimeZone(['ZZ', 'GB', 'US'], '+08:00')).toBe('Europe/London')
    expect(reportTimeZone([], '+08:00')).toBe('+08:00')
    expect(reportTimeZone(undefined, 'Asia/Shanghai')).toBe('Asia/Shanghai')
  })
})

describe('WP388 上一周的窗口', () => {
  it('北京周一 16:30 = 美西周一凌晨：取美西上一周整周（周一 00:00 到周日 24:00）', () => {
    const w = reportWeek('2026-10-19T08:30:00Z', 'America/Los_Angeles')
    expect(w).toMatchObject({
      kind: 'last_week',
      monday: '2026-10-12',
      sunday: '2026-10-18',
      start: '2026-10-12T07:00:00.000Z',
      end: '2026-10-19T07:00:00.000Z',
      offset_minutes: -420,
    })
  })

  it('旧默认北京周一 08:00 时美西还是周日：上一周还没过完（所以改到 16:30）', () => {
    const w = reportWeek('2026-10-19T00:00:00Z', 'America/Los_Angeles')
    expect(w.kind).toBe('this_week')
    expect(w.monday).toBe('2026-10-12')
  })

  it('跨夏令时结束（美西 11-01）：那一周 169 小时，两头各按当时的偏移', () => {
    const w = reportWeek('2026-11-02T08:30:00Z', 'America/Los_Angeles')
    expect(w.kind).toBe('last_week')
    expect(w.start).toBe('2026-10-26T07:00:00.000Z')
    expect(w.end).toBe('2026-11-02T08:00:00.000Z')
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(169 * 3_600_000)
    expect(w.offset_minutes).toBe(-480)
  })

  it('跨夏令时开始（美西 03-08）：那一周 167 小时', () => {
    const w = reportWeek('2026-03-09T08:30:00Z', 'America/Los_Angeles')
    expect(w.start).toBe('2026-03-02T08:00:00.000Z')
    expect(w.end).toBe('2026-03-09T07:00:00.000Z')
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(167 * 3_600_000)
  })

  it('跨时区：同一刻，北京 / 伦敦 / 美西各按自己的周一 00:00', () => {
    const at = '2026-10-19T08:30:00Z'
    expect(reportWeek(at, '+08:00').start).toBe('2026-10-11T16:00:00.000Z')
    expect(reportWeek(at, 'Europe/London').start).toBe('2026-10-11T23:00:00.000Z')
    expect(reportWeek(at, 'America/Los_Angeles').start).toBe('2026-10-12T07:00:00.000Z')
  })

  it('改到周五出（甲方要周五交）：取这一周到现在，不是上一周', () => {
    const now = '2026-10-23T09:00:00Z'
    const w = reportWeek(now, 'America/Los_Angeles')
    expect(w.kind).toBe('this_week')
    expect(w.monday).toBe('2026-10-19')
    expect(w.start).toBe('2026-10-19T07:00:00.000Z')
    expect(w.end).toBe('2026-10-23T09:00:00.000Z')
  })

  it('周三还算上一周，周四起算这一周', () => {
    expect(reportWeek('2026-10-21T12:00:00Z', '+08:00').kind).toBe('last_week')
    expect(reportWeek('2026-10-22T12:00:00Z', '+08:00').kind).toBe('this_week')
  })
})
