/**
 * WP181：已有的系统巡检（每日 SEO 08:00、开发信 09:00、每周报告……）要不要迁到官方「自动化任务」的机制上——
 * **判断的证据**（结论与理由写在 `docs/briefs/reports/WP181.md` §2）。
 *
 * 官方机制能接住的只有「下一次什么时候」那一段算术（官方的 Host 服务、存储、投递都挂不进来，见报告）。
 * 这里把**改前的金样**钉住：每一条系统 cron 巡检，从同一刻起往后连着排 40 次，我们的算法与官方的算法
 * 在我们实际用的公司时区写法下**逐个时刻相等**——所以现在不迁、以后要迁也是零漂移；
 * 哪天两边不等了（任何一边改了算法），这里先红，再决定。
 */
import { officialRuleResolver, officialZone } from '@agentsws/dsh-adapter/official-schedule'
import { createScheduler, nextCronAfter } from '@agentsws/schedule'
import { describe, expect, it } from 'vitest'
import { ensureSystemTasks } from '../src/schedule.js'

const T0 = '2026-09-29T00:00:00.000Z'

async function systemCrons(): Promise<{ id: string; expr: string }[]> {
  const clock = { now: () => T0 }
  const scheduler = createScheduler({ clock })
  const all = Object.fromEntries(
    [
      'work',
      'meetings',
      'idempotency',
      'shopify',
      'skills',
      'learning',
      'approvals',
      'mail',
      'raw',
      'backup',
      'pricing',
      'orgDuplicates',
      'kol',
      'b2b',
      'pr',
      'social',
      'seo',
      // WP224：每周一页纸、两条止损线对照
      'weeklyReview',
      'adsLineCompare',
    ].map((k) => [k, true]),
  )
  const tasks = await ensureSystemTasks(scheduler, {
    workspace_id: 'ws_1',
    owner: 'p_1',
    role_id: 'common.owner',
    assignment_id: 'asg_1',
    tz: '+08:00',
    positions: [{ assignment_id: 'asg_1', person_id: 'p_1', role_id: 'common.owner' }],
    has: all,
  })
  return tasks.flatMap((t) =>
    t.trigger.kind === 'cron' ? [{ id: t.id, expr: t.trigger.expr }] : [],
  )
}

/** 从 T0 起往后连着排 n 次。 */
function ours(expr: string, tz: string, n: number): string[] {
  const out: string[] = []
  let at = Date.parse(T0)
  for (let i = 0; i < n; i += 1) {
    at = nextCronAfter(expr, at, tz)
    out.push(new Date(at).toISOString())
  }
  return out
}

function official(expr: string, tz: string, n: number): string[] {
  const out: string[] = []
  let at = Date.parse(T0)
  for (let i = 0; i < n; i += 1) {
    // 官方 `createCronScheduleRecord` 的「严格晚于这一刻的下一次」（经我们接官方的那一层）
    const next = officialRuleResolver.next(
      { kind: 'cron', expression: expr, timeZone: officialZone(tz) },
      at,
    )
    if (next === undefined) throw new Error(`官方算不出：${expr} @ ${tz}`)
    out.push(next)
    at = Date.parse(next)
  }
  return out
}

describe('系统巡检：两边的时间算法（金样）', () => {
  it('巡检里的 cron 一条不少（改之前录下来的清单）', async () => {
    const crons = await systemCrons()
    expect(crons.map((c) => `${c.id} ${c.expr}`).sort()).toEqual([
      'sched_ads_line_compare 30 23 * * *',
      'sched_b2b_sequence 0 9 * * *',
      'sched_backup 0 4 * * *',
      'sched_daily_plan_asg_1 0 8 * * *',
      'sched_idempotency_sweep 0 * * * *',
      'sched_idle_todos 0 9 * * *',
      'sched_kol_sequence 0 9 * * *',
      'sched_learning_daily 30 7 * * *',
      'sched_org_duplicates 30 3 * * *',
      'sched_pricing_refresh 0 5 * * 1',
      'sched_raw_prune 0 3 * * *',
      'sched_review_day_asg_1 0 20 * * *',
      'sched_review_month_asg_1 45 20 28-31 * *',
      'sched_review_week_asg_1 30 20 * * 5',
      'sched_seo_daily 0 8 * * *',
      'sched_seo_weekly 30 8 * * 1',
      'sched_skills_weekly 0 6 * * 1',
      'sched_weekly_review 0 8 * * 1',
    ])
  })

  for (const tz of [
    '+08:00',
    '+00:00',
    '-05:00',
    'Asia/Shanghai',
    'America/New_York',
    'Europe/Berlin',
  ]) {
    it(`公司时区 ${tz}：每一条往后 40 次，逐个时刻相等`, async () => {
      for (const { id, expr } of await systemCrons()) {
        expect(official(expr, tz, 40), `${id} ${expr}`).toEqual(ours(expr, tz, 40))
      }
      // WP224 多了两条 cron（一页纸 / 止损线对照），IANA 时区那几组本机单跑就要 4 秒多，
      // 默认 5 秒在并行负载下会超时——放宽到 30 秒（算的东西没变）
    }, 30_000)
  }
})
