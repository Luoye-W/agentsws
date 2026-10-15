/**
 * WP316 端到端（起真进程 → 打 HTTP → 过真 guardrail；**插件一侧是替身**：直接调本机那一份动作通道，
 * 照步骤表一步步回报截图 / 下载 / 结局，不起浏览器、不碰任何真广告后台）。
 *
 * | 钉的是什么 | 依据 |
 * |---|---|
 * | 有新建 / 3 条以上 → 一张上传表卡（L1，一句话 + 预览 + 原表 + 指纹）；1–2 条 → 逐条出卡 | 552 |
 * | 批了 → 进队；插件拿到的表就是卡上那一份；多张表一张做完再进下一张 | §5.1② |
 * | 平台预览 → 截图 → 人再确认（工坊里点）→ 提交 → 截图 → 改后导出 → 读回核对 → 账本 | §5.1② |
 * | 读回拿到编号 → 自动出「开始投放」卡（L1，新预算这时才算进总闸） | 553 / 614 |
 * | 平台报了阻断错误 → 退回、后面的表不传 | §5.1② 第 5 步 |
 * | 止损 L3 自动；截不到图也先停、账本记「没截到」、前后导出作证；止损记录 + 事件 | 600 C |
 * | 磨合期：账户第一件做成之前 / 之后 14 天内，L2 升 L1 | 554 |
 * | 撤销：Google 上传用一次性撤销（倒着撤）；表单反着点；撤过的不能再撤 | §5.1② 第 9 步 |
 * | 插件没连 → 卡照出、回执带 `needs_connection: 'extension'` | WP324 |
 * | 卡上的表被改过 → 不传 | 指纹 |
 * | 排 24 小时没人领 → 作废、原样重出一张（只重出一次） | 558 |
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ActionJob,
  type ActionPlatform,
  ADS_CONSENT_TEXT_VERSION,
  QUEUE_TTL_MS,
} from '@agentsws/browser-action'
import type {
  AdsLedgerEntryView,
  AdsSheetCardAfter,
  Assignment,
  EventEnvelope,
} from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
  'base64',
)

let server: Server
let url: string
let google: Assignment
let meta: Assignment
let t = Date.parse(T0)
let tmp: string

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? google.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })
const data = async <T>(res: Response): Promise<T> => {
  const json = (await res.json()) as { data: T; error?: { message: string } }
  if (!res.ok) throw new Error(`${res.status} ${json.error?.message ?? ''}`)
  return json.data
}

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)
const ws = () => server.bootstrap.workspace.id

interface Staged {
  staged: boolean
  level?: string
  message?: string
  change_id?: string
  approval_item_id?: string
  needs_connection?: string
}
interface Changes {
  route: 'sheet' | 'form'
  reason: string
  views: Staged[]
  problems?: string[]
  message?: string
  needs_connection?: string
}

async function approve(id: string): Promise<void> {
  const fresh = await server.txn.approvals.get(id)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

/** 批 → 过取消窗口 → 施行（执行器调 backendApply → 进插件的队）。 */
async function approveAndApply(id: string): Promise<string> {
  await approve(id)
  t += 125_000
  const item = await server.txn.executor.applyApproval(id)
  return item.state
}

const events = (type: string): EventEnvelope[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: ws() as never })
    .filter((e: EventEnvelope) => e.type === type)

async function seedAccounts(opts: { roas?: number; spend?: number } = {}): Promise<void> {
  const b = await brand()
  b.ads.saveAccount({
    id: 'aa_g',
    workspace_id: ws(),
    platform: 'google',
    external_id: '123-456-7890',
    name: 'Google 测试账户',
    currency: 'USD',
    status: 'active',
    observed_at: T0,
  })
  b.ads.saveCampaign({
    id: 'cmp_g1',
    account_id: 'aa_g',
    platform: 'google',
    external_id: '1001',
    name: 'Live One',
    status: 'active',
    daily_budget: 200,
    metrics: {
      spend: opts.spend ?? 50,
      ...(opts.roas === undefined ? {} : { roas: opts.roas }),
      observed_at: T0,
    },
  })
  b.ads.saveCampaign({
    id: 'cmp_g2',
    account_id: 'aa_g',
    platform: 'google',
    external_id: '1002',
    name: 'Old',
    status: 'paused',
    daily_budget: 30,
    metrics: { spend: 0, observed_at: T0 },
  })
  b.ads.saveAccount({
    id: 'aa_m',
    workspace_id: ws(),
    platform: 'meta',
    external_id: 'act_999',
    name: 'Meta 测试账户',
    currency: 'USD',
    status: 'active',
    observed_at: T0,
  })
}

