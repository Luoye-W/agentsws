/**
 * WP315：看数据（docs/101 §5.1①）——本机服务那一份，插件用替身（直接调动作通道的领活 / 下载 / 交回）。
 *
 * 守的是：缺账户出配置卡、缺插件出连接卡；第一次先建「工坊日报」（L3 告知卡的编号当审批编号）、建好马上导一次；
 * 每天本地 9 点后导一次、导过就不再导；下载的文件只认 CSV、读到就按天入库、「今天」那份进广告库；
 * 插件不在时读邮箱里的定时报表附件；第一次有数才种日报定时（只种一次）；查数工具的合计、总闸、止损判据。
 * 样例导出是手写的（假名字、假编号），**没打开任何真实广告后台**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionJob } from '@agentsws/browser-action'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import {
  ADS_CONSENT_TEXT_VERSION,
  type AdsActionEvent,
  createAdsActionsService,
} from '../src/ads-actions/service.js'
import { parseAdsAccountInput } from '../src/ads-data/accounts.js'
import { type AdsMail, createAdsDataService } from '../src/ads-data/service.js'
import { createAdsDataStore } from '../src/ads-data/store.js'
import { createAdsDataToolExecutor } from '../src/ads-data/tools.js'

const WS = 'ws_ads'
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'wp315', name)))

/** 本地（东八区）几点：`at('2026-10-14', 9, 30)`。 */
const at = (day: string, h: number, m = 0): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + (h - 8) * 3_600_000 + m * 60_000).toISOString()

function make(opts: { wanted?: ('google' | 'meta')[]; mails?: AdsMail[] } = {}) {
  const clock = { iso: at('2026-10-14', 8, 30) }
  const ads = createAdsStore({ workspace_id: WS as never })
  const store = createAdsDataStore({})
  const pending: Promise<void>[] = []
  const handlers: ((e: AdsActionEvent) => Promise<void>)[] = []
  const acts = createAdsActionsService({
    workspace_id: WS,
    nowMs: () => Date.parse(clock.iso),
    evidence: memoryEvidenceStore({ nowMs: () => Date.parse(clock.iso) }),
    onEvent: (e) => {
      for (const h of handlers) pending.push(h(e))
    },
    wait: async (_ms, woke) => woke,
  })
  const files = new Map<string, Uint8Array>()
  const notices: { platform: string; title: string }[] = []
  const seeds: number[] = []
  const attachments = new Map<string, Uint8Array>()
  let n = 0
  const svc = createAdsDataService({
    workspace_id: WS,
    store,
    ads,
    now: () => clock.iso,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    wanted: () => opts.wanted ?? ['google'],
    actions: () => acts,
    notice: async (i) => {
      notices.push(i)
      return `notice_${notices.length}`
    },
    readFile: async (p) => {
      const f = files.get(p)
      if (f === undefined) throw new Error('no file')
      return f
    },
    mail: () => ({
      recent: async () => opts.mails ?? [],
      attachment: async (m, a) => attachments.get(`${m}/${a}`),
    }),
    seedDailyReport: async () => {
      seeds.push(1)
      return { task_id: 'sched_auto_1', matter_id: 'mt_1' }
    },
    // 「现在导一次」等插件时每一拍让出去（测试里插件替身趁这时来领活）
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  })
  handlers.push((e) => svc.onActionEvent(e))
  const flush = async (): Promise<void> => {
    while (pending.length > 0) await pending.shift()
  }
  /** 插件替身：领一件活、按给的文件下载、交回。 */
  const plugin = {
    connect(platform: 'google_ads' | 'meta_ads') {
      acts.consent(platform, ADS_CONSENT_TEXT_VERSION)
    },
    async claim(platform: 'google_ads' | 'meta_ads'): Promise<ActionJob | undefined> {
      return (await acts.next([platform], 0)).job
    },
    async finish(job: ActionJob, got: string[] = [], outcome: 'done' | 'handover' = 'done') {
      for (const name of got) {
        const path = `/Users/x/Downloads/${name}`
        files.set(path, fixture(name))
        acts.download(job.id, { tag: 'report', path, name })
        await flush()
      }
      acts.result(job.id, {
        outcome,
        message: outcome === 'done' ? '做完了' : '页面对不上',
        step: 3,
        reads: {},
      })
      await flush()
    },
  }
  return { svc, acts, ads, store, clock, plugin, notices, seeds, files, attachments, flush }
}

