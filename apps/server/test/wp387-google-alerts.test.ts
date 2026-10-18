/**
 * WP387（docs/103 v2 §3.3、T1）：你的浏览器替你建 / 导入 Google 提醒。
 *
 * **不连真 Google**：提醒页是手写的本地替身（`fixtures/google-alerts/*.html`），浏览器是替身版的六个 `bsk_*`
 * （每次调用先过真门禁那一道），「模型」是照技能说明一步步做的剧本（认页面的字从技能说明那张表里读）。
 * 服务（出卡 / 同意 / 交代结果）、信息监控的库与 `addLinks`（先拉一次）都是真的；feed 用录好的样本。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalItem, MonitorPlanItem, RunRequest, StagedChange } from '@agentsws/contracts'
import type { StageInput } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createPrAlertsService, type PrAlertsService } from '../src/pr-alerts/service.js'
import {
  BUILD_TOGGLE_KEY,
  manualFallbackPending,
  markManualFallback,
  withBrowserBuild,
} from '../src/pr-alerts/setup.js'
import { createGoogleAlertsTool } from '../src/pr-alerts/tool.js'
import { createPrWatch, createPrWatchStore } from '../src/pr-watch/index.js'
import {
  cuesFromSkill,
  type DriveTask,
  driveAlerts,
  FakeBsk,
  FakeGoogleAlerts,
} from './fixtures/google-alerts-standin.js'

const WS = 'ws_ga' as never
const NOW = '2026-10-18T10:00:00.000Z'
const ACTOR = { person_id: 'p_1', assignment_id: 'asg_pr', role_id: 'pr.monitoring' }
const ATOM = readFileSync(
  join(__dirname, '../../../packages/pr-core/test/fixtures/google-alerts-3.atom.xml'),
  'utf8',
)

const plan = (id: string, label: string, query: string): MonitorPlanItem => ({
  id,
  workspace_id: WS,
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
})

/** 任务说明 → 剧本要做的事（模型读的就是这段话）。 */
function taskOfBrief(brief: string, svc: PrAlertsService): DriveTask {
  const change_id = /change_id 填 (\S+?)，/u.exec(brief)?.[1]
  if (change_id === undefined) return {}
  const job = svc.jobs().find((j) => j.change_id === change_id)
  const ids = [...brief.matchAll(/^- (ga_\d+)：查询「(.*)」 · 语言 (\S+) · 地区 (\S+)$/gmu)]
  const lines = (job?.lines ?? []).filter((l) => ids.some((m) => m[1] === l.id && m[2] === l.query))
  return { change_id, op: brief.includes('改成 RSS') ? 'to_rss' : 'create', lines }
}

