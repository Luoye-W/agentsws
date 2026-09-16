import type { SocialPost } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  contentCalendar,
  copyKey,
  localDayKey,
  nextFreeSlot,
  scheduleConflicts,
  weekStart,
} from '../src/index.js'

const now = '2026-09-16T02:00:00.000Z'
/** 东八区：日界线按它切（`localDayKey` 的那一刀）。 */
const TZ = 480

const post = (over: Partial<SocialPost> & { id: string }): SocialPost => ({
  account_id: 'sa_meta',
  channel: 'meta',
  kind: 'post',
  status: 'scheduled',
  body: '正文',
  ...over,
})

describe('56 §3 内容日历（WP72）', () => {
  it('周一零点切周（周日回退 6 天，不是 0 天）', () => {
    // 2026-09-16 是周三；北京时间那一周从 09-14 00:00 +08 = 09-13T16:00Z 开始
    expect(weekStart(now, TZ)).toBe('2026-09-13T16:00:00.000Z')
    // 周日（2026-09-20 +08）仍然归到同一周
    expect(weekStart('2026-09-20T10:00:00.000Z', TZ)).toBe('2026-09-13T16:00:00.000Z')
  })

  it('本周 / 下周各一格；草稿不进日历（它还没有时间）', () => {
    const cal = contentCalendar(
      [
        post({ id: 'p1', scheduled_at: '2026-09-17T01:00:00.000Z' }),
        post({ id: 'p2', scheduled_at: '2026-09-22T01:00:00.000Z' }),
        post({ id: 'p3', status: 'draft' }),
        post({ id: 'p4', scheduled_at: '2026-10-30T01:00:00.000Z' }),
      ],
      { now, tz_offset_minutes: TZ },
    )
    expect(cal.this_week.entries.map((e) => e.post_id)).toEqual(['p1'])
    expect(cal.next_week.entries.map((e) => e.post_id)).toEqual(['p2'])
  })

  it('日历按时间正序，正文只留前 60 字', () => {
    const cal = contentCalendar(
      [
        post({ id: 'late', scheduled_at: '2026-09-17T09:00:00.000Z', body: 'x'.repeat(100) }),
        post({ id: 'early', scheduled_at: '2026-09-17T01:00:00.000Z' }),
      ],
      { now, tz_offset_minutes: TZ },
    )
    expect(cal.this_week.entries.map((e) => e.post_id)).toEqual(['early', 'late'])
    expect(cal.this_week.entries[1]?.preview).toHaveLength(60)
  })

  it('同一个号 90 分钟内两条 = 撞车（平台会把后一条压下去）', () => {
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-17T01:30:00.000Z', body: '新文案' },
      [post({ id: 'p1', scheduled_at: '2026-09-17T01:00:00.000Z' })],
      { now, tz_offset_minutes: TZ },
    )
    expect(hits[0]?.kind).toBe('too_close')
    expect(hits[0]?.severity).toBe('conflict')
    expect(hits[0]?.with_post_ids).toEqual(['p1'])
  })

  it('隔够了就不撞', () => {
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-17T03:00:00.000Z', body: '新文案' },
      [post({ id: 'p1', scheduled_at: '2026-09-17T01:00:00.000Z' })],
      { now, tz_offset_minutes: TZ },
    )
    expect(hits).toEqual([])
  })

  it('一天第四条 = 超日额（与 guardrail 的 max_posts_per_day 同一个数）', () => {
    const existing = ['01:00', '04:00', '07:00'].map((t, i) =>
      post({ id: `p${i}`, scheduled_at: `2026-09-17T${t}:00.000Z` }),
    )
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-17T11:00:00.000Z', body: '第四条' },
      existing,
      { now, tz_offset_minutes: TZ },
    )
    expect(hits.map((h) => h.kind)).toContain('over_daily_cap')
  })

  it('日界线按时区切：北京时间的第二天不该算进今天的额度', () => {
    // 09-17T17:00Z = 北京 09-18 01:00，属于第二天
    expect(localDayKey('2026-09-17T17:00:00.000Z', TZ)).toBe('2026-09-18')
    const existing = ['01:00', '04:00', '07:00'].map((t, i) =>
      post({ id: `p${i}`, scheduled_at: `2026-09-17T${t}:00.000Z` }),
    )
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-17T17:00:00.000Z', body: '明天第一条' },
      existing,
      { now, tz_offset_minutes: TZ },
    )
    expect(hits.map((h) => h.kind)).not.toContain('over_daily_cap')
  })

  it('跨号同文案只是提醒，不拦——一稿多投是常事', () => {
    const hits = scheduleConflicts(
      { account_id: 'sa_x', scheduled_at: '2026-09-17T01:00:00.000Z', body: ' 同  一段 文案 ' },
      [
        post({
          id: 'p1',
          account_id: 'sa_meta',
          scheduled_at: '2026-09-17T01:00:00.000Z',
          body: '同 一段 文案',
        }),
      ],
      { now, tz_offset_minutes: TZ },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('same_copy_across_accounts')
    expect(hits[0]?.severity).toBe('notice')
    expect(copyKey(' 同  一段 文案 ')).toBe('同 一段 文案')
  })

  it('排在过去 = 撞车（它到点之后不会再触发）；排序把要改的那条放最前', () => {
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-01T01:00:00.000Z', body: '迟到的' },
      [],
      { now, tz_offset_minutes: TZ },
    )
    expect(hits[0]?.kind).toBe('in_the_past')
  })

  it('失败 / 草稿的那些不占位置', () => {
    const hits = scheduleConflicts(
      { account_id: 'sa_meta', scheduled_at: '2026-09-17T01:10:00.000Z', body: '新文案' },
      [post({ id: 'p1', status: 'failed', scheduled_at: '2026-09-17T01:00:00.000Z' })],
      { now, tz_offset_minutes: TZ },
    )
    expect(hits).toEqual([])
  })

  it('撞了要给得出下一个空档；排满了就说排不下（不硬塞一个）', () => {
    const existing = [post({ id: 'p1', scheduled_at: '2026-09-17T01:00:00.000Z' })]
    const slot = nextFreeSlot({ account_id: 'sa_meta', body: '新文案' }, existing, {
      now,
      from: '2026-09-17T01:00:00.000Z',
      tz_offset_minutes: TZ,
    })
    expect(slot).toBe('2026-09-17T02:30:00.000Z')

    // 一天排满三条，且只往后看 6 小时 → 找不到
    const full = ['01:00', '03:00', '05:00'].map((t, i) =>
      post({ id: `f${i}`, scheduled_at: `2026-09-17T${t}:00.000Z` }),
    )
    const none = nextFreeSlot({ account_id: 'sa_meta', body: '第四条' }, full, {
      now,
      from: '2026-09-17T01:00:00.000Z',
      tz_offset_minutes: TZ,
      horizon_hours: 6,
    })
    expect(none).toBeUndefined()
  })
})
