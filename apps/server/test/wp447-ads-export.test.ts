/**
 * WP447（docs/109 §6.2）：六个新平台第一期只读——报表拖进对话就入库（同一个看数据的库）、账户概况与体检、
 * 两个只读工具、只读职责调不动止损。
 *
 * 样本是 `packages/ads-core/test/fixtures/ads-export/` 里照官方帮助页列名手工录的那几份（假名字、假编号），
 * Apple 那份用 `writeXlsx` 现生成一份 .xlsx。**没打开任何真实广告后台**、没调任何付费接口。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeXlsx } from '@agentsws/ads-core'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import { createAdsExportIntake, withIntakeNote } from '../src/ads-data/export-intake.js'
import { exportAudit, exportDeckData, exportOverview } from '../src/ads-data/export-view.js'
import { createAdsDataService } from '../src/ads-data/service.js'
import { createAdsDataStore } from '../src/ads-data/store.js'
import { createAdsDataToolExecutor } from '../src/ads-data/tools.js'

const WS = 'ws_ads447'
const FIX = join(import.meta.dirname, '..', '..', '..', 'packages', 'ads-core', 'test', 'fixtures')
const sample = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIX, 'ads-export', name)))
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

function make(today = '2026-10-20') {
  const clock = { iso: `${today}T04:00:00.000Z` }
  const ads = createAdsStore({ workspace_id: WS as never })
  const store = createAdsDataStore({})
  let n = 0
  const svc = createAdsDataService({
    workspace_id: WS,
    store,
    ads,
    now: () => clock.iso,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    wanted: () => [],
  })
  return { svc, ads, store, clock }
}

describe('拖进来就入库（六家，同一个看数据的库）', () => {
  it('五份 CSV 各自认对平台、按天入库，那一句写清几行、哪几天、币种、时区', () => {
    const h = make()
    const cases = [
      ['microsoft-campaign.csv', 'microsoft', 3],
      ['pinterest-campaign.csv', 'pinterest', 3],
      ['reddit-campaign.csv', 'reddit', 2],
      ['linkedin-campaign.csv', 'linkedin', 2],
      ['snapchat-campaign.csv', 'snapchat', 2],
    ] as const
    for (const [file, platform, rows] of cases) {
      const out = h.svc.importExport({ bytes: sample(file), name: file, source: 'manual' })
      expect(out.ok, file).toBe(true)
      if (!out.ok) continue
      expect(out.platform).toBe(platform)
      expect(out.import.rows).toBe(rows)
      expect(out.note).toContain('已入库')
      expect(out.note).toContain('币种')
      expect(out.note).toContain('时区')
    }
    // 同一张表里：Google / Meta 那两家的老行与这几家的行并排
    const all = h.svc.rows({ since: '2026-10-01', until: '2026-10-31' })
    expect(new Set(all.map((r) => r.platform))).toEqual(
      new Set(['microsoft', 'pinterest', 'reddit', 'linkedin', 'snapchat']),
    )
    const ms = h.svc.imports({ platform: 'microsoft', limit: 1 })[0]
    expect(ms).toMatchObject({ currency: 'USD', since: '2026-10-18', until: '2026-10-19' })
    expect(ms?.timezone).toContain('Pacific')
    // Pinterest 没写币种 / 时区：照实没有；名字列按通用写法认，记一句
    const pin = h.svc.imports({ platform: 'pinterest', limit: 1 })[0]
    expect(pin?.currency).toBeUndefined()
    expect(pin?.notes.join('')).toContain('通用写法')
  })

  it('Apple 的 .xlsx 也收', () => {
    const h = make()
    const xlsx = writeXlsx([
      ['Day', 'Campaign Name', 'Spend', 'Impressions', 'Taps', 'Installs (Total)'],
      ['2026-10-19', 'Brand - US', '55', '2000', '120', '34'],
    ])
    const out = h.svc.importExport({ bytes: xlsx, name: 'Apple Ads.xlsx', source: 'manual' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.platform).toBe('apple')
  })

  it('认不出照实说：压缩包、空文件、认不出哪一家', () => {
    const h = make()
    const zip = h.svc.importExport({
      bytes: new Uint8Array([1, 2]),
      name: 'r.zip',
      source: 'manual',
    })
    expect(zip.ok).toBe(false)
    if (!zip.ok) expect(zip.message).toContain('解压')
    const odd = h.svc.importExport({
      bytes: new TextEncoder().encode('Campaign name,Spend\nA,1\n'),
      name: 'x.csv',
      source: 'manual',
    })
    expect(odd.ok).toBe(false)
  })

  it('今天的数同步进广告库（账户今天花了多少）；过去几天的不冒充今天', () => {
    const h = make('2026-10-19')
    h.svc.importExport({ bytes: sample('microsoft-campaign.csv'), name: 'm.csv', source: 'manual' })
    const acct = h.ads.account('microsoft:F123ABCD')
    expect(acct?.spend_today).toBe(135.5)
    const h2 = make('2026-10-25')
    h2.svc.importExport({
      bytes: sample('microsoft-campaign.csv'),
      name: 'm.csv',
      source: 'manual',
    })
    expect(h2.ads.account('microsoft:F123ABCD')).toBeUndefined()
  })
})

describe('对话里的附件口', () => {
  const setup = (held: string[]) => {
    const h = make()
    const intake = createAdsExportIntake({
      service: () => h.svc,
      held: (p) => held.includes(p),
      now: () => h.clock.iso,
      tzOffsetMinutes: () => 480,
    })
    return { h, intake }
  }
  const file = (name: string) => ({ name, data: b64(sample(name)) })

  it('投放岗位里拖进 Pinterest 的表 → 入库，那一句写在附件文字前面', () => {
    const { h, intake } = setup(['pinterest'])
    const [note] = intake([file('pinterest-campaign.csv')], { position_template_id: 'ads' })
    expect(note).toContain('已入库')
    expect(note).toContain('Pinterest 广告')
    expect(
      h.svc.rows({ since: '2026-10-01', until: '2026-10-31', platform: 'pinterest' }),
    ).toHaveLength(3)
    const att = withIntakeNote({ name: 'p.csv', chars: 3, text: 'a|b' }, note)
    expect(att.text?.startsWith('已入库')).toBe(true)
  })

  it('这一家没人担（没勾）→ 不入库，说一句去勾', () => {
    const { h, intake } = setup([])
    const [note] = intake([file('reddit-campaign.csv')], { position_template_id: 'ads' })
    expect(note).toContain('还没勾')
    expect(h.svc.rows({ since: '2026-10-01', until: '2026-10-31' })).toHaveLength(0)
  })

  it('不在投放里、或者是 Google / Meta 的表 → 不出声（附件照常读成文字）', () => {
    const { intake } = setup(['pinterest'])
    expect(intake([file('pinterest-campaign.csv')], { position_template_id: 'support' })).toEqual([
      undefined,
    ])
    const meta = {
      name: 'meta.csv',
      data: b64(new Uint8Array(readFileSync(join(FIX, 'ads-report', 'meta-ads.csv')))),
    }
    expect(intake([meta], { position_template_id: 'ads' })).toEqual([undefined])
    expect(
      intake([{ name: 'notes.md', data: b64(new Uint8Array([65])) }], { role_id: 'ads.reddit' }),
    ).toEqual([undefined])
  })

  it('在某一条新平台职责里拖进认不出的表 → 照实说没入库', () => {
    const { intake } = setup(['reddit'])
    const [note] = intake([{ name: 'x.csv', data: b64(new TextEncoder().encode('a,b\n1,2\n')) }], {
      role_id: 'ads.reddit',
    })
    expect(note).toContain('没入库')
  })
})

describe('账户概况与体检', () => {
  it('概况按最近一份报表那几天合计；没有报表就是空的', () => {
    const h = make()
    expect(exportOverview(h.svc, 'microsoft')).toEqual([])
    h.svc.importExport({ bytes: sample('microsoft-campaign.csv'), name: 'm.csv', source: 'manual' })
    const [row] = exportOverview(h.svc, 'microsoft')
    expect(row).toMatchObject({
      account: 'F123ABCD',
      since: '2026-10-18',
      until: '2026-10-19',
      currency: 'USD',
      campaigns: 2,
    })
    expect(row?.metrics.cost).toBe(1185.75)
  })

  it('Apple 没有报表 → 体检就一句「这条只适合推 App」', () => {
    const h = make()
    const audit = exportAudit(h.svc, 'apple')
    expect(audit.app_only).toContain('只适合推 App')
    expect(audit.items).toEqual([])
    const deck = exportDeckData(h.svc)
    // WP452：体检十家都有（老四家读插件那一路的表）
    expect(deck.audits).toHaveLength(10)
    expect(deck.exports).toEqual([])
  })
})

describe('两个只读工具；只读职责调不动止损', () => {
  const req = (role_id: string) =>
    ({
      id: 'run_1',
      workspace_id: WS,
      actor: { person_id: 'p_1', assignment_id: 'as_1', role_id },
    }) as never
  const tools = (h: ReturnType<typeof make>) => {
    const exec = createAdsDataToolExecutor({
      service: () => h.svc,
      ads: () => h.ads,
      port: () => undefined,
      caps: () => ({}),
    })
    return async (name: string, role: string, input: Record<string, unknown> = {}) =>
      (await exec({ name, input, request: req(role) })) as {
        status: string
        reason?: string
        data: Record<string, unknown>
      }
  }

  it('只读职责：止损 / 插件导出 / 查 Google·Meta 一个都调不动', async () => {
    const call = tools(make())
    for (const name of ['stage_ads_stop_loss', 'fetch_ads_data_now', 'query_ads_data'])
      expect((await call(name, 'ads.pinterest')).status).toBe('blocked')
    // 反过来：Google 那条也不给这两个只读工具（它有自己的查数）
    expect((await call('read_ads_export', 'ads.google')).status).toBe('blocked')
  })

  it('read_ads_export：没报表说怎么导；有报表回概况与系列表', async () => {
    const h = make()
    const call = tools(h)
    const none = await call('read_ads_export', 'ads.snapchat')
    expect(none.data.ok).toBe(false)
    expect(String(none.data.message)).toContain('导出')
    h.svc.importExport({ bytes: sample('snapchat-campaign.csv'), name: 's.csv', source: 'manual' })
    const got = await call('read_ads_export', 'ads.snapchat')
    expect(got.data.ok).toBe(true)
    expect((got.data.overview as unknown[]).length).toBe(1)
    expect((got.data.campaigns as { campaign: string }[])[0]?.campaign).toBe('Gen Z Summer')
  })

  it('run_ads_audit：后台那几项是「未知」', async () => {
    const h = make()
    h.svc.importExport({ bytes: sample('linkedin-campaign.csv'), name: 'l.csv', source: 'manual' })
    const out = await tools(h)('run_ads_audit', 'ads.linkedin')
    const items = out.data.items as { id: string; status: string }[]
    expect(items.find((i) => i.id === 'insight_tag')?.status).toBe('unknown')
    expect(items.find((i) => i.id === 'timezone_stated')?.status).toBe('ok')
  })
})
