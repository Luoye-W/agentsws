/**
 * WP313：插件这一侧的广告动作通道（假后台 + 假本机服务，不联网、不碰真站）。
 *
 * 守的是：横条看得见、停得住；截图只截后台那个标签页、截不到就停；截图交不上去就不往下做；
 * 平台预览之后要人再确认（横条或工坊卡都算）；没配对 / 没连后台不去问活；问到的活做完回结局。
 */
import { buildAdsJob, sheetFingerprint } from '@agentsws/browser-action'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { renderBanner } from '../src/lib/ads/banner'
import { ADS_CONSENT_TEXT_VERSION } from '../src/lib/ads/broker'
import { executeJob, type RunControl } from '../src/lib/ads/executor'
import { connectedPlatforms, type PermissionsLike, removeAds } from '../src/lib/ads/permissions'
import { pollAdsOnce, readAdsStatus } from '../src/lib/ads/poller'
import { TabPage } from '../src/lib/ads/tab-page'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'
import { FakeTab, fakeLocal } from './ads-fakes'

const NOW = '2026-10-14T09:00:00.000Z'
const google = { platform: 'google_ads' as const, id: '123-456-7890', ocid: '42' }
const SHEET = 'Campaign,Status\nSpring,Paused\n'
const SHEET_B64 = btoa(SHEET)

const pauseJob = () =>
  buildAdsJob({
    id: 'job_p',
    workspace_id: 'ws',
    account: google,
    action: { kind: 'pause', entity: { level: 'campaign', id: '111', name: '春季' } },
    approval_id: 'ap_1',
    created_at: NOW,
  })

async function uploadJob() {
  return buildAdsJob({
    id: 'job_u',
    workspace_id: 'ws',
    account: google,
    action: {
      kind: 'upload_sheet',
      sheet: {
        name: 'u.csv',
        mime: 'text/csv',
        fingerprint: await sheetFingerprint(SHEET),
        bytes: SHEET.length,
      },
    },
    approval_id: 'ap_2',
    approval_level: 'L1',
    created_at: NOW,
  })
}

const client = (fetch: typeof globalThis.fetch) => ({ port: 4399, token: 'ext_t', fetch })

function perms(granted: string[]): PermissionsLike & { removed: unknown[] } {
  const removed: unknown[] = []
  return {
    removed,
    contains: async (p) =>
      (p.origins ?? []).every((o) => granted.includes(o)) &&
      (p.permissions ?? []).every((x) => granted.includes(x)),
    request: async () => true,
    remove: async (p) => {
      removed.push(p)
      for (const o of [...(p.origins ?? []), ...(p.permissions ?? [])]) {
        const i = granted.indexOf(o)
        if (i >= 0) granted.splice(i, 1)
      }
      return true
    },
  }
}

function click(root: ShadowRoot | null | undefined, selector: string): void {
  const el = root?.querySelector<HTMLElement>(selector)
  if (el === null || el === undefined) throw new Error(`没有 ${selector}`)
  el.click()
}

describe('横条', () => {
  it('看得见、停得住；要确认时多两个按钮；做完整条拿掉', () => {
    const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document
    const seen: string[] = []
    const h = { onStop: () => seen.push('stop'), onConfirm: (a: string) => seen.push(a) }
    renderBanner(doc, { title: '暂停「春季」', step: 3, of: 7, label: '点按钮' }, h)
    const root = doc.getElementById('agentsws-ads-banner')?.shadowRoot
    expect(root?.querySelector('.text')?.textContent).toBe('AI 正在操作 · 3/7 · 点按钮')
    click(root, '[data-testid="ads-banner-stop"]')
    renderBanner(doc, { title: 't', step: 9, of: 12, label: '等你确认', confirm: '确认提交？' }, h)
    const root2 = doc.getElementById('agentsws-ads-banner')?.shadowRoot
    click(root2, '[data-testid="ads-banner-yes"]')
    click(root2, '[data-testid="ads-banner-no"]')
    expect(seen).toEqual(['stop', 'yes', 'no'])
    expect(doc.querySelectorAll('#agentsws-ads-banner')).toHaveLength(1)
    renderBanner(doc, null, h)
    expect(doc.getElementById('agentsws-ads-banner')).toBeNull()
  })
})