describe('账户：贴网址或填编号', () => {
  it('Google 认 __c 与 ocid；Meta 认 act；认不出不猜', () => {
    expect(
      parseAdsAccountInput(
        'google',
        'https://ads.google.com/aw/overview?ocid=42&__c=1234567890&x=1',
      ),
    ).toEqual({ id: '1234567890', ocid: '42' })
    expect(parseAdsAccountInput('google', '123-456-7890')).toEqual({ id: '1234567890' })
    expect(parseAdsAccountInput('google', '12345')).toBeUndefined()
    expect(
      parseAdsAccountInput(
        'meta',
        'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=999888777',
      ),
    ).toEqual({ id: '999888777' })
    expect(parseAdsAccountInput('meta', 'act_999888777')).toEqual({ id: '999888777' })
  })

  it('配置卡：只问担着的那几家；存进去就算设好', async () => {
    const { svc } = make({ wanted: ['google', 'meta'] })
    const target = svc.setupTarget()
    expect((await target.fields()).map((f) => f.key)).toEqual(['google', 'meta'])
    expect(await target.satisfied()).toBe(false)
    await expect(target.apply({ google: 'abc' })).rejects.toThrow('认不出来')
    await target.apply({ google: '123-456-7890' })
    expect(await target.satisfied()).toBe(true)
    expect(svc.accounts()).toEqual({ google: { id: '1234567890' } })
  })
})

describe('建「工坊日报」→ 马上导一次 → 每天 9 点后一次', () => {
  it('没设账户：一拍什么都不做', async () => {
    const { svc } = make()
    expect(await svc.tick()).toEqual({ queued: [], imported: 0, skipped: 'no_account' })
  })

  it('插件没连这家后台：不排活（等人连）；连上之后先建报表，告知卡的编号就是审批编号', async () => {
    const { svc, acts, plugin, notices } = make()
    svc.setAccounts({ google: { id: '1234567890', ocid: '42' } })
    expect((await svc.tick()).queued).toEqual([])
    plugin.connect('google_ads')
    const out = await svc.tick()
    expect(out.queued).toHaveLength(1)
    expect(notices[0]?.title).toContain('工坊日报')
    const view = acts.jobs()[0]
    expect(view).toMatchObject({ kind: 'setup_daily_report', approval_id: 'notice_1' })
    // 还在排着：下一拍不重复排
    expect((await svc.tick()).queued).toEqual([])
  })

  it('建好了马上导一次；下载的几份按天入库，「今天」那份进广告库；第一次有数种一次日报定时', async () => {
    const { svc, acts, ads, plugin, seeds, clock } = make()
    svc.setAccounts({ google: { id: '1234567890' } })
    plugin.connect('google_ads')
    await svc.tick()
    const setup = await plugin.claim('google_ads')
    expect(setup?.plan.kind).toBe('setup_daily_report')
    await plugin.finish(setup as ActionJob)
    expect(svc.status()[0]).toMatchObject({ setup: 'done', plugin: 'ready' })
    const exp = await plugin.claim('google_ads')
    expect(exp?.plan.kind).toBe('export_daily_report')
    expect(exp?.approval_id).toBeUndefined()
    await plugin.finish(exp as ActionJob, ['google-campaign.csv', 'google-search-terms.csv'])
    expect(acts.jobs()[0]?.status).toBe('done')
    const st = svc.status()[0]
    expect(st?.last_import).toMatchObject({ source: 'plugin', days: ['2026-10-14'] })
    expect(st?.message).toBeUndefined()
    expect(seeds).toEqual([1])
    const spring = ads.campaign('google:1234567890:111')
    expect(spring).toMatchObject({
      name: 'Spring Sale',
      status: 'active',
      daily_budget: 200,
      metrics: { spend: 90, clicks: 30, roas: 0 },
    })
    // 表里是 `--`：没数就是没数，不补 0
    expect(ads.campaign('google:1234567890:112')).toMatchObject({ status: 'paused' })
    expect(ads.campaign('google:1234567890:112')?.metrics?.spend).toBeUndefined()
    expect(ads.account('google:1234567890')).toMatchObject({ spend_today: 90, currency: 'USD' })
    // 同一天晚上 10 点以后：导过了，不再导（白天每 3 小时加导见 wp420-ads-stop-loss）；明天 8 点不到也不导；9 点后导
    clock.iso = at('2026-10-14', 23)
    expect((await svc.tick()).queued).toEqual([])
    clock.iso = at('2026-10-15', 8, 10)
    expect((await svc.tick()).queued).toEqual([])
    clock.iso = at('2026-10-15', 9, 5)
    expect((await svc.tick()).queued).toHaveLength(1)
    // 日报定时只种一次
    const next = await plugin.claim('google_ads')
    await plugin.finish(next as ActionJob, ['google-campaign.csv'])
    expect(seeds).toEqual([1])
  })

  it('下载的不是 CSV / 报表被删了：照实记一句，不入库（日报定时照种——WP420 A9：有人担投放就种）', async () => {
    const { svc, plugin, seeds, acts, files, flush } = make()
    svc.setAccounts({ google: { id: '1234567890' } })
    plugin.connect('google_ads')
    await svc.tick()
    await plugin.finish((await plugin.claim('google_ads')) as ActionJob)
    const exp = (await plugin.claim('google_ads')) as ActionJob
    files.set('/x/report.pdf', new Uint8Array([1]))
    acts.download(exp.id, { tag: 'report', path: '/x/report.pdf', name: 'report.pdf' })
    await flush()
    await plugin.finish(exp, [], 'handover')
    expect(svc.status()[0]?.message).toContain('不是 CSV')
    expect(svc.status()[0]?.last_import).toBeUndefined()
    expect(seeds).toEqual([1])
  })

  it('排了一天没人领（Chrome 没开）：作废、照实说；隔一小时再排', async () => {
    const { svc, acts, plugin, clock } = make()
    svc.setAccounts({ google: { id: '1234567890' } })
    plugin.connect('google_ads')
    await svc.tick()
    await plugin.finish((await plugin.claim('google_ads')) as ActionJob)
    clock.iso = at('2026-10-15', 9, 0)
    await acts.sweep()
    await new Promise((r) => setTimeout(r, 0))
    expect(svc.status()[0]?.message).toContain('没人领')
    expect((await svc.tick()).queued).toHaveLength(1)
  })
})

