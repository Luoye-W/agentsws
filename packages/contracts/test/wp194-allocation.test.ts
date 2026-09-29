/** WP194：归属头的洗法与公司时区换算。 */
import { describe, expect, it } from 'vitest'
import {
  allocationBucketOf,
  allocationTimezoneOf,
  attributionFromHeaders,
  attributionHeaders,
} from '../src/index.js'

describe('WP194 契约小工具', () => {
  it('公司时区：IANA 原样，偏移换成 Etc/GMT∓h 或常见半点时区，认不出回 undefined', () => {
    expect(allocationTimezoneOf('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(allocationTimezoneOf('+08:00')).toBe('Etc/GMT-8')
    expect(allocationTimezoneOf('UTC+8')).toBe('Etc/GMT-8')
    expect(allocationTimezoneOf('-05:00')).toBe('Etc/GMT+5')
    expect(allocationTimezoneOf('+00:00')).toBe('UTC')
    expect(allocationTimezoneOf('+05:30')).toBe('Asia/Kolkata')
    expect(allocationTimezoneOf('+07:20')).toBeUndefined()
    expect(allocationTimezoneOf('北京时间')).toBeUndefined()
    expect(allocationTimezoneOf(undefined)).toBeUndefined()
    // 换出来的名字 Intl 认得
    for (const tz of ['Etc/GMT-8', 'Etc/GMT+5', 'Asia/Kolkata'])
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
  })

  it('归属头：不合法的当没带；能力四格', () => {
    const h = attributionHeaders({ member_id: 'p_a', position_id: 'bad id' })
    expect(h).toEqual({ 'X-Agentsws-Member': 'p_a' })
    expect(attributionFromHeaders((n) => ({ 'X-Agentsws-Position': 'cs' })[n])).toEqual({
      position_id: 'cs',
    })
    expect(
      ['ai.chat', 'data.kol.lookup', 'task.apify', 'kol.service.monthly'].map(allocationBucketOf),
    ).toEqual(['ai', 'data', 'task', 'other'])
  })
})