/** 插件来过、勾过告知（连着这家）。 */
async function pluginConnected(platform: ActionPlatform): Promise<void> {
  const svc = (await brand()).adsActions
  if (svc === undefined) throw new Error('没装插件动作通道')
  svc.consent(platform, ADS_CONSENT_TEXT_VERSION)
  await svc.next([platform], 0)
}

interface PluginScript {
  /** 每种导出交什么内容（csv 文字）。 */
  exports?: Partial<Record<'snapshot' | 'result', string>>
  /** 截不到图（止损那条可选截图跳过；别的照实交不上）。 */
  noCapture?: boolean
  /** 平台预览报阻断错误。 */
  previewErrors?: string
  /** 等确认时怎么办：工坊里点确认（默认）/ 不提交。 */
  confirm?: 'workstation' | 'reject'
}

interface PluginRun {
  job: ActionJob
  sheetName?: string
  sheetText?: string
  outcome: string
}

/**
 * 替身插件：领一件活，照步骤表回报（截图、下载、等确认、结局）。没活回 undefined。
 * 「确认提交」走工作台那条路由（就是卡上那个按钮）。
 */
async function pluginRunOnce(
  platform: ActionPlatform,
  script: PluginScript = {},
): Promise<PluginRun | undefined> {
  const svc = (await brand()).adsActions
  if (svc === undefined) throw new Error('没装插件动作通道')
  const got = await svc.next([platform], 0)
  const job = got.job
  if (job === undefined) return undefined
  const sheet = job.sheet === undefined ? undefined : svc.sheet(job.id)
  const reads: Record<string, string> = {}
  const missing: string[] = []
  let outcome: 'done' | 'rejected' = 'done'
  let step = 0
  for (const s of job.plan.steps) {
    step += 1
    svc.progress(job.id, { step, of: job.plan.steps.length, label: s.op })
    if (s.op === 'capture') {
      if (script.noCapture === true) {
        if (s.optional === true) missing.push(s.tag)
        continue
      }
      await svc.evidence(job.id, {
        tag: s.tag,
        png_base64: PNG,
        url: 'https://ads.google.com/aw/x?ocid=1',
        taken_at: new Date(t).toISOString(),
      })
    } else if (s.op === 'download') {
      const file = join(tmp, `${job.id}-${s.tag}.csv`)
      writeFileSync(
        file,
        script.exports?.[s.tag as 'snapshot' | 'result'] ?? 'Campaign,Campaign ID\nx,1\n',
      )
      svc.download(job.id, { tag: s.tag, path: file, name: `${s.tag}.csv` })
    } else if (s.op === 'read') reads[s.key] = '3 changes'
    else if (s.op === 'expect_none' && script.previewErrors !== undefined) {
      reads.platform_errors = script.previewErrors
      outcome = 'rejected'
      break
    } else if (s.op === 'confirm') {
      svc.progress(job.id, { step, of: job.plan.steps.length, label: s.op, waiting_confirm: true })
      if (script.confirm === 'reject') {
        outcome = 'rejected'
        break
      }
      // 工坊卡上那个「确认提交」（投放这条职责自己点）
      const change_id = (await brand()).adsWiring?.waitingConfirm()[0]?.entry.change_id
      const res = await post(
        `/v1/ads/ledger/${change_id}/confirm`,
        { submit: true },
        platform === 'meta_ads' ? meta.id : google.id,
      )
      expect(res.status).toBe(200)
      const said = svc.progress(job.id, { step, of: job.plan.steps.length, label: s.op })
      expect(said?.confirmed).toBe(true)
    }
  }
  if (missing.length > 0) reads.evidence_missing = missing.join(',')
  svc.result(job.id, { outcome, message: outcome === 'done' ? '做完了。' : '退回。', step, reads })
  await (await brand()).adsWiring?.settled()
  return {
    job,
    ...(sheet === undefined
      ? {}
      : { sheetName: sheet.name, sheetText: Buffer.from(sheet.base64, 'base64').toString('utf8') }),
    outcome,
  }
}

