/**
 * 规矩本身：白名单、默认不碰的区域、限速（只限速不伪装）、排队 24 小时作废、指纹。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ActionQueue,
  accountKey,
  allowedZonesFor,
  base64ToBytes,
  buildAdsJob,
  bytesToBase64,
  CLAIM_LEASE_MS,
  checkStep,
  defaultZoneSettings,
  GUARDED_ZONE_IDS,
  hostMatches,
  normalizeZoneSettings,
  Pace,
  QUEUE_TTL_MS,
  sheetFingerprint,
  sheetMatches,
  validateJob,
  zoneGate,
  zoneOfUrl,
} from '../src/index.js'

const account = { platform: 'google_ads' as const, id: '123-456-7890' }
const T0 = Date.parse('2026-10-14T09:00:00+08:00')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

afterEach(() => vi.restoreAllMocks())

describe('白名单（与 Reddit 通道同一套话术）', () => {
  const allow = {
    hosts: ['ads.google.com', '*.example.com'],
    click: ['#ok'],
    fill: ['#n'],
    values: ['5'],
  }
  it('打开 / 点 / 填 各自按白名单判', () => {
    expect(checkStep({ op: 'goto', url: 'https://ads.google.com/aw' }, allow, 'pause').ok).toBe(
      true,
    )
    expect(checkStep({ op: 'goto', url: 'https://a.b.example.com/' }, allow, 'pause').ok).toBe(true)
    expect(checkStep({ op: 'goto', url: 'https://evil.com/' }, allow, 'pause')).toEqual({
      ok: false,
      why: '要打开的页面不在白名单里：evil.com',
    })
    expect(checkStep({ op: 'click', selector: '#no' }, allow, 'pause')).toEqual({
      ok: false,
      why: '这一下点击不在「pause」这个动作的白名单里，已拦下。',
    })
    expect(checkStep({ op: 'fill', selector: '#n', value: '6' }, allow, 'pause')).toEqual({
      ok: false,
      why: '要填的字和审批卡上的不一样，已拦下。',
    })
    expect(checkStep({ op: 'upload', selector: 'input' }, allow, 'x').ok).toBe(false)
    expect(checkStep({ op: 'download', selector: '#d' }, allow, 'x').ok).toBe(false)
  })
  it('主机名匹配与 contracts 的 hostAllowed 同语义', () => {
    expect(hostMatches('ADS.google.com.', ['ads.google.com'])).toBe(true)
    expect(hostMatches('example.com', ['*.example.com'])).toBe(true)
    expect(hostMatches('notexample.com', ['*.example.com'])).toBe(false)
    expect(hostMatches('', ['*'])).toBe(false)
  })
})

describe('默认不碰的区域（决策 557：默认关、逐项放开、放开后 L1）', () => {
  it('十个区域，全部默认关', () => {
    expect(GUARDED_ZONE_IDS).toHaveLength(10)
    expect(Object.values(defaultZoneSettings()).every((v) => v === false)).toBe(true)
    expect(normalizeZoneSettings({ billing: true, bogus: true })).toEqual({
      ...defaultZoneSettings(),
      billing: true,
    })
  })
  it('认网址：窄的先认（余额 / 付款在账单下面）', () => {
    expect(zoneOfUrl('https://ads.google.com/aw/billing/summary?ocid=1')).toBe('balance')
    expect(zoneOfUrl('https://ads.google.com/aw/billing/paymentmethods')).toBe('payment')
    expect(zoneOfUrl('https://ads.google.com/aw/billing/documents')).toBe('billing')
    expect(zoneOfUrl('https://ads.google.com/aw/accountaccess')).toBe('users')
    expect(zoneOfUrl('https://ads.google.com/aw/conversions')).toBe('pixel_conversion')
    expect(zoneOfUrl('https://business.facebook.com/settings/people')).toBe('users')
    expect(zoneOfUrl('https://business.facebook.com/billing_hub/payment_methods')).toBe('payment')
    expect(zoneOfUrl('https://business.facebook.com/events_manager2/list')).toBe('pixel_conversion')
    expect(
      zoneOfUrl('https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1'),
    ).toBeUndefined()
    expect(zoneOfUrl('https://ads.google.com/aw/campaigns')).toBeUndefined()
  })
  it('只放开了账单时，余额页照样停', () => {
    expect(zoneGate('https://ads.google.com/aw/billing/summary', ['billing']).ok).toBe(false)
    expect(zoneGate('https://ads.google.com/aw/billing/documents', ['billing']).ok).toBe(true)
  })
  it('动作要进区域：没放开不进队；放开了也要 L1', () => {
    const s = defaultZoneSettings()
    expect(allowedZonesFor(['delete_campaign'], s, 'L1').ok).toBe(false)
    s.delete_campaign = true
    expect(allowedZonesFor(['delete_campaign'], s, 'L2').ok).toBe(false)
    expect(allowedZonesFor(['delete_campaign'], s, 'L1')).toEqual({
      ok: true,
      zones: ['delete_campaign'],
    })
    expect(allowedZonesFor([], s, undefined)).toEqual({ ok: true, zones: [] })
  })
})

describe('限速（决策 555）', () => {
  it('同一账户一次一件；做完才放开', () => {
    const pace = new Pace({ dayOf: day })
    expect(pace.begin(account, 'write', 'a', T0).ok).toBe(true)
    expect(pace.check(account, 'write', T0)).toMatchObject({ ok: false, reason: 'busy' })
    // 横杠写不写都是同一个账户
    expect(pace.check({ ...account, id: '1234567890' }, 'read', T0).ok).toBe(false)
    pace.end(account, 'other')
    expect(pace.check(account, 'write', T0).ok).toBe(false)
    pace.end(account, 'a')
    expect(pace.check(account, 'write', T0).ok).toBe(true)
  })
  it('每天写 ≤ 20、读 ≤ 2，第二天清零', () => {
    const pace = new Pace({ dayOf: day })
    for (let i = 0; i < 20; i += 1) {
      expect(pace.begin(account, 'write', `w${i}`, T0).ok).toBe(true)
      pace.end(account, `w${i}`)
    }
    expect(pace.check(account, 'write', T0)).toMatchObject({ ok: false, reason: 'daily_cap' })
    for (let i = 0; i < 2; i += 1) {
      pace.begin(account, 'read', `r${i}`, T0)
      pace.end(account, `r${i}`)
    }
    expect(pace.check(account, 'read', T0).ok).toBe(false)
    const tomorrow = T0 + 24 * 60 * 60 * 1000
    expect(pace.left(account, tomorrow)).toEqual({ writes: 20, reads: 2 })
  })
  it('不用随机数（只限速，不伪装）', () => {
    const spy = vi.spyOn(Math, 'random')
    const pace = new Pace({ dayOf: day })
    pace.begin(account, 'write', 'a', T0)
    pace.check(account, 'write', T0)
    expect(spy).not.toHaveBeenCalled()
    expect(accountKey({ platform: 'meta_ads', id: 'act_77' })).toBe('meta_ads:77')
  })
})

function job(id: string, over: Partial<Parameters<typeof buildAdsJob>[0]> = {}) {
  return buildAdsJob({
    id,
    workspace_id: 'ws_1',
    account,
    action: { kind: 'pause', entity: { level: 'campaign', id: '1' } },
    approval_id: `ap_${id}`,
    created_at: '2026-10-14T01:00:00.000Z',
    ...over,
  })
}

describe('排队（决策 558）', () => {
  it('写操作没审批编号不进队；要表却没带表不进队', () => {
    const zones = defaultZoneSettings()
    const noApproval = job('a')
    delete noApproval.approval_id
    expect(validateJob(noApproval, { zones })).toMatchObject({ ok: false })
    const noSheet = job('b')
    noSheet.plan.needs_sheet = true
    expect(validateJob(noSheet, { zones })).toMatchObject({ ok: false })
    const bad = job('c')
    bad.plan.steps.push({ op: 'click', selector: '#delete' })
    expect(validateJob(bad, { zones })).toMatchObject({ ok: false })
    expect(validateJob(job('d'), { zones }).ok).toBe(true)
  })

  it('领活：按先后、同一账户一次一件；平台对不上不给', () => {
    const q = new ActionQueue({ pace: new Pace({ dayOf: day }) })
    q.enqueue(job('a'), T0)
    q.enqueue(job('b'), T0 + 1)
    q.enqueue(job('a'), T0 + 2) // 重放不排第二件
    expect(q.list()).toHaveLength(2)
    expect(q.claim(['meta_ads'], T0)).toBeUndefined()
    expect(q.claim(['google_ads'], T0)?.job.id).toBe('a')
    expect(q.claim(['google_ads'], T0)).toBeUndefined()
    expect(q.waiting(T0)).toEqual([{ id: 'b', why: expect.stringContaining('一次只做一件') }])
    q.finish('a', { outcome: 'done', message: 'ok', step: 6, reads: {} }, T0 + 10)
    expect(q.claim(['google_ads'], T0 + 11)?.job.id).toBe('b')
  })

  it('排了 24 小时没人领 → 作废（上层重出卡）', () => {
    const q = new ActionQueue({ pace: new Pace({ dayOf: day }) })
    q.enqueue(job('a'), T0)
    expect(q.sweep(T0 + QUEUE_TTL_MS - 1)).toEqual([])
    const changed = q.sweep(T0 + QUEUE_TTL_MS)
    expect(changed.map((r) => [r.job.id, r.status])).toEqual([['a', 'expired']])
    expect(q.claim(['google_ads'], T0 + QUEUE_TTL_MS + 1)).toBeUndefined()
  })

  it('领走后断了音讯 → 记失败、放开账户，不自动重跑', () => {
    const pace = new Pace({ dayOf: day })
    const q = new ActionQueue({ pace })
    q.enqueue(job('a'), T0)
    q.claim(['google_ads'], T0)
    q.progress('a', { step: 2, of: 6, label: '点按钮' }, T0 + 1000)
    const changed = q.sweep(T0 + 1000 + CLAIM_LEASE_MS)
    expect(changed[0]?.status).toBe('failed')
    expect(changed[0]?.result?.message).toContain('不会自动重做')
    expect(pace.check(account, 'write', T0 + 1000 + CLAIM_LEASE_MS).ok).toBe(true)
  })

  it('停：排着的当场作废；正在跑的下一次进度回执里带回 stop', () => {
    const q = new ActionQueue({ pace: new Pace({ dayOf: day }) })
    q.enqueue(job('a'), T0)
    q.enqueue(job('b', { account: { platform: 'google_ads', id: '999' } }), T0)
    expect(q.requestStop('b', T0)?.status).toBe('stopped')
    q.claim(['google_ads'], T0)
    q.requestStop('a', T0)
    expect(q.progress('a', { step: 1, of: 6, label: 'x' }, T0)).toEqual({
      stop: true,
      confirmed: false,
    })
  })

  it('工坊卡上确认 → 进度回执里带回 confirmed', () => {
    const q = new ActionQueue({ pace: new Pace({ dayOf: day }) })
    q.enqueue(job('a'), T0)
    expect(q.confirm('a')).toBe(false)
    q.claim(['google_ads'], T0)
    q.progress('a', { step: 9, of: 12, label: '等你确认', waiting_confirm: true }, T0)
    expect(q.get('a')?.status).toBe('waiting_confirm')
    expect(q.confirm('a')).toBe(true)
    expect(
      q.progress('a', { step: 9, of: 12, label: '等你确认', waiting_confirm: true }, T0)?.confirmed,
    ).toBe(true)
    const snap = q.snapshot()
    expect(new ActionQueue({ pace: new Pace(), state: snap }).get('a')?.confirmed).toBe(true)
  })
})

describe('上传表指纹', () => {
  it('sha256，形状 sha256:<hex>，改一个字节就对不上', async () => {
    expect(await sheetFingerprint('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const fp = await sheetFingerprint('a,b\n1,2\n')
    expect(await sheetMatches(new TextEncoder().encode('a,b\n1,2\n'), fp)).toBe(true)
    expect(await sheetMatches('a,b\n1,3\n', fp)).toBe(false)
    expect(await sheetMatches('a,b\n1,2\n', 'md5:xx')).toBe(false)
  })
  it('base64 往返', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 2, 250, 255])
  })
})
