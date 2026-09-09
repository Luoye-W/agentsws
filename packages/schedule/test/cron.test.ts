import { describe, expect, it } from 'vitest'
import {
  MINUTE_MS,
  nextCronAfter,
  parseCron,
  ScheduleError,
  tzOffsetMinutes,
  wallClock,
} from '../src/index.js'

const at = (iso: string): number => Date.parse(iso)
const iso = (ms: number): string => new Date(ms).toISOString()

describe('parseCron', () => {
  it('五段都认 `*`', () => {
    const c = parseCron('* * * * *')
    expect(c.minute.size).toBe(60)
    expect(c.hour.size).toBe(24)
    expect(c.day.size).toBe(31)
    expect(c.month.size).toBe(12)
    expect(c.dow.size).toBe(7)
    expect(c.dayRestricted).toBe(false)
    expect(c.dowRestricted).toBe(false)
  })

  it('认 `,` `-` `/`', () => {
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30])
    expect([...parseCron('0 9-11 * * *').hour]).toEqual([9, 10, 11])
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0 0-23/6 * * *').hour]).toEqual([0, 6, 12, 18])
  })

  it('`*/n` 也算「限制过」（日与周的并集判定要用）', () => {
    expect(parseCron('0 0 */2 * *').dayRestricted).toBe(true)
    expect(parseCron('0 0 * * */2').dowRestricted).toBe(true)
  })

  it.each([
    ['* * * *', '段数不对'],
    ['60 * * * *', '分越界'],
    ['0 24 * * *', '时越界'],
    ['0 0 0 * *', '日越界'],
    ['0 0 * 13 *', '月越界'],
    ['0 0 * * 7', '周越界'],
    ['5-1 * * * *', '区间反了'],
    ['0,, * * * *', '空项'],
    ['*/x * * * *', '步长不是数'],
    ['*/0 * * * *', '步长为零'],
    ['a * * * *', '不是数字'],
  ])('拒绝不合法的表达式：%s（%s）', (expr) => {
    expect(() => parseCron(expr)).toThrow(ScheduleError)
  })
})

describe('tzOffsetMinutes', () => {
  it('固定偏移', () => {
    const t = at('2026-09-10T00:00:00Z')
    expect(tzOffsetMinutes('+08:00', t)).toBe(480)
    expect(tzOffsetMinutes('+0800', t)).toBe(480)
    expect(tzOffsetMinutes('-05:30', t)).toBe(-330)
    expect(tzOffsetMinutes('UTC+8', t)).toBe(480)
    expect(tzOffsetMinutes('UTC-5:30', t)).toBe(-330)
    expect(tzOffsetMinutes('Z', t)).toBe(0)
    expect(tzOffsetMinutes('UTC', t)).toBe(0)
    expect(tzOffsetMinutes('', t)).toBe(0)
    expect(tzOffsetMinutes('GMT', t)).toBe(0)
  })

  it('IANA 名字按那一刻算（夏令时会变）', () => {
    expect(tzOffsetMinutes('Asia/Shanghai', at('2026-09-10T00:00:00Z'))).toBe(480)
    expect(tzOffsetMinutes('America/New_York', at('2026-01-10T00:00:00Z'))).toBe(-300)
    expect(tzOffsetMinutes('America/New_York', at('2026-07-10T00:00:00Z'))).toBe(-240)
  })

  it('认不出来就报 invalid_input，不默默按 UTC 跑', () => {
    expect(() => tzOffsetMinutes('Mars/Olympus', at('2026-09-10T00:00:00Z'))).toThrow(ScheduleError)
  })
})

describe('wallClock', () => {
  it('把 UTC 时刻换成某时区的墙上时间', () => {
    const w = wallClock(at('2026-09-10T00:30:00Z'), '+08:00')
    expect(w).toMatchObject({ year: 2026, month: 9, day: 10, hour: 8, minute: 30, offset: 480 })
    // 2026-09-10 是周四
    expect(w.dow).toBe(4)
  })
})