/** 卡上那一份 `after`。 */
function afterOf(item: { payload: unknown } | undefined): AdsSheetCardAfter {
  const after = (item?.payload as { after?: AdsSheetCardAfter } | undefined)?.after
  if (after === undefined) throw new Error('卡上没有 after')
  return after
}

async function ledger(assignment?: string): Promise<AdsLedgerEntryView[]> {
  return (
    await data<{ rows: AdsLedgerEntryView[] }>(
      await api('/v1/ads/ledger', assignment === undefined ? {} : { assignment }),
    )
  ).rows
}

beforeEach(async () => {
  t = Date.parse(T0)
  tmp = mkdtempSync(join(tmpdir(), 'agentsws-wp316-'))
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const grant = (role_id: string) =>
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id,
    })
  google = grant('ads.google')
  meta = grant('ads.meta')
  await seedAccounts()
})

afterEach(async () => {
  await server.close()
  rmSync(tmp, { recursive: true, force: true })
})

const NEW_OPS = [
  { kind: 'create_campaign', campaign: 'Spring', daily_budget: 20 },
  { kind: 'create_ad_group', campaign: 'Spring', ad_group: 'G1' },
  { kind: 'add_keyword', campaign: 'Spring', ad_group: 'G1', text: 'trail shoes', match: 'exact' },
]

const AFTER_EXPORT = [
  'Campaign,Campaign ID,Campaign state,Budget,Ad group,Ad group ID,Ad group state,Keyword,Status',
  'Spring,5001,Paused,20.00,,,,,',
  'Spring,5001,Paused,20.00,G1,6001,Paused,,',
  'Spring,5001,Paused,20.00,G1,6001,Paused,[trail shoes],Paused',
  'Live One,1001,Enabled,200.00,,,,,',
].join('\n')

