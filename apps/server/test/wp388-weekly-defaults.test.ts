/**
 * WP388（docs/103 S2 / S3 / T2）：系统自带的三份周报——岗位周复盘、经营一页纸、SEO 周报——默认都是
 * 每周一 16:30（工作区时区）；还停在旧默认时间上的换成新默认，用户改过的照用户的。
 */
import { createScheduler, type Scheduler } from '@agentsws/schedule'
import { describe, expect, it } from 'vitest'
import {
  ensureSystemTasks,
  LEGACY_WEEKLY_CRONS,
  REVIEW_WEEK_TITLE,
  SEO_WEEKLY_TITLE,
  WEEKLY_REVIEW_TITLE,
} from '../src/schedule.js'

const T0 = '2026-10-18T00:00:00.000Z'
const IDS = ['sched_review_week_asg_1', 'sched_weekly_review', 'sched_seo_weekly'] as const

const ensure = (scheduler: Scheduler, tz = '+08:00') =>
  ensureSystemTasks(scheduler, {
    workspace_id: 'ws_1',
    owner: 'p_1',
    role_id: 'common.owner',
    assignment_id: 'asg_1',
    tz,
    positions: [{ assignment_id: 'asg_1', person_id: 'p_1', role_id: 'common.owner' }],
    has: { work: true, seo: true, weeklyReview: true },
  })

const cronOf = (s: Scheduler, id: string) => {
  const t = s.get(id)?.trigger
  return t?.kind === 'cron' ? { expr: t.expr, tz: t.tz } : undefined
}

describe('WP388 三份周报默认周一 16:30', () => {
  it('新建的：三条都是 30 16 * * 1、工作区时区；标题不写几点', async () => {
    const s = createScheduler({ clock: { now: () => T0 } })
    await ensure(s, 'Asia/Shanghai')
    for (const id of IDS)
      expect(cronOf(s, id)).toEqual({ expr: '30 16 * * 1', tz: 'Asia/Shanghai' })
    expect(s.get('sched_review_week_asg_1')?.title).toBe(REVIEW_WEEK_TITLE)
    expect(s.get('sched_weekly_review')?.title).toBe(WEEKLY_REVIEW_TITLE)
    expect(s.get('sched_seo_weekly')?.title).toBe(SEO_WEEKLY_TITLE)
    // 北京时间下一次：周一 2026-10-19 16:30 = 08:30Z
    expect(s.get('sched_weekly_review')?.next_fire_at).toBe('2026-10-19T08:30:00.000Z')
  })

  it('还停在旧默认上的换成新默认（时区照旧）；用户改过的、停着的照用户的', async () => {
    const s = createScheduler({ clock: { now: () => T0 } })
    const old = (id: string, expr: string, title: string) =>
      s.schedule({
        id,
        workspace_id: 'ws_1',
        owner: 'p_1',
        role_id: 'common.owner',
        assignment_id: 'asg_1',
        created_by: 'user',
        misfire_policy: 'skip',
        title,
        handler: 'x',
        trigger: { kind: 'cron', expr, tz: '-05:00' },
      })
    await old(
      'sched_review_week_asg_1',
      LEGACY_WEEKLY_CRONS.review_week[0] ?? '',
      '周五加一次周复盘',
    )
    await old('sched_seo_weekly', LEGACY_WEEKLY_CRONS.seo_weekly[0] ?? '', '每周一看一眼')
    // 用户把一页纸改到了周五 17:00（甲方要周五交）
    await old('sched_weekly_review', '0 17 * * 5', '每周一早上推一份本周经营一页纸')
    await s.pause('sched_seo_weekly')

    await ensure(s)
    expect(cronOf(s, 'sched_review_week_asg_1')).toEqual({ expr: '30 16 * * 1', tz: '-05:00' })
    expect(s.get('sched_review_week_asg_1')?.title).toBe(REVIEW_WEEK_TITLE)
    // 停着的只换时间，照样停着
    expect(cronOf(s, 'sched_seo_weekly')).toEqual({ expr: '30 16 * * 1', tz: '-05:00' })
    expect(s.get('sched_seo_weekly')?.state).toBe('paused')
    // 改过的不动
    expect(cronOf(s, 'sched_weekly_review')).toEqual({ expr: '0 17 * * 5', tz: '-05:00' })

    // 再起一次：已经是新默认 / 用户的，什么都不变
    await ensure(s)
    expect(cronOf(s, 'sched_weekly_review')?.expr).toBe('0 17 * * 5')
    expect(cronOf(s, 'sched_review_week_asg_1')?.expr).toBe('30 16 * * 1')
  })
})