function harness(
  opts: { site?: FakeGoogleAlerts; browserReady?: boolean; skipReport?: boolean } = {},
) {
  const site = opts.site ?? new FakeGoogleAlerts()
  const store = createPrWatchStore({ workspace_id: WS })
  for (const p of [
    plan('mp_1', 'Aventon', '"Aventon" -job'),
    plan('mp_2', 'Rad Power', '"Rad Power Bikes"'),
    plan('mp_3', 'Lectric', '"Lectric eBikes"'),
  ])
    store.putPlanItem(p)
  let n = 0
  const fetched: string[] = []
  const watch = createPrWatch({
    workspace_id: WS,
    store,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++n}`,
    tzOffsetMinutes: () => 480,
    fetch: async (url) => {
      fetched.push(url)
      const a = site.alerts.find((x) => site.feedUrl(x.id) === url && x.delivery === 'rss')
      const body =
        a === undefined ? '' : ATOM.replace('Google Alert - Super73', `Google Alert - ${a.query}`)
      return { ok: a !== undefined, status: a === undefined ? 404 : 200, text: async () => body }
    },
  })
  const staged: (StageInput & { id: string; approval_id: string })[] = []
  const approvals = new Map<string, ApprovalItem>()
  const running: Promise<void>[] = []
  const matters: { id: string; title: string; brief?: string }[] = []
  const fallbacks: { labels: string[]; why: string }[] = []
  const asked: { target: string; why: string }[] = []
  const bsks: FakeBsk[] = []
  let svc!: PrAlertsService
  const tool = createGoogleAlertsTool(() => svc)
  svc = createPrAlertsService({
    workspace_id: WS,
    store: () => store,
    clock: { now: () => NOW },
    newId: (prefix) => `${prefix}${++n}`,
    ledger: {
      stage: async (input) => {
        const id = `chg_${staged.length + 1}`
        const approval_id = `apv_${staged.length + 1}`
        staged.push({ ...input, id, approval_id })
        return {
          ok: true,
          change: { id } as StagedChange,
          approval: { id: approval_id } as ApprovalItem,
        }
      },
    },
    actionOf: () => ({ mandate: { caps: {} }, level: 'L1' }),
    holder: () => ACTOR,
    approval: (id) => approvals.get(id),
    browser: () =>
      opts.browserReady === false
        ? { ready: false, reason: '你的浏览器还没接上' }
        : { ready: true },
    runs: {
      open: ({ title }) => {
        const id = `mt_${matters.length + 1}`
        matters.push({ id, title })
        return id
      },
      start: ({ matter_id, brief }) => {
        const m = matters.find((x) => x.id === matter_id)
        if (m !== undefined) m.brief = brief
        const p = (async () => {
          // 这次运行的请求上带不带凭据：服务端现查（与 runtime 的 `browserGrants` 同一口）
          const grants = svc.grantsFor(matter_id)
          const bsk = new FakeBsk(site, grants)
          bsks.push(bsk)
          const report = await driveAlerts(bsk, taskOfBrief(brief, svc))
          if (opts.skipReport === true) return
          await tool({
            name: 'report_google_alerts',
            input: report as unknown as Record<string, unknown>,
            request: {
              actor: ACTOR,
              ...(grants.length === 0 ? {} : { browser_grants: grants }),
            } as unknown as RunRequest,
          })
        })()
        running.push(p)
        return p
      },
    },
    attach: async ({ url, plan_item_id, group }) => {
      const [r] = await watch.addLinks({
        links: url,
        ...(plan_item_id === undefined ? {} : { plan_item_id }),
        group,
        via: 'browser',
      })
      return r?.ok === true && r.source_id !== undefined
        ? { ok: true, source_id: r.source_id }
        : { ok: false, message: r?.message ?? '没拉到' }
    },
    askSetup: async ({ target, why }) => {
      asked.push({ target, why })
    },
    onFallback: ({ lines, why }) => {
      markManualFallback(
        store,
        NOW,
        lines.map((l) => l.label),
      )
      fallbacks.push({ labels: lines.map((l) => l.label), why })
    },
  })

  /** 人在卡上同意（`unchecked` = 勾掉的行）。 */
  const approve = async (
    i: number,
    unchecked: string[] = [],
    tamper?: (lines: { id: string; query?: string }[]) => void,
  ) => {
    const s = staged[i]
    if (s === undefined) throw new Error(`没有第 ${i} 张卡`)
    const after = s.after as { lines: { id: string }[] }
    const edited = {
      after: {
        ...after,
        lines: after.lines.map((l) => ({ ...l, selected: !unchecked.includes(l.id) })),
      },
    }
    tamper?.(edited.after.lines)
    const asEdited = unchecked.length > 0 || tamper !== undefined
    approvals.set(s.approval_id, {
      id: s.approval_id,
      state: asEdited ? 'approved_edited' : 'approved',
      payload: asEdited ? edited : { after },
    } as unknown as ApprovalItem)
    const change = {
      id: s.id,
      kind: s.kind,
      after: s.after,
      assignment_id: ACTOR.assignment_id,
      role_id: ACTOR.role_id,
      created_by: s.created_by,
      approval: { item_id: s.approval_id },
    } as unknown as StagedChange
    const out = await svc.apply(change)
    await Promise.all(running)
    return out
  }
  /** 等后台那一趟跑完。 */
  const settle = () => Promise.all(running)
  return {
    site,
    store,
    watch,
    svc,
    staged,
    approve,
    settle,
    matters,
    fallbacks,
    asked,
    bsks,
    fetched,
    tool,
  }
}

describe('一张卡一次同意', () => {
  it('清单 → 一张卡列全部 N 条；勾掉一条、同意一次；浏览器只建勾着的那几条，六项都设对', async () => {
    const h = harness()
    h.site.add('"Cyrusher"', 'rss', { region: 'US' })
    const before = JSON.stringify(h.site.alerts)
    const out = await h.svc.propose()
    expect(out).toMatchObject({ ok: true, count: 3 })
    expect(h.staged).toHaveLength(1)
    expect(h.staged[0]).toMatchObject({ kind: 'google_alert_change', field: 'create' })
    expect(h.staged[0]?.approval.title).toBe('要在你的 Google 账号里建 3 条提醒')
    const res = await h.approve(0, ['ga_2'])
    expect(res).toMatchObject({ status: 'ok' })
    // 开了一件事（「运行中的浏览器」在那里看得到）
    expect(h.matters[0]?.title).toBe('在你的 Google 账号里建 2 条提醒')
    // 浏览器只建了勾着的两条，Rad Power 没建
    expect(h.site.created).toBe(2)
    const made = h.site.alerts.slice(1)
    expect(made.map((a) => a.query)).toEqual(['"Aventon" -job', '"Lectric eBikes"'])
    for (const a of made)
      expect(a).toMatchObject({
        delivery: 'rss',
        frequency: 'as_it_happens',
        sources: 'automatic',
        how_many: 'all',
        language: 'en',
        region: 'US',
      })
    // 不碰清单外的提醒
    expect(JSON.stringify(h.site.alerts.slice(0, 1))).toBe(JSON.stringify(JSON.parse(before)))
    expect(h.site.deleted).toBe(0)
    expect(h.site.updated).toBe(0)
    // 读回 RSS 链接 → 监控源（added_via: browser，先拉了一次）
    const sources = h.store.sources()
    expect(sources).toHaveLength(2)
    expect(sources.every((s) => s.added_via === 'browser' && s.kind === 'google_alerts')).toBe(true)
    expect(sources.every((s) => s.url.startsWith('https://www.google.com/alerts/feeds/'))).toBe(
      true,
    )
    expect(h.fetched).toHaveLength(2)
    expect(h.store.planItem('mp_1')?.status).toBe('linked')
    expect(h.store.planItem('mp_2')?.status).toBe('planned')
    const job = h.svc.jobs()[0]
    expect(job?.status).toBe('done')
    expect(job?.summary).toContain('建好 2 条')
    // 交代完凭据就收回（那件事再跑一次也改不了提醒）
    expect(h.svc.grantsFor('mt_1')).toEqual([])
  })

  it('一条一条来：建第二条之前，第一条已经建完、读回了链接（不并发）', async () => {
    const h = harness()
    await h.svc.propose()
    await h.approve(0)
    const clicks = h.bsks[0]?.log
      .filter((c) => c.tool === 'bsk_interact' && c.args.action === 'fill')
      .map((c) => String(c.args.value))
    expect(clicks).toEqual(['"Aventon" -job', '"Rad Power Bikes"', '"Lectric eBikes"'])
    expect(h.bsks).toHaveLength(1)
  })

  it('卡上改不了查询语句、加不进新行（只认勾选）', async () => {
    const h = harness()
    await h.svc.propose()
    await h.approve(0, [], (lines) => {
      if (lines[0] !== undefined) lines[0].query = '"Hacked" site:evil.example'
      lines.push({ id: 'ga_9', query: '"Injected"' })
    })
    // 用的是账本里那一版（原样），不是卡面上被改过的；编出来的行不认
    expect(h.site.alerts.map((a) => a.query)).toEqual([
      '"Aventon" -job',
      '"Rad Power Bikes"',
      '"Lectric eBikes"',
    ])
  })
})

describe('重复的不重复建；邮箱投递的另出一张卡', () => {
  it('账号里已有同样查询语句（RSS）：不再建，直接读它的链接', async () => {
    const h = harness()
    h.site.add('"aventon"  -JOB', 'rss')
    await h.svc.propose()
    await h.approve(0)
    expect(h.site.created).toBe(2)
    expect(h.site.alerts.filter((a) => a.query.toLowerCase().includes('aventon'))).toHaveLength(1)
    expect(h.store.sources()).toHaveLength(3)
    expect(h.svc.jobs()[0]?.results?.find((r) => r.id === 'ga_1')?.outcome).toBe('existing')
  })

  it('已有但还在发邮件：不重建、不在这一趟里改；单独出「改成 RSS」卡，同意后才改，改完读回链接', async () => {
    const h = harness()
    h.site.add('"Rad Power Bikes"', 'email')
    await h.svc.propose()
    await h.approve(0)
    expect(h.site.created).toBe(2)
    expect(h.site.alerts.find((a) => a.query === '"Rad Power Bikes"')?.delivery).toBe('email')
    // 第二张卡：改成 RSS（同样一次同意）
    expect(h.staged).toHaveLength(2)
    expect(h.staged[1]).toMatchObject({ field: 'to_rss' })
    expect(h.staged[1]?.approval.title).toBe('把 1 条提醒的投递改成 RSS')
    expect(h.site.updated).toBe(0)
    await h.approve(1)
    expect(h.site.updated).toBe(1)
    expect(h.site.alerts.find((a) => a.query === '"Rad Power Bikes"')).toMatchObject({
      delivery: 'rss',
      frequency: 'as_it_happens',
    })
    expect(h.store.sources()).toHaveLength(3)
    expect(h.store.planItem('mp_2')?.status).toBe('linked')
  })
})

describe('出岔子交给人，绝不硬闯', () => {
  it('验证码：请人接管；人处理完接着建', async () => {
    const site = new FakeGoogleAlerts()
    site.captcha = true
    const h = harness({ site })
    await h.svc.propose()
    await h.approve(0)
    expect(site.helps).toBe(1)
    expect(site.created).toBe(3)
    expect(h.svc.jobs()[0]?.status).toBe('done')
  })

  it('验证码人没处理：一条都不建，照实说、全部退回手动（配置卡重新弹出来），不自动再来一轮', async () => {
    const site = new FakeGoogleAlerts()
    site.captcha = true
    site.helpResolves = false
    const h = harness({ site })
    await h.svc.propose()
    await h.approve(0)
    expect(site.created).toBe(0)
    const job = h.svc.jobs()[0]
    expect(job).toMatchObject({ status: 'failed', stop: 'captcha' })
    expect(job?.summary).toContain('Google 要你做一次人机验证')
    expect(h.fallbacks).toEqual([
      { labels: ['Aventon', 'Rad Power', 'Lectric'], why: '没轮到（Google 要你做一次人机验证）' },
    ])
    expect(manualFallbackPending(h.store)?.labels).toHaveLength(3)
    expect(h.bsks).toHaveLength(1)
    // 交了一次就不收第二遍
    const again = await h.svc.report(
      { change_id: 'chg_1', lines: [], stop: 'done' },
      { grants: [{ change_kind: 'google_alert_change', change_id: 'chg_1' }] },
    )
    expect(again.ok).toBe(false)
  })

  it('没登录：请人登录（不替他输密码）；没处理完照实说', async () => {
    const site = new FakeGoogleAlerts()
    site.signedIn = false
    site.helpResolves = false
    const h = harness({ site })
    await h.svc.propose()
    await h.approve(0)
    expect(h.bsks[0]?.log.some((c) => c.tool === 'bsk_interact')).toBe(false)
    expect(h.svc.jobs()[0]?.stop).toBe('not_signed_in')
  })

  it('页面改版认不出：停下，列出没建成的，退回手动；一个按钮都没乱点', async () => {
    const site = new FakeGoogleAlerts()
    site.redesigned = true
    const h = harness({ site })
    await h.svc.propose()
    await h.approve(0)
    expect(h.bsks[0]?.log.filter((c) => c.tool === 'bsk_interact')).toEqual([])
    const job = h.svc.jobs()[0]
    expect(job?.stop).toBe('page_changed')
    expect(job?.summary).toContain('页面和我认识的不一样了')
    expect(job?.results?.every((r) => r.outcome === 'not_attempted')).toBe(true)
    expect(h.fallbacks[0]?.labels).toEqual(['Aventon', 'Rad Power', 'Lectric'])
  })

  it('页面改版只要改技能说明：说明里的字换成新页面上的，剧本就认得了（代码里没有写死的认法）', () => {
    const cues = cuesFromSkill()
    expect(cues.input).toBe('Create an alert about…')
    expect(cues.showOptions).toBe('Show options')
    expect(cues.selects.find((s) => s.key === 'how_many')?.option).toBe('All results')
    expect(cues.selects.find((s) => s.key === 'deliver')?.option).toBe('RSS feed')
    expect(cues.signIn).toContain('Sign in')
    expect(cues.captcha).toContain('unusual traffic')
  })

  it('浏览器没接上：不开那一趟，照实说、退回手动', async () => {
    const h = harness({ browserReady: false })
    await h.svc.propose()
    const res = await h.approve(0)
    expect(res).toMatchObject({ status: 'failed' })
    expect(h.matters).toHaveLength(0)
    expect(h.fallbacks[0]?.why).toContain('浏览器还没接上')
  })

  it('跑完了没交代结果：照实记「没交代结果」，凭据收回，退回手动', async () => {
    const h = harness({ skipReport: true })
    await h.svc.propose()
    await h.approve(0)
    expect(h.svc.jobs()[0]).toMatchObject({ status: 'failed' })
    expect(h.svc.grantsFor('mt_1')).toEqual([])
    expect(h.fallbacks[0]?.why).toBe('没交代结果')
  })
})

describe('门禁：没同意过的卡改不了提醒', () => {
  it('没有凭据的运行：提醒页上第一下输入就被拦，什么都没建', async () => {
    const site = new FakeGoogleAlerts()
    const bsk = new FakeBsk(site, undefined)
    const report = await driveAlerts(bsk, {
      change_id: 'chg_x',
      op: 'create',
      lines: [
        {
          id: 'ga_1',
          op: 'create',
          query: '"X"',
          language: 'en',
          region: 'US',
          label: 'X',
          group: 'competitor',
          selected: true,
        },
      ],
    })
    expect(site.created).toBe(0)
    expect(report.stop).toBe('other')
    expect(report.note).toMatch(/^browser_write_needs_card/u)
  })

  it('结果只认那张卡同意过的那一次运行交的', async () => {
    const h = harness()
    await h.svc.propose()
    const res = await h.tool({
      name: 'report_google_alerts',
      input: { change_id: 'chg_1', stop: 'done', lines: [] },
      request: { actor: ACTOR } as unknown as RunRequest,
    })
    expect(res.status).toBe('error')
  })
})

describe('把已有的读进来（只读，不出改东西卡）', () => {
  it('RSS 投递的出一张勾选导入的卡，勾了就导入；邮箱投递的出「改成 RSS」卡；读的时候一个按钮都没点', async () => {
    const site = new FakeGoogleAlerts()
    site.add('"Cyrusher"', 'rss')
    site.add('"Cyrusher ebike"', 'rss')
    site.add('"Cyrusher review"', 'rss')
    site.add('"Cyrusher recall"', 'email')
    site.add('"Cyrusher Kommoda"', 'email')
    const h = harness({ site })
    const r = await h.svc.readExisting(ACTOR)
    expect(r.ok).toBe(true)
    // 等那一趟跑完
    await h.settle()
    expect(h.bsks[0]?.log.filter((c) => c.tool === 'bsk_interact')).toEqual([])
    const view = h.svc.existing()
    expect(view.importable.map((e) => e.query)).toEqual([
      '"Cyrusher"',
      '"Cyrusher ebike"',
      '"Cyrusher review"',
    ])
    expect(view.email.map((e) => e.query)).toEqual(['"Cyrusher recall"', '"Cyrusher Kommoda"'])
    expect(h.asked.map((a) => a.target)).toEqual(['pr.alerts_import'])
    expect(h.staged.map((s) => s.field)).toEqual(['to_rss'])
    // 勾选卡：三格，勾两个就导入两条（先拉一次）
    const target = h.svc.importTarget()
    const fields = await target.fields()
    expect(fields.map((f) => f.label)).toEqual([
      '"Cyrusher"',
      '"Cyrusher ebike"',
      '"Cyrusher review"',
    ])
    expect(
      fields.every((f) => f.kind === 'toggle' && !(f.placeholder ?? '').includes('feeds/0000')),
    ).toBe(true)
    await target.apply({ alert_0: 'true', alert_1: 'false', alert_2: 'true' })
    expect(h.store.sources().map((s) => s.query)).toEqual(['"Cyrusher"', '"Cyrusher review"'])
    expect(h.store.sources().every((s) => s.added_via === 'browser')).toBe(true)
    // 面板看的那一份：链接已脱敏
    const panel = h.svc.panel()
    expect(JSON.stringify(panel)).not.toContain('/alerts/feeds/00000000000000000000/')
  })
})

describe('配置卡上的「让工坊替你建」', () => {
  it('开着保存：清单存好之后马上出那张卡；浏览器没接上时默认关；没建成的那几条重新弹出来贴链接', async () => {
    const h = harness()
    const base = {
      id: 'pr.watch',
      name: '信息监控',
      why: 'x',
      fields: async () => [],
      satisfied: async () => true,
      apply: async () => undefined,
    }
    let proposed = 0
    let ready = true
    const t = withBrowserBuild(base, {
      store: () => h.store,
      browserReady: () => ready,
      propose: async () => {
        proposed += 1
        return { ok: true }
      },
    })
    expect((await t.fields()).find((f) => f.key === BUILD_TOGGLE_KEY)?.suggested).toBe('true')
    ready = false
    expect((await t.fields()).find((f) => f.key === BUILD_TOGGLE_KEY)?.suggested).toBe('false')
    await t.apply({ [BUILD_TOGGLE_KEY]: 'true' })
    expect(proposed).toBe(1)
    await t.apply({ [BUILD_TOGGLE_KEY]: 'false' })
    expect(proposed).toBe(1)
    markManualFallback(h.store, NOW, ['Aventon'])
    expect(await t.satisfied()).toBe(false)
    await t.apply({})
    expect(await t.satisfied()).toBe(true)
  })
})