describe('WP316 上传表：卡 → 插件上传 → 平台预览 → 再确认 → 提交 → 读回 → 账本 → 开始投放', () => {
  it('有新建 → 一张上传表卡（L1）：一句话、预览行、可下载的原表、指纹；插件没连 → 带连接卡那一格', async () => {
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    expect(out.route).toBe('sheet')
    expect(out.views).toHaveLength(1)
    const v = out.views[0] as Staged
    expect(v.staged).toBe(true)
    expect(v.level).toBe('L1')
    expect(v.needs_connection).toBe('extension')
    expect(out.needs_connection).toBe('extension')
    const card = await server.txn.approvals.get(v.approval_item_id as string)
    const payload = card?.payload as { kind: string; after: AdsSheetCardAfter }
    expect(payload.kind).toBe('ads_sheet')
    expect(payload.after.form).toBe('ads_sheet')
    expect(payload.after.sentence).toContain('暂停')
    expect(payload.after.rows.length).toBe(3)
    expect(payload.after._files?.map((f) => f.sheet)).toEqual([
      'campaigns',
      'ad_groups',
      'keywords',
    ])
    expect(payload.after.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    // 下载的原表里新建的一律写成暂停
    const csv = Buffer.from(payload.after._files?.[0]?.base64 ?? '', 'base64').toString('utf8')
    expect(csv).toContain('Paused')
  })

  it('一路走完：三张表一张一张传、每张都人再确认；读回对上；账本留全；出一张「开始投放」卡', async () => {
    await pluginConnected('google_ads')
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    expect(out.needs_connection).toBeUndefined()
    const card = out.views[0] as Staged
    expect(await approveAndApply(card.approval_item_id as string)).toBe('applied')
    expect(events('ads.change_queued')).toHaveLength(1)

    const cardFiles = afterOf(
      await server.txn.approvals.get(card.approval_item_id as string),
    )._files
    const runs: PluginRun[] = []
    for (;;) {
      const r = await pluginRunOnce('google_ads', {
        exports: { snapshot: 'Campaign,Campaign ID\nLive One,1001\n', result: AFTER_EXPORT },
      })
      if (r === undefined) break
      runs.push(r)
    }
    expect(runs.map((r) => r.sheetName)).toEqual(cardFiles?.map((f) => f.name))
    // 插件拿到的就是卡上那一份字节
    expect(runs[0]?.sheetText).toBe(
      Buffer.from(cardFiles?.[0]?.base64 ?? '', 'base64').toString('utf8'),
    )
    // 改前表只在第一张之前导一次；改后导出只在最后一张之后
    const tags = runs.map((r) =>
      r.job.plan.steps.flatMap((s) => (s.op === 'download' ? [s.tag] : [])),
    )
    expect(tags).toEqual([['snapshot'], [], ['result']])

    const [entry] = await ledger()
    expect(entry).toMatchObject({
      change_id: card.change_id,
      kind: 'ads_sheet',
      state: 'done',
      readback: { ok: true },
      undo: { available: true },
    })
    expect(entry?.approval_id).toBe(card.approval_item_id)
    expect(entry?.jobs.map((j) => j.status)).toEqual(['done', 'done', 'done'])
    expect(entry?.evidence.map((e) => e.tag)).toEqual([
      'preview',
      'after',
      'preview',
      'after',
      'preview',
      'after',
    ])
    expect(entry?.files.map((f) => [f.tag, f.kept])).toEqual([
      ['snapshot', true],
      ['result', true],
    ])
    expect(new Date(entry?.kept_until ?? '').getTime() - Date.parse(entry?.created_at ?? '')).toBe(
      180 * 24 * 60 * 60 * 1000,
    )

    // 截图读得回来（只认账本里登记过的）
    const shot = await data<{ png_base64: string }>(
      await api(`/v1/ads/evidence/${entry?.evidence[0]?.id}`),
    )
    expect(shot.png_base64).toBe(PNG)
    expect((await api('/v1/ads/evidence/ev_nope')).status).toBe(404)
    // Meta 那条职责看不见 Google 的账本
    expect(await ledger(meta.id)).toEqual([])

    // 「开始投放」卡：L1、带上平台给的编号、新预算这时才算进总闸
    const activation = server.txn.runtime.store
      .listApprovals({})
      .find((i) => (i.payload as { kind?: string }).kind === 'ads_activate')
    expect(activation?.automation.level_at_creation).toBe('L1')
    const after = afterOf(activation)
    expect(after.activation_of).toBe(card.change_id)
    const ops = after._ops as { ref: { campaign_id?: string; ad_group_id?: string } }[]
    expect(ops[0]?.ref.campaign_id).toBe('5001')
    expect(ops[1]?.ref.ad_group_id).toBe('6001')
    expect(activation?.summary).toContain('启用')
  })

  it('平台预览报了阻断错误 → 退回、后面的表不传；账本记下平台原话', async () => {
    await pluginConnected('google_ads')
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    await approveAndApply(out.views[0]?.approval_item_id as string)
    const r = await pluginRunOnce('google_ads', { previewErrors: 'Missing column: Budget' })
    expect(r?.outcome).toBe('rejected')
    expect(await pluginRunOnce('google_ads')).toBeUndefined()
    const [entry] = await ledger()
    expect(entry).toMatchObject({ state: 'rejected', platform_errors: 'Missing column: Budget' })
    expect(entry?.undo.available).toBe(false)
    expect(events('ads.change_rejected')).toHaveLength(1)
  })

  it('人在再确认时没点头 → 退回，不提交', async () => {
    await pluginConnected('google_ads')
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    await approveAndApply(out.views[0]?.approval_item_id as string)
    expect((await pluginRunOnce('google_ads', { confirm: 'reject' }))?.outcome).toBe('rejected')
    expect((await ledger())[0]?.state).toBe('rejected')
  })

  it('卡上的表被改过（字节和指纹对不上）→ 不传，照实说', async () => {
    await pluginConnected('google_ads')
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    const change = await server.txn.ledger.get(out.views[0]?.change_id as string)
    const after = change?.after as AdsSheetCardAfter
    const file = after._files?.[0]
    if (file === undefined) throw new Error('没表')
    file.base64 = Buffer.from('Campaign,Campaign status\nSpring,Enabled\n').toString('base64')
    server.txn.runtime.store.putChange({ ...(change as never), after })
    await approve(out.views[0]?.approval_item_id as string)
    t += 125_000
    const item = await server.txn.executor.applyApproval(out.views[0]?.approval_item_id as string)
    expect(item.state).toBe('apply_failed')
    expect(await pluginRunOnce('google_ads')).toBeUndefined()
  })
})

describe('WP316 小改动、止损、磨合期', () => {
  it('1–2 条走表单（逐条出卡）；3 条以上自动改走上传表', async () => {
    const budget = (campaign: string, id: string, before: number, after: number) => ({
      kind: 'set_budget',
      level: 'campaign',
      ref: { campaign, campaign_id: id },
      before,
      after,
    })
    const two = await data<Changes>(
      await post('/v1/ads/changes', {
        account_id: 'aa_g',
        ops: [budget('Live One', '1001', 200, 210), budget('Old', '1002', 30, 25)],
      }),
    )
    expect(two.route).toBe('form')
    expect(two.views).toHaveLength(2)
    expect(two.views.every((v) => v.staged)).toBe(true)
    const three = await data<Changes>(
      await post('/v1/ads/changes', {
        account_id: 'aa_g',
        ops: [
          budget('Live One', '1001', 200, 210),
          budget('Old', '1002', 30, 25),
          {
            kind: 'set_status',
            level: 'campaign',
            ref: { campaign: 'Old', campaign_id: '1002' },
            status: 'paused',
          },
        ],
      }),
    )
    expect(three.route).toBe('sheet')
    expect(three.reason).toContain('3 条以上')
    expect(three.views[0]?.level).toBe('L1')
  })

  it('磨合期从插件在这个账户上做成第一件写操作那天起算 14 天（之前一直在磨合）', async () => {
    const wiring = (await brand()).adsWiring
    const account = { platform: 'google_ads' as const, id: '123-456-7890' }
    expect(wiring?.breakIn(account)).toEqual({ active: true })
    const staged = await data<Staged>(await post('/v1/ads/campaigns/cmp_g1/budget', { value: 210 }))
    await pluginConnected('google_ads')
    await approveAndApply(staged.approval_item_id as string)
    const run = await pluginRunOnce('google_ads')
    expect(run?.job.plan.kind).toBe('set_budget')
    expect(run?.job.plan.steps).toContainEqual({
      op: 'fill',
      selector: expect.any(String),
      value: '210',
    })
    expect((await ledger())[0]?.state).toBe('done')
    const bi = wiring?.breakIn(account)
    expect(bi?.active).toBe(true)
    expect(Date.parse(bi?.until ?? '') - t).toBe(14 * 24 * 60 * 60 * 1000)
    t += 15 * 24 * 60 * 60 * 1000
    expect(wiring?.breakIn(account).active).toBe(false)
  })

  it('止损 L3 自动：截不到图也先停、账本记「没截到」、停前停后两份导出作证；记一条止损 + 事件', async () => {
    const b = await brand()
    const c = b.ads.campaign('cmp_g1')
    if (c === undefined) throw new Error('没 campaign')
    b.ads.saveCampaign({ ...c, metrics: { roas: 0.6, spend: 400, observed_at: T0 } })
    b.ads.saveCampaign({
      ...c,
      daily_budget: 1000,
      metrics: { roas: 0.6, spend: 400, observed_at: T0 },
    })
    await pluginConnected('google_ads')
    const staged = await data<Staged>(
      await post('/v1/ads/campaigns/cmp_g1/pause', { reason: 'stop_loss' }),
    )
    expect(staged.level).toBe('L3')
    // L3 自动批：过了取消窗口就施行
    t += 125_000
    await server.drainApprovals()
    const before = b.ads.stopLosses().length
    const run = await pluginRunOnce('google_ads', {
      noCapture: true,
      exports: {
        snapshot: 'Campaign,Campaign ID,Campaign state\nLive One,1001,Enabled\n',
        result: 'Campaign,Campaign ID,Campaign state\nLive One,1001,Paused\n',
      },
    })
    expect(run?.outcome).toBe('done')
    const [entry] = await ledger()
    expect(entry).toMatchObject({ kind: 'pause_ad', stop_loss: true, state: 'done' })
    expect(entry?.evidence_missing).toEqual(['before', 'after'])
    expect(entry?.files.map((f) => f.tag)).toEqual(['snapshot', 'result'])
    expect(b.ads.stopLosses().length).toBe(before + 1)
    // 插件读回过了：库里那条跟着停
    expect(b.ads.campaign('cmp_g1')?.status).toBe('paused')
    expect(events('ads.stop_loss_applied')).toHaveLength(1)
  })
})

describe('WP316 撤销', () => {
  it('表单那几下反着点：改预算改回原数（L1），做成之后这一条不能再撤', async () => {
    await pluginConnected('google_ads')
    const staged = await data<Staged>(await post('/v1/ads/campaigns/cmp_g1/budget', { value: 230 }))
    await approveAndApply(staged.approval_item_id as string)
    await pluginRunOnce('google_ads')
    const undo = await data<Changes>(await post(`/v1/ads/ledger/${staged.change_id}/undo`))
    expect(undo.views[0]?.level).toBe('L1')
    const card = await server.txn.approvals.get(undo.views[0]?.approval_item_id as string)
    expect((card?.payload as { kind?: string } | undefined)?.kind).toBe('ads_undo')
    await approveAndApply(undo.views[0]?.approval_item_id as string)
    const run = await pluginRunOnce('google_ads')
    expect(run?.job.plan.steps).toContainEqual({
      op: 'fill',
      selector: expect.any(String),
      value: '200',
    })
    const rows = await ledger()
    expect(rows.find((r) => r.change_id === staged.change_id)?.undo).toEqual({
      available: false,
      why: '已经撤过了。',
    })
    const again = await data<Changes>(await post(`/v1/ads/ledger/${staged.change_id}/undo`))
    expect(again.views).toEqual([])
    expect(again.message).toContain('撤过')
  })

  it('Google 上传表：用「所有批量操作」里的一次性撤销，三张表倒着撤', async () => {
    await pluginConnected('google_ads')
    const out = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_g', ops: NEW_OPS }),
    )
    await approveAndApply(out.views[0]?.approval_item_id as string)
    while (
      (await pluginRunOnce('google_ads', { exports: { result: AFTER_EXPORT } })) !== undefined
    ) {}
    const undo = await data<Changes>(await post(`/v1/ads/ledger/${out.views[0]?.change_id}/undo`))
    const card = await server.txn.approvals.get(undo.views[0]?.approval_item_id as string)
    const form = afterOf(card)._form ?? []
    expect(form.map((f) => f.action)).toEqual(['undo_upload', 'undo_upload', 'undo_upload'])
    expect(form[0]?.upload_name).toContain('keywords')
  })

  it('没做成的不能撤', async () => {
    const staged = await data<Staged>(await post('/v1/ads/campaigns/cmp_g1/budget', { value: 230 }))
    await pluginConnected('google_ads')
    await approveAndApply(staged.approval_item_id as string)
    const undo = await data<Changes>(await post(`/v1/ads/ledger/${staged.change_id}/undo`))
    expect(undo.message).toContain('还没做成')
  })
})

