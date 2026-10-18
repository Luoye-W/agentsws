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

describe('WP388 取数窗口：到出报告前一天为止最近完整的 7 天（决策 1091）', () => {
  it('北京周一 16:30 = 美西周一凌晨：取美西上周一到周日', () => {
    const w = reportWeek('2026-10-19T08:30:00Z', 'America/Los_Angeles')
    expect(w).toMatchObject({
      from_date: '2026-10-12',
      to_date: '2026-10-18',
      mon_to_sun: true,
      start: '2026-10-12T07:00:00.000Z',
      end: '2026-10-19T07:00:00.000Z',
      offset_minutes: -420,
    })
  })

  it('旧默认北京周一 08:00 时美西还是周日：最近完整的 7 天是上周日到本周六（所以改到 16:30）', () => {
    const w = reportWeek('2026-10-19T00:00:00Z', 'America/Los_Angeles')
    expect(w).toMatchObject({ from_date: '2026-10-11', to_date: '2026-10-17', mon_to_sun: false })
  })

  it('跨夏令时结束（美西 11-01）：那 7 天 169 小时，两头各按当时的偏移', () => {
    const w = reportWeek('2026-11-02T08:30:00Z', 'America/Los_Angeles')
    expect(w.start).toBe('2026-10-26T07:00:00.000Z')
    expect(w.end).toBe('2026-11-02T08:00:00.000Z')
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(169 * 3_600_000)
    expect(w.offset_minutes).toBe(-480)
  })

  it('跨夏令时开始（美西 03-08）：那 7 天 167 小时', () => {
    const w = reportWeek('2026-03-09T08:30:00Z', 'America/Los_Angeles')
    expect(w.start).toBe('2026-03-02T08:00:00.000Z')
    expect(w.end).toBe('2026-03-09T07:00:00.000Z')
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(167 * 3_600_000)
  })

  it('跨时区：同一刻，北京 / 伦敦 / 美西各按自己的日界线', () => {
    const at = '2026-10-19T08:30:00Z'
    expect(reportWeek(at, '+08:00').start).toBe('2026-10-11T16:00:00.000Z')
    expect(reportWeek(at, 'Europe/London').start).toBe('2026-10-11T23:00:00.000Z')
    expect(reportWeek(at, 'America/Los_Angeles').start).toBe('2026-10-12T07:00:00.000Z')
  })

  it('改到周五出（甲方要周五交）：上周五到本周四，不按星期几分段', () => {
    const w = reportWeek('2026-10-23T09:00:00Z', 'America/Los_Angeles')
    expect(w).toMatchObject({
      from_date: '2026-10-16',
      to_date: '2026-10-22',
      mon_to_sun: false,
      start: '2026-10-16T07:00:00.000Z',
      end: '2026-10-23T07:00:00.000Z',
    })
    // 周三、周四出同一条规则
    expect(reportWeek('2026-10-21T12:00:00Z', '+08:00').from_date).toBe('2026-10-14')
    expect(reportWeek('2026-10-22T12:00:00Z', '+08:00').from_date).toBe('2026-10-15')
  })
})
