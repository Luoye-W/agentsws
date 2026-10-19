/**
 * WP416（自查 kol U11）：岗位设置 · 定时任务——五条职责各一条的同一件事合成一行，时间说人话。
 */
import { describe, expect, it } from 'vitest'
import { groupSchedules } from '@/components/position/position-settings'
import type { ScheduledTaskRow } from '@/lib/api'

const row = (id: string, title: string, expr: string, role_id: string): ScheduledTaskRow => ({
  id,
  title,
  trigger: { kind: 'cron', expr, tz: '+08:00' },
  state: 'active',
  fire_count: 0,
  role_id,
})

describe('WP416 定时任务按职责合并', () => {
  it('同名同点的五条合成一组；不同的点分开；时间不露 cron', () => {
    const roles = ['kol.youtube', 'kol.instagram', 'kol.tiktok', 'kol.facebook', 'kol.x']
    const rows = [
      ...roles.map((r, i) => ({
        row: row(`a${i}`, '每天早上拟一版今天的安排', '0 8 * * *', r),
        assignment: `as_${i}`,
      })),
      ...roles.map((r, i) => ({
        row: row(`b${i}`, '晚上做一次复盘', '0 20 * * *', r),
        assignment: `as_${i}`,
      })),
      {
        row: row('c', '每天看一眼哪几封开发信该跟进了', '0 9 * * *', 'common.owner'),
        assignment: 'as_0',
      },
    ]
    const groups = groupSchedules(rows, 'zh')
    expect(groups).toHaveLength(3)
    expect(groups[0]?.items).toHaveLength(5)
    expect(groups[0]?.when).toBe('每天 08:00')
    expect(groups[2]?.when).toBe('每天 09:00')
    expect(groups.map((g) => g.when).join(' ')).not.toContain('cron')
  })
})
