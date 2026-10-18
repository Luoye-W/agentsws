/** WP419（自查 S9 / U4）：窄栏里的内容日历只放一行摘要。 */
import { describe, expect, it } from 'vitest'
import { calendarSummaryLine } from '@/components/social/social-calendar-summary'

const t = (k: string, v?: Record<string, string | number>) =>
  k === 'social.summary.next' ? `这两周 ${v?.n} 条 · 下一条 ${v?.when}` : `这两周 ${v?.n} 条`

describe('WP419 内容日历摘要', () => {
  it('只数这条渠道；下一条是最早的还没发的', () => {
    const now = new Date('2026-10-19T02:00:00.000Z')
    const line = calendarSummaryLine(
      [
        { channel: 'instagram', scheduled_at: '2026-10-21T01:00:00.000Z', status: 'scheduled' },
        { channel: 'instagram', scheduled_at: '2026-10-20T01:00:00.000Z', status: 'scheduled' },
        { channel: 'instagram', scheduled_at: '2026-10-18T01:00:00.000Z', status: 'published' },
        { channel: 'facebook', scheduled_at: '2026-10-19T05:00:00.000Z', status: 'scheduled' },
      ],
      'instagram',
      now,
      t,
      'zh',
    )
    expect(line.startsWith('这两周 3 条 · 下一条 ')).toBe(true)
    expect(calendarSummaryLine([], 'x', now, t, 'zh')).toBe('这两周 0 条')
  })
})
