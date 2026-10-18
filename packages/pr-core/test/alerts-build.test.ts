import type { GoogleAlertsJob, MonitorPlanItem, MonitorSource } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  alertChangeOf,
  alertLinesFromPlan,
  approvedLines,
  buildAlertsBrief,
  ingestAlertsReport,
  isGoogleAlertsFeedUrl,
  labelOfQuery,
  normalizeAlertQuery,
  splitExisting,
  toRssLines,
} from '../src/index.js'

const NOW = '2026-10-18T09:00:00.000Z'
const FEED = (n: number) => `https://www.google.com/alerts/feeds/0000000000/${1000 + n}`

const plan = (
  id: string,
  label: string,
  query: string,
  extra: Partial<MonitorPlanItem> = {},
): MonitorPlanItem => ({
  id,
  workspace_id: 'ws_t',
  group: 'competitor',
  label,
  query,
  language: 'en',
  region: 'US',
  competitor: label,
  why: '主要竞品',
  selected: true,
  status: 'planned',
  created_at: NOW,
  updated_at: NOW,
  ...extra,
})

const source = (id: string, url: string, query?: string): MonitorSource => ({
  id,
  workspace_id: 'ws_t',
  kind: 'google_alerts',
  url,
  group: 'own',
  label: 'x',
  ...(query === undefined ? {} : { query }),
  every_hours: 24,
  status: 'ok',
  added_via: 'paste',
  created_at: NOW,
})

const PLAN = [
  plan('mp_1', 'Aventon', '"Aventon" -job'),
  plan('mp_2', 'Rad Power', '"Rad Power Bikes"'),
  plan('mp_3', 'Lectric', '"Lectric eBikes"'),
  plan('mp_4', 'Super73', '"Super73"', { selected: false, status: 'skipped' }),
  plan('mp_5', 'Aventon 重复', '“aventon”   -JOB'),
  plan('mp_6', '已挂上', '"Ride1Up"', { status: 'linked', source_id: 'ms_x' }),
]

describe('清单 → 卡（一批一张）', () => {
  it('只列勾着、没挂上、不重复的；查询语句归一后判重复', () => {
    const lines = alertLinesFromPlan(PLAN, [source('ms_9', FEED(9), '"Lectric eBikes"')])
    expect(lines.map((l) => l.query)).toEqual(['"Aventon" -job', '"Rad Power Bikes"'])
    expect(lines.map((l) => l.id)).toEqual(['ga_1', 'ga_2'])
    expect(lines.every((l) => l.op === 'create' && l.selected)).toBe(true)
    expect(normalizeAlertQuery('“Aventon”  OR  x')).toBe('"aventon" or x')
  })

  it('卡的标题写明 N 条、正文写明四项设置与只动这几条', () => {
    const lines = alertLinesFromPlan(PLAN, [])
    const c = alertChangeOf('create', lines)
    expect(c.title).toBe('要在你的 Google 账号里建 3 条提醒')
    expect(c.summary).toContain('所有结果')
    expect(c.summary).toContain('RSS')
    expect(c.summary).toContain('不碰你别的提醒')
    expect(c.after.lines).toHaveLength(3)
    expect(alertChangeOf('to_rss', lines).title).toContain('改成 RSS')
  })

  it('同意之后：只认勾选；改了查询语句、编出新行都不认', () => {
    const { after } = alertChangeOf('create', alertLinesFromPlan(PLAN, []))
    expect(approvedLines(after).map((l) => l.id)).toEqual(['ga_1', 'ga_2', 'ga_3'])
    const edited = {
      after: {
        lines: [
          { id: 'ga_1', selected: true, query: '"Evil" site:x.com' },
          { id: 'ga_2', selected: false },
          { id: 'ga_99', selected: true, query: 'injected' },
        ],
      },
    }
    const got = approvedLines(after, edited)
    expect(got.map((l) => l.id)).toEqual(['ga_1', 'ga_3'])
    expect(got[0]?.query).toBe('"Aventon" -job')
  })
})

const job = (lines = alertLinesFromPlan(PLAN, [])): GoogleAlertsJob => ({
  change_id: 'chg_1',
  op: 'create',
  lines,
  status: 'running',
  created_at: NOW,
  updated_at: NOW,
})

let n = 0
const newId = () => `t${++n}`