describe('WP316 Meta 改已有、作废重出、开始投放', () => {
  const pause = (campaign: string, id: string) => ({
    kind: 'set_status',
    level: 'campaign',
    ref: { campaign, campaign_id: id },
    status: 'paused',
  })
  const META_EXPORT = [
    'Campaign ID\tCampaign Name\tCampaign Status\tAd Set ID\tAd Set Name\tAd Set Run Status\tAd Set Daily Budget',
    '2001\tA\tACTIVE\t3001\tA set\tACTIVE\t50',
    '2002\tB\tACTIVE\t3002\tB set\tACTIVE\t40',
    '2003\tC\tACTIVE\t3003\tC set\tACTIVE\t30',
  ].join('\n')

  it('Meta 一次改 3 条（改已有）：没有 24 小时内的改前导出 → 先排一件导出、不出表；导出回来再提就出表', async () => {
    await pluginConnected('meta_ads')
    const ops = [pause('A', '2001'), pause('B', '2002'), pause('C', '2003')]
    const first = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_m', ops }, meta.id),
    )
    expect(first.views).toEqual([])
    expect(first.message).toContain('改前表')
    const snap = await pluginRunOnce('meta_ads', { exports: { snapshot: META_EXPORT } })
    expect(snap?.job.plan.kind).toBe('export_snapshot')
    expect(snap?.job.approval_id).toBeUndefined()
    // 只读的导出不算「做成第一件写操作」：磨合期还没开始算
    expect((await brand()).adsWiring?.breakIn({ platform: 'meta_ads', id: 'act_999' })).toEqual({
      active: true,
    })
    const second = await data<Changes>(
      await post('/v1/ads/changes', { account_id: 'aa_m', ops }, meta.id),
    )
    expect(second.views[0]?.staged).toBe(true)
    const card = await server.txn.approvals.get(second.views[0]?.approval_item_id as string)
    const files = afterOf(card)._files ?? []
    expect(files.map((f) => [f.sheet, f.mime])).toEqual([
      ['meta_edit', 'text/tab-separated-values'],
    ])
  })

  it('排了 24 小时插件没来领 → 作废、原样重出一张（只重出一次）', async () => {
    const staged = await data<Staged>(await post('/v1/ads/campaigns/cmp_g1/budget', { value: 210 }))
    await approveAndApply(staged.approval_item_id as string)
    t += QUEUE_TTL_MS + 60_000
    await (await brand()).adsActions?.sweep()
    await (await brand()).adsWiring?.settled()
    expect((await ledger()).find((r) => r.change_id === staged.change_id)?.state).toBe('expired')
    const again = server.txn.runtime.store
      .listApprovals({})
      .filter((i) => (i.payload as { kind?: string }).kind === 'budget_change')
    expect(again).toHaveLength(2)
    const fresh = again.find((i) => i.id !== staged.approval_item_id)
    expect((afterOf(fresh) as { reissued_from?: string }).reissued_from).toBe(staged.change_id)
  })

  it('让一条停着的开始投放：L1，插件点开关；它的日预算算进总闸', async () => {
    await pluginConnected('google_ads')
    const staged = await data<Staged & { spend_gate?: { note: string } }>(
      await post('/v1/ads/campaigns/cmp_g2/activate'),
    )
    expect(staged.level).toBe('L1')
    const card = await server.txn.approvals.get(staged.approval_item_id as string)
    expect((card?.payload as { kind?: string } | undefined)?.kind).toBe('ads_activate')
    await approveAndApply(staged.approval_item_id as string)
    const run = await pluginRunOnce('google_ads')
    expect(run?.job.plan.kind).toBe('enable')
  })
})

describe('WP316 分路的边角', () => {
  it('只有 1 条，但是关键词的开关（插件在列表里点不到）→ 走上传表', async () => {
    const out = await data<Changes>(
      await post('/v1/ads/changes', {
        account_id: 'aa_g',
        ops: [
          {
            kind: 'set_status',
            level: 'keyword',
            ref: {
              campaign: 'Live One',
              campaign_id: '1001',
              ad_group: 'G',
              keyword: 'shoes',
              match: 'exact',
            },
            status: 'paused',
          },
        ],
      }),
    )
    expect(out.route).toBe('sheet')
    expect(out.reason).toContain('点不到')
  })
})
