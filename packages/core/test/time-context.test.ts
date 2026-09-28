/**
 * WP180：「现在时间 + 公司时区」那一条 ContextItem。
 *
 * - 公司时区认得出就用它，没有 / 认不出用本机时区（再不行 UTC）；
 * - 按小时取整（22 §2）：同一小时里两次运行字节相同，跨小时才变；
 * - 同一刻、同一时区 → 同一份字节（三个运行时拿到的就是这一份）。
 */
import { describe, expect, it } from 'vitest'
import {
  resolveTimeZone,
  TIME_CONTEXT_ID,
  timeContextItem,
  timeContextText,
} from '../src/time-context.js'

describe('WP180 现在时间 + 公司时区', () => {
  it('公司时区优先；空的 / 认不出的退回本机时区', () => {
    expect(resolveTimeZone('Asia/Shanghai', 'Europe/Berlin')).toEqual({
      zone: 'Asia/Shanghai',
      source: 'company',
    })
    expect(resolveTimeZone('', 'Europe/Berlin')).toEqual({ zone: 'Europe/Berlin', source: 'host' })
    expect(resolveTimeZone('Mars/Olympus', 'Europe/Berlin').zone).toBe('Europe/Berlin')
    expect(resolveTimeZone(undefined, 'nope/nope').zone).toBe('UTC')
  })

  it('写成公司时区的当地日期、星期、整点和 UTC 偏移', () => {
    // 2026-09-29T06:37:12Z = 上海 14:37（周二）
    expect(timeContextText({ now: '2026-09-29T06:37:12.000Z', zone: 'Asia/Shanghai' })).toBe(
      '现在是 2026-09-29（周二）14:00 前后，公司时区 Asia/Shanghai（UTC+08:00）。没写时区的日期和时间都按这个时区理解。',
    )
    // 同一刻在洛杉矶还是前一天（夏令时 -07:00）
    expect(
      timeContextText({ now: '2026-09-29T06:37:12.000Z', zone: 'America/Los_Angeles' }),
    ).toContain('2026-09-28（周一）23:00 前后，公司时区 America/Los_Angeles（UTC-07:00）')
    expect(timeContextText({ now: '2026-01-01T00:10:00.000Z', zone: 'UTC' })).toContain(
      '（UTC+00:00）',
    )
  })

  it('按小时取整：同一小时里字节相同，跨小时才变；一次运行一条', () => {
    const a = timeContextItem({ now: '2026-09-29T06:01:00.000Z', companyTz: 'Asia/Shanghai' })
    const b = timeContextItem({ now: '2026-09-29T06:59:59.000Z', companyTz: 'Asia/Shanghai' })
    const c = timeContextItem({ now: '2026-09-29T07:00:00.000Z', companyTz: 'Asia/Shanghai' })
    expect(a).toEqual(b)
    expect(a.content).not.toEqual(c.content)
    expect(a).toMatchObject({ id: TIME_CONTEXT_ID, kind: 'time', sensitivity: 'internal' })
    expect(a.bytes).toBe(new TextEncoder().encode(String(a.content)).byteLength)
  })

  it('没有公司时区时用本机时区（测试里注入）', () => {
    const item = timeContextItem({ now: '2026-09-29T06:37:12.000Z', hostTz: 'Europe/Berlin' })
    expect(item.content).toContain('公司时区 Europe/Berlin（UTC+02:00）')
  })
})