describe('读回结果 → 监控源', () => {
  it('建好的写成监控源（added_via: browser、先标 unchecked、挂回配置卡那一行）', () => {
    const r = ingestAlertsReport({
      workspace_id: 'ws_t',
      job: job(),
      report: {
        change_id: 'chg_1',
        stop: 'done',
        lines: [
          { id: 'ga_1', outcome: 'created', feed_url: FEED(1) },
          { id: 'ga_2', outcome: 'existing', feed_url: FEED(2).replace('www.', '') },
          { id: 'ga_3', outcome: 'created', feed_url: FEED(3) },
        ],
      },
      sources: [],
      now: NOW,
      newId,
    })
    expect(r.status).toBe('done')
    expect(r.sources).toHaveLength(3)
    expect(r.sources.every((s) => s.added_via === 'browser' && s.status === 'unchecked')).toBe(true)
    expect(r.sources[1]?.url).toBe(FEED(2))
    expect(r.sources[0]).toMatchObject({
      kind: 'google_alerts',
      query: '"Aventon" -job',
      language: 'en',
      region: 'US',
      group: 'competitor',
      competitor: 'Aventon',
    })
    expect(r.links.map((l) => l.plan_item_id)).toEqual(['mp_1', 'mp_2', 'mp_3'])
    expect(r.summary).toContain('建好 3 条')
  })

  it('读回来的不是 RSS 链接 / 没读回 → 算没建成；卡外的行不认；同一链接已在就挂上不重复存', () => {
    const r = ingestAlertsReport({
      workspace_id: 'ws_t',
      job: job(),
      report: {
        change_id: 'chg_1',
        stop: 'done',
        lines: [
          { id: 'ga_1', outcome: 'created', feed_url: 'https://www.google.com/alerts?s=mail' },
          { id: 'ga_2', outcome: 'created' },
          { id: 'ga_3', outcome: 'created', feed_url: FEED(7) },
          { id: 'ga_42', outcome: 'created', feed_url: FEED(42) },
        ],
      },
      sources: [source('ms_old', FEED(7))],
      now: NOW,
      newId,
    })
    expect(r.sources).toHaveLength(0)
    expect(r.links).toEqual([{ plan_item_id: 'mp_3', source_id: 'ms_old' }])
    expect(r.failed.map((f) => f.reason)).toEqual(['读回来的不是 RSS 链接', '没读回 RSS 链接'])
    expect(r.status).toBe('partial')
  })

  it('验证码停下：交代过的照常保存，其余列成没建成并说为什么；邮箱投递的单独拎出来', () => {
    const r = ingestAlertsReport({
      workspace_id: 'ws_t',
      job: job(),
      report: {
        change_id: 'chg_1',
        stop: 'captcha',
        lines: [
          { id: 'ga_1', outcome: 'created', feed_url: FEED(1) },
          { id: 'ga_2', outcome: 'existing_email' },
        ],
      },
      sources: [],
      now: NOW,
      newId,
    })
    expect(r.sources).toHaveLength(1)
    expect(r.email.map((l) => l.id)).toEqual(['ga_2'])
    expect(r.failed).toEqual([
      {
        line: expect.objectContaining({ id: 'ga_3' }),
        reason: '没轮到（Google 要你做一次人机验证）',
      },
    ])
    expect(r.summary).toContain('Lectric没建成（Google 要你做一次人机验证）')
    expect(r.summary).toContain('改成 RSS')
  })

  it('页面认不出、一条都没成 → failed，全部列出来', () => {
    const r = ingestAlertsReport({
      workspace_id: 'ws_t',
      job: job(),
      report: { change_id: 'chg_1', stop: 'page_changed', lines: [] },
      sources: [],
      now: NOW,
      newId,
    })
    expect(r.status).toBe('failed')
    expect(r.failed).toHaveLength(3)
    expect(r.summary).toContain('页面和我认识的不一样了')
  })
})

describe('读已有的、改成 RSS', () => {
  it('分成能导入的 / 邮箱投递的 / 已在监控源里的', () => {
    const v = splitExisting(
      [
        { query: '"Cyrusher"', delivery: 'rss', feed_url: FEED(1) },
        { query: '"Cyrusher ebike"', delivery: 'rss', feed_url: FEED(2) },
        { query: '"Cyrusher review"', delivery: 'email' },
        { query: '"cyrusher"', delivery: 'rss', feed_url: FEED(9) },
        { query: '"Ride1Up"', delivery: 'email' },
      ],
      [source('ms_1', FEED(2)), source('ms_2', FEED(3), '"Ride1Up"')],
      NOW,
    )
    expect(v.importable.map((e) => e.query)).toEqual(['"Cyrusher"'])
    expect(v.email.map((e) => e.query)).toEqual(['"Cyrusher review"'])
    expect(v.already).toBe(2)
    const lines = toRssLines(v.email)
    expect(lines[0]).toMatchObject({ op: 'to_rss', label: 'Cyrusher review', language: 'any' })
  })

  it('链接认法与人话名', () => {
    expect(isGoogleAlertsFeedUrl(FEED(1))).toBe(true)
    expect(isGoogleAlertsFeedUrl('https://google.com/alerts/feeds/1/2')).toBe(true)
    expect(isGoogleAlertsFeedUrl('https://www.google.com/alerts/feeds/')).toBe(false)
    expect(isGoogleAlertsFeedUrl('https://example.com/feed')).toBe(false)
    expect(labelOfQuery('"Aventon" -job')).toBe('Aventon')
    expect(labelOfQuery('engwe site:example.com')).toBe('engwe site:example.com')
  })

  it('任务说明：列出每一行、写明只碰这几条、change_id、遇到验证码请人', () => {
    const text = buildAlertsBrief(job())
    expect(text).toContain('ga_1')
    expect(text).toContain('chg_1')
    expect(text).toContain('google-alerts')
    expect(text).toContain('只碰这几条')
    expect(text).toContain('request-help')
  })
})
