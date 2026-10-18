/** WP419（自查 U11）：Google 提醒卡上的查询语句说人话。 */
import { describe, expect, it } from 'vitest'
import { readableAlertQuery } from '@/components/pr/google-alert-change-body'

describe('WP419 提醒查询说人话', () => {
  it('引号去掉、招聘词合成「排除招聘」、别的排除词照写、OR 写成或', () => {
    expect(readableAlertQuery('"Aventon" -job -jobs')).toBe('Aventon（排除招聘）')
    expect(readableAlertQuery('"Rad Power Bikes" -used')).toBe('Rad Power Bikes（排除used）')
    expect(readableAlertQuery('"e-bike battery" OR "ebike battery"')).toBe(
      'e-bike battery 或 ebike battery',
    )
    expect(readableAlertQuery('Nordvolt')).toBe('Nordvolt')
  })
})