describe('备用：邮箱里的定时报表', () => {
  const mail = (id: string, from: string, subject: string, files: string[]): AdsMail => ({
    id,
    from,
    subject,
    date: at('2026-10-14', 7),
    attachments: files.map((name, i) => ({ id: `a${i}`, name, mime: 'text/csv', size: 100 })),
  })

  it('插件没连：读平台发来的 CSV 附件入库（读过的不再读）；只给链接的照实说', async () => {
    const mails = [
      mail('m1', 'ads-noreply@google.com', 'Your scheduled report', ['google-campaign.csv']),
      mail('m2', 'no-reply@shop.example', 'report', ['other.csv']),
      mail('m3', 'notification@facebookmail.com', 'Scheduled report: 工坊日报', []),
    ]
    const { svc, attachments, seeds } = make({ wanted: ['google', 'meta'], mails })
    attachments.set('m1/a0', fixture('google-campaign.csv'))
    attachments.set('m2/a0', fixture('meta-ads.csv'))
    svc.setAccounts({ google: { id: '1234567890' }, meta: { id: '999' } })
    const out = await svc.tick()
    expect(out.imported).toBe(1)
    const [g, m] = svc.status()
    expect(g?.last_import?.source).toBe('email')
    expect(m?.last_import).toBeUndefined()
    expect(m?.message).toContain('没有 CSV 附件')
    expect(seeds).toEqual([1])
    expect((await svc.tick()).imported).toBe(0)
  })

  it('平台对不上（让读 Google 却是 Meta 的表）：不入库', () => {
    const { svc } = make()
    const out = svc.ingest({
      bytes: fixture('meta-ads.csv'),
      name: 'x.csv',
      platform: 'google',
      source: 'manual',
    })
    expect(out).toEqual({ ok: false, message: expect.stringContaining('Meta') })
  })
})

