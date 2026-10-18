/**
 * WP331（决策 691，Luoye 10-15）验收：**周报是工坊被几句话配出来的，不是固定功能**。
 *
 * 真服务进程 + stub 运行时（脚本化工具调用，见 `@agentsws/stand-ins` 的 `report-playbook.ts`）+ 替身巡查数据：
 *
 * 1. 「每周五下午 5 点给我出一份 r/ivraxr 周报，数据周日到周五：①…②…③…④…」→ AI 用官方自动化任务建一条
 *    每周五 17:00 的定时（提示词 = 这段要求）；
 * 2. 到点 → 先立即巡查 → 查巡查数据 / 查发出记录 → 发布报告（四节按要求的顺序、带原文链接与我们的回复链接）；
 * 3. 「把第三节放最前面」→ AI 改那条定时的提示词（同一条，没新建）；
 * 4. 再到点 → 同一周期的同一份出第 2 版，外部那节到了最前面。
 *
 * 用例在 `evals/report-as-capability/weekly-report.json`，真模型跑同一份（`scripts/eval-report-capability.mjs --live`）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOT_A_CARD } from '@agentsws/deck'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error 评测台是纯 JS（.mjs），给 node 脚本与 vitest 共用
import { runReportCase } from '../../../evals/report-as-capability/harness.mjs'
import { createServer } from '../src/index.js'

vi.setConfig({ testTimeout: 120_000 })

const CASE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../evals/report-as-capability/weekly-report.json'),
    'utf8',
  ),
)

interface Check {
  turn: number
  name: string
  pass: boolean
  detail: string
}
interface Turn {
  tools: string[]
  answers: string[]
  notes: string[]
  report?: { title: string; version: number; sections: string[]; markdown: string }
  schedule: { id: string; prompt: string; rule: Record<string, unknown> }[]
}

describe('WP331 一句话配出周报、再一句话改格式（stub 运行时）', () => {
  it('建定时 → 到点出报告 → 改说明 → 下一份顺序变了', async () => {
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    const out = (await runReportCase(CASE, {
      createServer: async (o: Parameters<typeof createServer>[0]) => {
        server = await createServer(o)
        return server
      },
    })) as { pass: boolean; checks: Check[]; transcript: Turn[] }
    const failed = out.checks.filter((c) => !c.pass)
    expect(failed).toEqual([])
    expect(out.pass).toBe(true)
    const [t1, t2, t3, t4] = out.transcript as [Turn, Turn, Turn, Turn]

    // ① 建的是官方「自动化任务」：每周五 17:00（公司时区），提示词就是用户的要求
    expect(t1.tools).toEqual(['schedule_create'])
    expect(t1.schedule[0]?.rule).toMatchObject({ kind: 'weekly', weekdays: [5] })
    expect(t1.schedule[0]?.prompt).toContain('③外部舆情按话题归组带判断和原文链接')
    expect(t1.notes).toEqual([]) // 只读的周期任务不出卡（现有规则）

    // ② 到点：先巡查 → 取数 → 发布；周日到周五的窗口、上周的不进来
    expect(t2.tools).toEqual([
      'run_watch_now',
      'query_watch_items',
      'query_watch_items',
      'query_watch_items',
      'query_sent_records',
      'publish_report',
    ])
    expect(t2.report?.title).toBe('r/ivraxr 周报（10/11 – 10/16）')
    expect(t2.report?.markdown).toContain('- 帖子 **3** · 评论 **4**')
    expect(t2.report?.markdown).toContain('和 XREAL 对比（post × 1 / comment × 1）')
    expect(t2.report?.markdown).toContain('评估：需跟进')
    expect(t2.report?.markdown).toContain('- 回复帖子 **1** · 回复评论 **1**')

    // ③ 改的是那条定时的说明（同一条），第三项挪到最前、重新编号
    expect(t3.tools).toEqual(['schedule_list', 'schedule_update'])
    expect(t3.schedule[0]?.id).toBe(t1.schedule[0]?.id)
    expect(t3.schedule[0]?.prompt).toContain(
      '①外部舆情按话题归组带判断和原文链接 ②帖子数评论数 ③有效 VOC / UGC ④我们本周回复数和链接',
    )

    // ④ 同一周期再发 = 同一份的第 2 版，外部那节在最前面
    expect(t4.report?.version).toBe(2)
    expect(t4.report?.sections).toEqual(['external', 'own_counts', 'voc_ugc', 'replies'])
    expect(t4.report?.markdown.indexOf('## 1. 外部舆情')).toBeGreaterThan(0)
    expect(server).toBeDefined()
  })

  it('发布的报告是报表块（不进审批队列），挂在发布它的那条职责上、发给那个人', async () => {
    const kase = { ...CASE, turns: CASE.turns.slice(0, 2) }
    let probe:
      | { kinds: string[]; inQueue: boolean; role?: string; to?: string; me: string }
      | undefined
    await runReportCase(kase, {
      createServer: async (o: Parameters<typeof createServer>[0]) => {
        const s = await createServer(o)
        const close = s.close.bind(s)
        // 关之前看一眼：报表块的种类、在不在审批队列
        s.close = async () => {
          const ws = s.bootstrap.workspace.id
          const items = await s.approvals.queue({
            workspace_id: ws,
            person_id: s.bootstrap.person.id,
            lane: 'mine',
            kind: 'weekly_review',
          })
          const report = items.find((i) => (i.payload as { kind?: string }).kind === 'report')
          probe = {
            me: s.bootstrap.person.id,
            kinds: report === undefined ? [] : [report.kind],
            inQueue:
              report !== undefined &&
              !(NOT_A_CARD.kinds as readonly string[]).includes(report.kind),
            ...(report === undefined ? {} : { role: report.role_id }),
            ...(report?.routing.recipients[0] === undefined
              ? {}
              : { to: report.routing.recipients[0].person }),
          }
          await close()
        }
        return s
      },
    })
    expect(probe).toMatchObject({ kinds: ['weekly_review'], inQueue: false, role: 'social.reddit' })
    expect(probe?.to).toBe(probe?.me)
  })
})

describe('WP331 退役 WP330 的专用周报定时', () => {
  it('老数据目录里那条「每周五出 Reddit 周报」重启后取消，不再到点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp331-retire-'))
    try {
      const opts = {
        dbDir: dir,
        quiet: true,
        env: { AGENTSWS_SECRETS_KEY: 'f'.repeat(64) },
        tokenRefreshIntervalMs: 0,
        scheduleIntervalMs: 0,
        liveDataIntervalMs: 0,
        startRun: false as const,
      }
      const first = await createServer(opts)
      const ws = first.bootstrap.workspace.id
      await first.schedule.scheduler.schedule({
        id: 'sched_reddit_weekly',
        workspace_id: ws,
        owner: first.bootstrap.person.id,
        role_id: first.bootstrap.ownerAssignment.role_id,
        assignment_id: first.bootstrap.ownerAssignment.id,
        title: '每周五下班前出一份 Reddit 周报',
        trigger: { kind: 'cron', expr: '0 17 * * 5', tz: 'UTC' },
        created_by: 'user',
        misfire_policy: 'run_once_now',
        handler: 'social.reddit_weekly',
      })
      await first.close()
      const second = await createServer(opts)
      expect(second.schedule.scheduler.get('sched_reddit_weekly')?.state).toBe('cancelled')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
