// @vitest-environment jsdom
/**
 * WP315：「工坊日报」建立与每日导出在本地假后台上走一遍（不联网、不碰真站）。
 * 守的是：只点导出拿文件（不读页面上的数）、建报表算写要审批编号、导出算读、白名单与步骤对得上。
 */
import { describe, expect, it } from 'vitest'
import {
  type ActionJob,
  buildAdsJob,
  checkPlanSteps,
  REPORT_LEVELS,
  type RunHooks,
  runAction,
  validateJob,
  workshopReportName,
} from '../src/index.js'
import { FakeReportPage, type FakeReportState } from './fake-reports.js'

const google = { platform: 'google_ads' as const, id: '123-456-7890', ocid: '42' }
const meta = { platform: 'meta_ads' as const, id: 'act_999' }
const origins = {
  google_ads: 'https://ads.google.com',
  meta_ads: 'https://adsmanager.facebook.com',
}

const job = (
  account: typeof google | typeof meta,
  kind: 'setup_daily_report' | 'export_daily_report',
  approval = true,
): ActionJob =>
  buildAdsJob({
    id: `job_${kind}`,
    workspace_id: 'ws_1',
    account,
    action: { kind },
    ...(approval ? { approval_id: 'notice_1', approval_level: 'L3' as const } : {}),
    created_at: '2026-10-15T01:00:00.000Z',
    origins,
  })

function hooks() {
  const downloads: { tag: string; name: string }[] = []
  const h: RunHooks = {
    progress: async () => ({ stop: false }),
    stopped: () => false,
    confirm: async () => 'yes',
    evidence: async () => {},
    downloaded: async (tag, file) => {
      downloads.push({ tag, name: file.name })
    },
    sleep: async () => {},
  }
  return { h, downloads }
}

const fresh = (patch: Partial<FakeReportState> = {}): FakeReportState => ({
  saved: [],
  downloads: [],
  ...patch,
})

describe('Google：建「工坊日报」→ 每天导出五份 CSV', () => {
  it('建：五份保存报表，名字是我们起的；读回认得出最后一份', async () => {
    const state = fresh()
    const { h, downloads } = hooks()
    const result = await runAction(job(google, 'setup_daily_report'), new FakeReportPage(state), h)
    expect(result.outcome).toBe('done')
    expect(state.saved).toEqual(
      REPORT_LEVELS.google_ads.map((l) => workshopReportName('google_ads', l)),
    )
    expect(state.saved[0]).toBe('工坊日报 · 广告系列')
    expect(downloads).toEqual([])
  })

  it('导出：打开每一份、点下载 CSV；只交文件，不读页面上的数', async () => {
    const state = fresh({
      saved: REPORT_LEVELS.google_ads.map((l) => workshopReportName('google_ads', l)),
    })
    const j = job(google, 'export_daily_report', false)
    expect(j.plan.pace).toBe('read')
    expect(j.plan.steps.some((s) => s.op === 'read')).toBe(false)
    const { h, downloads } = hooks()
    const result = await runAction(j, new FakeReportPage(state), h)
    expect(result.outcome).toBe('done')
    expect(downloads.map((d) => d.tag)).toEqual(['report', 'report', 'report', 'report', 'report'])
    expect(downloads[4]?.name).toBe('工坊日报 · 搜索字词.csv')
  })

  it('报表被人删了 → 找不到那一份就停下交给人，不乱点', async () => {
    const { h } = hooks()
    const result = await runAction(
      job(google, 'export_daily_report', false),
      new FakeReportPage(fresh()),
      h,
    )
    expect(result.outcome).toBe('handover')
  })

  it('撞上验证码 → 停下交给人', async () => {
    const { h } = hooks()
    const result = await runAction(
      job(google, 'export_daily_report', false),
      new FakeReportPage(fresh({ captcha: true })),
      h,
    )
    expect(result.outcome).toBe('handover')
  })
})

describe('Meta：一份「工坊日报」（一行一条广告）', () => {
  it('建好再导出，导出的文件名就是报表名', async () => {
    const state = fresh()
    const a = await runAction(job(meta, 'setup_daily_report'), new FakeReportPage(state), hooks().h)
    expect(a.outcome).toBe('done')
    expect(state.saved).toEqual(['工坊日报'])
    const { h, downloads } = hooks()
    const b = await runAction(job(meta, 'export_daily_report', false), new FakeReportPage(state), h)
    expect(b.outcome).toBe('done')
    expect(downloads).toEqual([{ tag: 'report', name: '工坊日报.csv' }])
  })
})

describe('进队前的闸', () => {
  it('建报表是写：没有审批编号不进队；导出是读：不要编号', () => {
    const zones = {} as never
    expect(validateJob(job(google, 'setup_daily_report', false), { zones }).ok).toBe(false)
    expect(validateJob(job(google, 'setup_daily_report'), { zones }).ok).toBe(true)
    expect(validateJob(job(meta, 'export_daily_report', false), { zones }).ok).toBe(true)
  })

  it('四张步骤表都过白名单（步骤与白名单分开写，对不上这里喊）', () => {
    for (const account of [google, meta])
      for (const kind of ['setup_daily_report', 'export_daily_report'] as const) {
        const plan = job(account, kind).plan
        expect(checkPlanSteps(plan.steps, plan.allow, plan.kind)).toEqual({ ok: true })
        expect(plan.zones).toEqual([])
      }
  })
})
