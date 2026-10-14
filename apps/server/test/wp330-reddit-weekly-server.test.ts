/**
 * WP330 端到端（真服务进程 + 替身巡查源；不联网、不开 Reddit、不起端口）：
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 有人担 Reddit 运营 → 建「每周五 17:00」那条定时；能改每周几、几点 | 时间用户可改 |
 * | 到点（定时那一拍）→ 先巡查再出；一张报表卡（不进审批队列）发给担的人 | 周五下班前、最后一次巡查之后 |
 * | `/v1/reddit-weekly/*`：看、导出 Markdown、改分节与措辞 | 可复制 / 导出；不写死格式 |
 * | 工具面：只有担 Reddit 运营的职责看得到那两个工具，调了真改 | 几句话交代就能改 |
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RedditWatchItem, RedditWeeklyPayload } from '@agentsws/contracts'
import { NOT_A_CARD } from '@agentsws/deck'
import {
  GET_REDDIT_WEEKLY_FORMAT_TOOL,
  REDDIT_WEEKLY_TOOL_DEF_BY_NAME,
  REDDIT_WEEKLY_TOOL_NAMES,
  SET_REDDIT_WEEKLY_FORMAT_TOOL,
} from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { RedditWeekSource } from '../src/reddit-weekly.js'
import { createRedditWeeklyToolExecutor } from '../src/reddit-weekly-tools.js'

const NOW = '2026-10-16T09:00:00.000Z' // 周五 17:00（东八区）

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot() {
  const dbDir = mkdtempSync(join(tmpdir(), 'wp330-weekly-'))
  dirs.push(dbDir)
  let swept = 0
  const items: RedditWatchItem[] = [
    {
      id: 't3_a',
      kind: 'post',
      scope: 'own',
      subreddit: 'inmoxr',
      author: 'alice',
      created_at: '2026-10-12T03:00:00.000Z',
      permalink: 'https://www.reddit.com/r/inmoxr/comments/a/',
      title: 'My first week with Air3',
      text: 'Loving the display.',
      signals: { ugc: true },
    },
  ]
  const source: RedditWeekSource = {
    configured: () => true,
    subreddits: () => ['inmoxr'],
    items: () => items,
    sweeps: () => (swept > 0 ? [NOW] : []),
    sweepNow: async () => {
      swept += 1
    },
  }
  server = await createServer({
    dbDir,
    quiet: true,
    clock: { now: () => NOW },
    env: { AGENTSWS_SECRETS_KEY: 'e'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    startRun: false,
    redditWeekSource: () => source,
  })
  const s = server
  const reddit = s.roles.assignments.create({
    person_id: s.bootstrap.person.id,
    workspace_id: s.bootstrap.workspace.id,
    granted_by: s.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
  const call = async (method: string, path: string, body?: unknown) =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': reddit.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const data = async <T>(res: Response): Promise<T> => {
    const j = (await res.json()) as { data: T; error?: unknown }
    if (!res.ok) throw new Error(JSON.stringify(j))
    return j.data
  }
  return { s, call, data, reddit, swept: () => swept }
}

describe('Reddit 周报（服务进程）', () => {
  it('现在出一份：先巡查、出报表卡给担 Reddit 运营的人；能看、能导出、能改分节与措辞', async () => {
    const { s, call, data, reddit, swept } = await boot()
    const run = await data<{ approval_item_id: string; week_of: string }>(
      await call('POST', '/v1/reddit-weekly/run'),
    )
    expect(swept()).toBe(1)
    expect(run.week_of).toBe('2026-10-11')
    const card = await s.approvals.get(run.approval_item_id)
    expect(card?.kind).toBe('weekly_review')
    expect((NOT_A_CARD.kinds as readonly string[]).includes(card?.kind ?? '')).toBe(true)
    expect(card?.role_id).toBe('social.reddit')
    expect(card?.routing.recipients[0]?.person).toBe(reddit.person_id)
    expect((card?.payload as RedditWeeklyPayload | undefined)?.kind).toBe('reddit_weekly')

    const latest = await data<RedditWeeklyPayload>(await call('GET', '/v1/reddit-weekly'))
    expect(latest.totals).toMatchObject({ posts: 1, ugc: 1 })
    const doc = await data<{ filename: string; content: string }>(
      await call('GET', '/v1/reddit-weekly/export?week_of=2026-10-11'),
    )
    expect(doc.filename).toBe('reddit-weekly-2026-10-11.md')
    expect(doc.content).toContain('> Loving the display.')
    expect((await call('GET', '/v1/reddit-weekly/export?week_of=bad')).status).toBe(400)

    const set = await data<{ problems: string[] }>(
      await call('PUT', '/v1/reddit-weekly/format', {
        patch: { sections: [{ id: 'external', enabled: false }], numbering: 'none' },
      }),
    )
    expect(set.problems).toEqual([])
    const preview = await data<RedditWeeklyPayload>(await call('GET', '/v1/reddit-weekly/preview'))
    expect(preview.sections.map((x) => x.id)).toEqual(['own_stats', 'voc_ugc', 'our_replies'])
    expect(preview.markdown).toContain('## 自家版块数据')
  })

  it('定时：有人担 Reddit 运营就建「每周五 17:00」那一条，能改；到点那一拍出卡', async () => {
    const { s, call, data, swept } = await boot()
    // 分配是启动后建的：等一拍让「跟着分配即时建」走完（WP215）
    await new Promise((r) => setTimeout(r, 50))
    const view = await data<{ weekday: number; time: string; missing?: boolean }>(
      await call('GET', '/v1/reddit-weekly/schedule'),
    )
    expect(view.missing).toBeUndefined()
    expect(view).toMatchObject({ weekday: 5, time: '17:00' })
    const changed = await data<{ weekday: number; time: string }>(
      await call('PUT', '/v1/reddit-weekly/schedule', { weekday: 4, time: '18:30' }),
    )
    expect(changed).toMatchObject({ weekday: 4, time: '18:30' })
    await s.schedule.scheduler.runNow('sched_reddit_weekly')
    expect(swept()).toBe(1)
    const latest = await data<RedditWeeklyPayload>(await call('GET', '/v1/reddit-weekly'))
    expect(latest.week_of).toBe('2026-10-11')
  })
})

describe('分节与措辞的两个工具（几句话交代就能改）', () => {
  it('看 → 只改要改的 + 改每周几几点 → 下一份照新的出；认不出的照实回', async () => {
    const { s, call, data } = await boot()
    await data(await call('POST', '/v1/reddit-weekly/run'))
    const modules = await s.brands.forWorkspace(s.bootstrap.workspace.id)
    let sched = { weekday: 5, time: '17:00', paused: false }
    const exec = createRedditWeeklyToolExecutor({
      service: async () => modules.redditWeekly,
      schedule: () => sched,
      setSchedule: async (_w, input) => {
        sched = { ...sched, ...input }
        return sched
      },
    })
    const request = {
      workspace_id: s.bootstrap.workspace.id,
      actor: { person_id: 'p', assignment_id: 'a', role_id: 'social.reddit' },
    } as never
    const got = await exec({ name: GET_REDDIT_WEEKLY_FORMAT_TOOL, input: {}, request } as never)
    expect(got.status).toBe('ok')
    const view = (got as { data: { schedule: string; last_report: string } }).data
    expect(view.schedule).toBe('每周五 17:00')
    expect(view.last_report).toContain('Reddit 周报（10/11 – 10/16）')
    const set = await exec({
      name: SET_REDDIT_WEEKLY_FORMAT_TOOL,
      input: {
        instruction:
          '外部舆情那节叫「全域 VOC & 舆情监测」放第一，评估「需跟进」改成「建议跟进」，周四 18:00 出',
        sections: [{ id: 'external', title: '全域 VOC & 舆情监测' }],
        assessment_labels: { follow_up: '建议跟进' },
        weekday: 4,
        time: '18:00',
      },
      request,
    } as never)
    expect((set as { data: unknown }).data).toMatchObject({
      ok: true,
      schedule: '每周四 18:00',
      preview: ['全域 VOC & 舆情监测', '自家版块数据', '自家版块 VOC 与 UGC', '我们本周的回复'],
      problems: [],
    })
    const next = await data<RedditWeeklyPayload>(await call('GET', '/v1/reddit-weekly/preview'))
    expect(next.markdown).toContain('## 一、全域 VOC & 舆情监测')
    const bad = await exec({
      name: SET_REDDIT_WEEKLY_FORMAT_TOOL,
      input: { instruction: 'x', sections: [{ id: 'screenshots' }], time: '25:00' },
      request,
    } as never)
    expect((bad as { data: { ok: boolean; problems: string[] } }).data).toMatchObject({
      ok: false,
      problems: ['认不出的小节：screenshots', '出报告的时间要写成 周几（0–6）+ HH:MM'],
    })
  })

  it('工具定义：两个名字排好序，参数里有四节的 id', () => {
    expect(REDDIT_WEEKLY_TOOL_NAMES).toEqual([
      GET_REDDIT_WEEKLY_FORMAT_TOOL,
      SET_REDDIT_WEEKLY_FORMAT_TOOL,
    ])
    expect(
      JSON.stringify(REDDIT_WEEKLY_TOOL_DEF_BY_NAME.get(SET_REDDIT_WEEKLY_FORMAT_TOOL)),
    ).toContain('our_replies')
  })
})