describe('nextCronAfter', () => {
  it('每天 08:00（东八区）落在 UTC 前一天 00:00', () => {
    // 从 UTC 前一天 23:00（= 东八区当天 07:00）出发，下一次就是当天 08:00 本地
    const next = nextCronAfter('0 8 * * *', at('2026-09-09T23:00:00Z'), '+08:00')
    expect(iso(next)).toBe('2026-09-10T00:00:00.000Z')
  })

  it('严格「之后」：正好站在触发点上，回的是下一次', () => {
    // 东八区当天 08:00 正好是 2026-09-10T00:00:00Z，所以下一次是明天
    const next = nextCronAfter('0 8 * * *', at('2026-09-10T00:00:00Z'), '+08:00')
    expect(iso(next)).toBe('2026-09-11T00:00:00.000Z')
  })

  it('每 15 分钟', () => {
    const next = nextCronAfter('*/15 * * * *', at('2026-09-10T09:07:00Z'), 'UTC')
    expect(iso(next)).toBe('2026-09-10T09:15:00.000Z')
  })

  it('每周一 06:00（东八区）', () => {
    // 2026-09-10 周四 → 下个周一是 09-14
    const next = nextCronAfter('0 6 * * 1', at('2026-09-10T00:00:00Z'), 'Asia/Shanghai')
    expect(wallClock(next, 'Asia/Shanghai')).toMatchObject({ month: 9, day: 14, hour: 6, dow: 1 })
  })

  it('跨月：只在 2 月跑的任务从 9 月要等到明年', () => {
    const next = nextCronAfter('0 0 1 2 *', at('2026-09-10T00:00:00Z'), 'UTC')
    expect(iso(next)).toBe('2027-02-01T00:00:00.000Z')
  })

  it('月末：每月最后一天 20:00 用 28-31 表达（不存在的日子自动跳过）', () => {
    const next = nextCronAfter('0 20 30,31 * *', at('2026-09-29T00:00:00Z'), 'UTC')
    expect(iso(next)).toBe('2026-09-30T20:00:00.000Z')
  })

  it('日与周都限制时取并集（标准 cron）', () => {
    // 每月 1 号或每周一
    const c = parseCron('0 0 1 * 1')
    const next = nextCronAfter(c, at('2026-09-10T00:00:00Z'), 'UTC')
    // 09-14 是周一，早于 10-01
    expect(iso(next)).toBe('2026-09-14T00:00:00.000Z')
  })

  it('秒级零头不影响：从 09:00:30 出发下一次还是 09:15', () => {
    const next = nextCronAfter('*/15 * * * *', at('2026-09-10T09:00:30Z'), 'UTC')
    expect(iso(next)).toBe('2026-09-10T09:15:00.000Z')
  })

  it('四年内不会触发的表达式直接报错', () => {
    // 2 月 30 日不存在
    expect(() => nextCronAfter('0 0 30 2 *', at('2026-09-10T00:00:00Z'), 'UTC')).toThrow(
      ScheduleError,
    )
  })

  it('夏令时切换那天照样往前走（纽约 3 月）', () => {
    const start = at('2026-03-07T12:00:00Z')
    let t = start
    const seen: string[] = []
    for (let i = 0; i < 4; i += 1) {
      t = nextCronAfter('0 2 * * *', t, 'America/New_York')
      seen.push(iso(t))
    }
    // 单调递增，且每次都往前跨了一天左右
    for (let i = 1; i < seen.length; i += 1) {
      const prev = seen[i - 1]
      const cur = seen[i]
      expect(prev).toBeDefined()
      expect(cur).toBeDefined()
      expect(Date.parse(String(cur)) - Date.parse(String(prev))).toBeGreaterThan(
        20 * 60 * MINUTE_MS,
      )
    }
  })
})
