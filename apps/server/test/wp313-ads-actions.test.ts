/**
 * WP313：本机服务那一份插件动作通道（每品牌一份）。
 *
 * 守的是：进队要过审批编号 / 指纹 / 「默认不碰」开关；没同意过的那家不发活；长轮询有活就醒；
 * 截图只收 PNG、存 180 天、到期按索引点名删；24 小时没人领作废并告诉上层；重启后排队还在。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AdsAction,
  buildAdsJob,
  QUEUE_TTL_MS,
  sheetFingerprint,
} from '@agentsws/browser-action'
import { afterEach, describe, expect, it } from 'vitest'
import { fileEvidenceStore, memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import {
  ADS_CONSENT_TEXT_VERSION,
  type AdsActionEvent,
  createAdsActionsService,
} from '../src/ads-actions/service.js'

const WS = 'ws_ads'
const T0 = Date.parse('2026-10-14T09:00:00.000Z')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
  'base64',
)
const SHEET = new TextEncoder().encode('Campaign,Status\nSpring,Paused\n')

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-wp313-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function make(options: { dir?: string; now?: { ms: number } } = {}) {
  const now = options.now ?? { ms: T0 }
  const events: AdsActionEvent[] = []
  const svc = createAdsActionsService({
    workspace_id: WS,
    ...(options.dir === undefined ? {} : { dir: options.dir }),
    nowMs: () => now.ms,
    evidence:
      options.dir === undefined
        ? memoryEvidenceStore({ nowMs: () => now.ms })
        : fileEvidenceStore({ dir: join(options.dir, 'evidence'), nowMs: () => now.ms }),
    onEvent: (e) => events.push(e),
    wait: async (_ms, woke) => woke,
  })
  return { svc, events, now }
}

const google = { platform: 'google_ads' as const, id: '123-456-7890' }

function job(id: string, action: AdsAction, over: Record<string, unknown> = {}) {
  return buildAdsJob({
    id,
    workspace_id: WS,
    account: google,
    action,
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    created_at: new Date(T0).toISOString(),
    ...over,
  })
}

const pause: AdsAction = { kind: 'pause', entity: { level: 'campaign', id: '1' } }

async function uploadJob(id = 'up') {
  const fp = await sheetFingerprint(SHEET)
  return job(id, {
    kind: 'upload_sheet',
    sheet: { name: 'u.csv', mime: 'text/csv', fingerprint: fp, bytes: SHEET.length },
  })
}

describe('进队', () => {
  it('上传表的指纹对不上不进；对上了插件能按 id 取回原样字节', async () => {
    const { svc } = make()
    const j = await uploadJob()
    expect(await svc.enqueue(j, new TextEncoder().encode('tampered'))).toMatchObject({ ok: false })
    expect(await svc.enqueue(j)).toMatchObject({ ok: false })
    expect(await svc.enqueue(j, SHEET)).toMatchObject({ ok: true })
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    const got = await svc.next(['google_ads'], 0)
    expect(got.job?.id).toBe('up')
    const sheet = svc.sheet('up')
    expect(Buffer.from(sheet?.base64 ?? '', 'base64').toString()).toBe(
      'Campaign,Status\nSpring,Paused\n',
    )
    expect(sheet?.fingerprint).toBe(j.sheet?.fingerprint)
  })

  it('要进「默认不碰」区域：没放开不进；放开了还要 L1；进了就写进 zones_allowed', async () => {
    const { svc } = make()
    const j = job('del', pause)
    j.plan.zones = ['delete_campaign']
    expect(await svc.enqueue(j)).toMatchObject({
      ok: false,
      why: expect.stringContaining('默认不碰'),
    })
    svc.setZone('delete_campaign', true)
    expect(await svc.enqueue({ ...j, approval_level: 'L2' })).toMatchObject({ ok: false })
    expect(await svc.enqueue(j)).toMatchObject({ ok: true })
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    expect((await svc.next(['google_ads'], 0)).job?.zones_allowed).toEqual(['delete_campaign'])
  })

  it('别的品牌的活不进', async () => {
    const { svc } = make()
    expect(await svc.enqueue({ ...job('x', pause), workspace_id: 'ws_other' })).toMatchObject({
      ok: false,
    })
  })
})

describe('领活', () => {
  it('没同意过（或告知文案改版了）的那家不发活，回执里如实说', async () => {
    const { svc } = make()
    await svc.enqueue(job('a', pause))
    expect(await svc.next(['google_ads'], 0)).toMatchObject({ needs_consent: ['google_ads'] })
    svc.consent('google_ads', 'old-version')
    expect((await svc.next(['google_ads'], 0)).job).toBeUndefined()
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    expect((await svc.next(['google_ads'], 0)).job?.id).toBe('a')
    svc.revokeConsent('google_ads')
    expect(svc.settings().consent.google_ads).toBeUndefined()
  })

  it('长轮询：挂着的时候进了一件，当场醒、领走', async () => {
    const { svc } = make()
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    const pending = svc.next(['google_ads'], 25_000)
    await svc.enqueue(job('late', pause))
    expect((await pending).job?.id).toBe('late')
  })

  it('同一账户一次一件：上一件回了结局才领下一件；结局告诉上层', async () => {
    const { svc, events } = make()
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    await svc.enqueue(job('a', pause))
    await svc.enqueue(job('b', pause))
    expect((await svc.next(['google_ads'], 0)).job?.id).toBe('a')
    expect((await svc.next(['google_ads'], 0)).job).toBeUndefined()
    expect(svc.jobs().find((j) => j.id === 'b')?.waiting).toContain('一次只做一件')
    svc.result('a', { outcome: 'done', message: '做完了', step: 6, reads: {} })
    expect(events.map((e) => e.type)).toEqual(['finished'])
    expect((await svc.next(['google_ads'], 0)).job?.id).toBe('b')
  })

  it('排了 24 小时没人领 → 作废，告诉上层重出卡', async () => {
    const { svc, events, now } = make()
    await svc.enqueue(job('a', pause))
    now.ms += QUEUE_TTL_MS
    await svc.sweep()
    expect(events).toEqual([expect.objectContaining({ type: 'expired' })])
    expect(svc.jobs()[0]?.status).toBe('expired')
  })

  it('停：工作台点停 → 进度回执带回 stop', async () => {
    const { svc } = make()
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    await svc.enqueue(job('a', pause))
    await svc.next(['google_ads'], 0)
    svc.stop('a')
    expect(svc.progress('a', { step: 2, of: 6, label: '点按钮' })).toEqual({
      stop: true,
      confirmed: false,
    })
  })
})

describe('截图与下载', () => {
  it('只收 PNG；存 180 天；到期按索引点名删', async () => {
    const dir = tmp()
    const { svc, now } = make({ dir })
    svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    await svc.enqueue(job('a', pause))
    await svc.next(['google_ads'], 0)
    expect(
      await svc.evidence('a', {
        tag: 'before',
        png_base64: Buffer.from('not png').toString('base64'),
        url: 'x',
        taken_at: 'x',
      }),
    ).toBeUndefined()
    const got = await svc.evidence('a', {
      tag: 'before',
      png_base64: PNG,
      url: 'https://ads.google.com/aw/campaigns?__c=123&secret=1',
      taken_at: new Date(T0).toISOString(),
    })
    expect(got?.kept_until).toBe(new Date(T0 + 180 * 86_400_000).toISOString())
    const monthDir = join(dir, 'evidence', '2026-10')
    expect(readdirSync(monthDir)).toHaveLength(1)
    // 留存时间没到：不删
    await svc.sweep()
    expect(readdirSync(monthDir)).toHaveLength(1)
    now.ms += 181 * 86_400_000
    await svc.sweep()
    expect(readdirSync(monthDir)).toHaveLength(0)
  })

  it('下载记下存在哪；重启之后排队、开关、同意、下载记录都还在', async () => {
    const dir = tmp()
    const first = make({ dir })
    first.svc.consent('google_ads', ADS_CONSENT_TEXT_VERSION)
    first.svc.setZone('billing', true)
    await first.svc.enqueue(job('a', { kind: 'export_report' }))
    await first.svc.enqueue(await uploadJob('u'), SHEET)
    await first.svc.next(['google_ads'], 0)
    first.svc.download('a', {
      tag: 'report',
      path: '/Users/x/Downloads/report.csv',
      name: 'report.csv',
    })
    expect(existsSync(join(dir, 'sheets', 'u.bin'))).toBe(true)
    first.svc.close()

    const again = make({ dir, now: first.now })
    expect(again.svc.settings().zones.billing).toBe(true)
    expect(again.svc.settings().consent.google_ads?.text_version).toBe(ADS_CONSENT_TEXT_VERSION)
    expect(again.svc.downloads('a')[0]?.path).toBe('/Users/x/Downloads/report.csv')
    expect(
      again.svc
        .jobs()
        .map((j) => j.status)
        .sort(),
    ).toEqual(['queued', 'running'])
    // 做完了，上传表原样字节就删掉
    again.svc.result('a', { outcome: 'done', message: 'ok', step: 2, reads: {} })
    await again.svc.next(['google_ads'], 0)
    again.svc.result('u', { outcome: 'rejected', message: '平台报错', step: 9, reads: {} })
    expect(existsSync(join(dir, 'sheets', 'u.bin'))).toBe(false)
  })
})