describe('标签页那只手', () => {
  it('换页后把页面脚本重新放进去、横条重画', async () => {
    const tab = new FakeTab()
    const page = new TabPage({
      driver: tab.driver(),
      hosts: ['ads.google.com'],
      bannerState: () => null,
    })
    await page.goto('https://ads.google.com/aw/campaigns?campaignId=111')
    expect(tab.injected).toBe(1)
    expect(await page.count('[data-row-id="111"]')).toBe(1)
  })

  it('截图：页面不在后台不截；没切到前台先切；截不到照实说；截时横条先藏', async () => {
    const tab = new FakeTab()
    const page = new TabPage({
      driver: tab.driver(),
      hosts: ['ads.google.com'],
      bannerState: () => ({ title: 't', step: 1, of: 2, label: 'x' }),
    })
    tab.active = false
    expect((await page.capture()).ok).toBe(true)
    expect(tab.active).toBe(true)
    expect(tab.banners.slice(-2).map((b) => b?.hidden === true)).toEqual([true, false])
    tab.captureThrows = true
    const denied = await page.capture()
    expect(denied).toMatchObject({ ok: false, why: expect.stringContaining('插件图标') })
    tab.load('https://evil.example.com/')
    expect(await page.capture()).toMatchObject({ ok: false })
  })

  it('下载：没有下载权限照实说', async () => {
    const tab = new FakeTab()
    tab.downloads = false
    const page = new TabPage({
      driver: tab.driver(),
      hosts: ['ads.google.com'],
      bannerState: () => null,
    })
    expect(await page.download('[aria-label="Download"]')).toMatchObject({ ok: false })
  })
})

describe('跑一件活', () => {
  it('暂停：前后截图交给本机，读回对上，回结局', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({})
    const control: RunControl = { stop: false }
    const out = await executeJob(pauseJob(), {
      client: client(local.fetch),
      driver: tab.driver(),
      control,
      now: () => NOW,
      sleep: async () => {},
      gapMs: 0,
    })
    expect(out.outcome).toBe('done')
    expect(tab.state.status['111']).toBe('Paused')
    const paths = local.calls.map((c) => c.path)
    expect(paths.filter((p) => p.endsWith('/evidence'))).toHaveLength(2)
    expect(paths.at(-1)).toBe('/v1/extension/actions/job_p/result')
    expect(tab.banners.at(-1)).toBeNull()
  })

  it('上传：拿表、放进上传框、预览截图，横条上点「确认提交」才应用', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({
      sheet: {
        name: 'u.csv',
        mime: 'text/csv',
        base64: SHEET_B64,
        fingerprint: await sheetFingerprint(SHEET),
      },
    })
    const control: RunControl = { stop: false }
    let waits = 0
    const out = await executeJob(await uploadJob(), {
      client: client(local.fetch),
      driver: tab.driver(),
      control,
      now: () => NOW,
      sleep: async () => {
        // 等确认的时候，用户在横条上点了「确认提交」
        if (tab.banners.at(-1)?.confirm !== undefined && ++waits === 2) control.answer = 'yes'
      },
      gapMs: 0,
    })
    expect(out.outcome).toBe('done')
    expect(tab.state.uploadedName).toBe('u.csv')
    expect(tab.state.applied).toBe(true)
    const progress = local.calls.filter((c) => c.path.endsWith('/progress'))
    expect(
      progress.some((c) => (c.body as { waiting_confirm?: boolean }).waiting_confirm === true),
    ).toBe(true)
    expect(local.calls.filter((c) => c.path.endsWith('/download'))).toHaveLength(1)
  })

  it('工坊卡上点了确认（进度回执带回来）也算', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({
      confirmed: true,
      sheet: {
        name: 'u.csv',
        mime: 'text/csv',
        base64: SHEET_B64,
        fingerprint: await sheetFingerprint(SHEET),
      },
    })
    const out = await executeJob(await uploadJob(), {
      client: client(local.fetch),
      driver: tab.driver(),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      gapMs: 0,
    })
    expect(out.outcome).toBe('done')
  })

  it('截图交不上去 → 不往下做（留不下证据的改动不做）', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({ evidenceFails: true })
    const out = await executeJob(pauseJob(), {
      client: client(local.fetch),
      driver: tab.driver(),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      gapMs: 0,
    })
    expect(out.outcome).toBe('failed')
    expect(tab.state.status['111']).toBe('Enabled')
  })

  it('工作台点了停 → 下一步之前停', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({ stop: true })
    const out = await executeJob(pauseJob(), {
      client: client(local.fetch),
      driver: tab.driver(),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      gapMs: 0,
    })
    expect(out.outcome).toBe('stopped')
    expect(tab.state.status['111']).toBe('Enabled')
  })
})