describe('三个工具', () => {
  const req = (role_id = 'ads.google') =>
    ({
      id: 'run_1',
      workspace_id: WS,
      actor: { person_id: 'p_1', assignment_id: 'as_1', role_id },
    }) as never
  function tools(h: ReturnType<typeof make>) {
    const paused: { id: string; reason: string }[] = []
    const exec = createAdsDataToolExecutor({
      service: () => h.svc,
      ads: () => h.ads,
      port: () =>
        ({
          pauseCampaign: async (_a: unknown, id: string, input: { reason: string }) => {
            paused.push({ id, reason: input.reason })
            return { staged: true, approval_item_id: 'ap_1', level: 'L3' }
          },
        }) as never,
      caps: () => ({ max_daily_spend: 1000 }),
    })
    const call = async (name: string, input: Record<string, unknown> = {}, role?: string) =>
      (await exec({ name, input, request: req(role) })) as {
        status: string
        data: Record<string, unknown>
      }
    return { call, paused }
  }

  it('只给投放职责；没设账户 → 配置卡；插件没连 → 连接卡', async () => {
    const h = make()
    const { call } = tools(h)
    expect((await call('query_ads_data', {}, 'social.reddit')).status).toBe('blocked')
    expect((await call('query_ads_data')).data.needs_setup).toBe('ads.accounts')
    h.svc.setAccounts({ google: { id: '1234567890' } })
    expect((await call('query_ads_data')).data.needs_connection).toBe('extension')
    expect((await call('fetch_ads_data_now')).data.needs_connection).toBe('extension')
  })

  it('能直接出卡就出「插件连上广告后台」那张（kind ads_backend）；连上了复查认得出', async () => {
    const h = make()
    h.svc.setAccounts({ google: { id: '1234567890' } })
    const asked: string[] = []
    const exec = createAdsDataToolExecutor({
      service: () => h.svc,
      ads: () => h.ads,
      port: () => undefined,
      caps: () => ({}),
      askConnect: async (_req, why) => {
        asked.push(why)
        return true
      },
    })
    const out = (await exec({ name: 'query_ads_data', input: {}, request: req() })) as {
      data: Record<string, unknown>
    }
    expect(out.data).toMatchObject({ connection_card: true })
    expect(out.data.needs_connection).toBeUndefined()
    expect(asked[0]).toContain('插件')
    expect(h.svc.backendReady()).toBe(false)
    h.plugin.connect('google_ads')
    expect(h.svc.backendReady()).toBe(true)
  })

  it('查数：合计、按天、按花费排、总闸还剩多少、止损判据；再按判据提止损卡', async () => {
    const h = make()
    h.svc.setAccounts({ google: { id: '1234567890' } })
    h.svc.ingest({
      bytes: fixture('google-campaign.csv'),
      name: 'c.csv',
      platform: 'google',
      source: 'manual',
    })
    h.svc.ingest({
      bytes: fixture('google-search-terms.csv'),
      name: 's.csv',
      platform: 'google',
      source: 'manual',
    })
    const { call, paused } = tools(h)
    const res = (await call('query_ads_data', { period: 'last_7_days' })).data
    expect(res.totals).toEqual([
      {
        platform: 'google',
        currency: 'USD',
        metrics: expect.objectContaining({ cost: 1140, roas: 1.84 }),
      },
    ])
    expect((res.by_day as { day: string }[]).map((d) => d.day)).toEqual([
      '2026-10-13',
      '2026-10-14',
    ])
    expect((res.rows as { name: string }[]).map((r) => r.name)).toEqual([
      'Spring Sale',
      'Brand Search',
    ])
    expect(res.spend_gate).toMatchObject({ cap: 1000, spent: 90, remaining: 910 })
    const stop = res.stop_loss as { campaign_id: string; outcome: string; reason: string }[]
    expect(stop[0]).toMatchObject({ campaign_id: 'google:1234567890:111', outcome: 'trigger' })
    const terms = (
      await call('query_ads_data', { period: 'today', level: 'search_term', sort: 'cost' })
    ).data
    expect((terms.rows as { name: string }[]).map((r) => r.name)).toEqual([
      'magnet toys for kids',
      'magnetic tiles',
    ])
    const staged = await call('stage_ads_stop_loss', { campaign_id: 'google:1234567890:111' })
    expect(staged.data).toMatchObject({ ok: true, approval_item_id: 'ap_1' })
    expect(paused).toEqual([{ id: 'google:1234567890:111', reason: 'stop_loss' }])
    expect((await call('stage_ads_stop_loss', { campaign_id: 'nope' })).data.ok).toBe(false)
  })

  it('现在导一次：排上、插件做完就回「导进来了」', async () => {
    const h = make()
    h.svc.setAccounts({ google: { id: '1234567890' } })
    h.plugin.connect('google_ads')
    await h.svc.tick()
    await h.plugin.finish((await h.plugin.claim('google_ads')) as ActionJob)
    const { call } = tools(h)
    const pending = call('fetch_ads_data_now', { platform: 'google' })
    // 工具在等的时候插件来领、交回
    await new Promise((r) => setTimeout(r, 0))
    const job = await h.plugin.claim('google_ads')
    expect(job?.plan.kind).toBe('export_daily_report')
    await h.plugin.finish(job as ActionJob, ['google-campaign.csv'])
    const out = (await pending).data
    expect(out.outcomes).toEqual([expect.objectContaining({ ok: true, status: 'imported' })])
  })
})