describe('问活', () => {
  const paired = () => memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' } })
  const GOOGLE = ['https://ads.google.com/*', 'downloads']

  it('没配对、没连后台都不去问', async () => {
    const local = fakeLocal({ job: pauseJob() })
    const base = {
      fetch: local.fetch,
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
    }
    const openTab = async () => new FakeTab().driver()
    expect(
      await pollAdsOnce({ ...base, store: memoryStore(), perms: perms(GOOGLE), openTab }),
    ).toBe('unpaired')
    expect(await pollAdsOnce({ ...base, store: paired(), perms: perms([]), openTab })).toBe(
      'no_platform',
    )
    expect(local.calls).toEqual([])
  })

  it('问到一件就做、做完接着问；状态写给设置页', async () => {
    const tab = new FakeTab()
    const local = fakeLocal({ job: pauseJob(), needsConsent: ['meta_ads'] })
    const store = paired()
    const out = await pollAdsOnce({
      store,
      perms: perms(GOOGLE),
      fetch: local.fetch,
      openTab: async () => tab.driver(),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
      gapMs: 0,
    })
    expect(out).toBe('ran')
    expect(local.calls[0]?.path).toBe('/v1/extension/actions/next')
    expect(tab.state.status['111']).toBe('Paused')
    const s = await readAdsStatus(store)
    expect(s.last_result).toMatchObject({ outcome: 'done', title: '暂停「春季」' })
    expect(s.needs_consent).toEqual(['meta_ads'])
    expect(s.running).toBeUndefined()
  })

  it('找不到标签页 → 回「交给人」', async () => {
    const local = fakeLocal({ job: pauseJob() })
    await pollAdsOnce({
      store: paired(),
      perms: perms(GOOGLE),
      fetch: local.fetch,
      openTab: async () => ({ why: '没能打开广告后台的标签页。' }),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
    })
    const result = local.calls.find((c) => c.path.endsWith('/result'))
    expect(result?.body).toMatchObject({ outcome: 'handover' })
  })

  it('应用没开：照实记下，不排队、不重试', async () => {
    const store = paired()
    const out = await pollAdsOnce({
      store,
      perms: perms(GOOGLE),
      fetch: fakeLocal({ down: true }).fetch,
      openTab: async () => new FakeTab().driver(),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
    })
    expect(out).toBe('offline')
    expect((await readAdsStatus(store)).note).toContain('没在运行')
  })
})

describe('可选权限', () => {
  it('连上了哪几家；断开一家时另一家还要下载就留着下载', async () => {
    const granted = [
      'https://ads.google.com/*',
      'https://adsmanager.facebook.com/*',
      'https://business.facebook.com/*',
      'downloads',
    ]
    const p = perms(granted)
    expect(await connectedPlatforms(p)).toEqual(['google_ads', 'meta_ads'])
    await removeAds(p, 'google_ads')
    expect(granted).toContain('downloads')
    await removeAds(p, 'meta_ads')
    expect(granted).toEqual([])
    expect(ADS_CONSENT_TEXT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/u)
  })
})
