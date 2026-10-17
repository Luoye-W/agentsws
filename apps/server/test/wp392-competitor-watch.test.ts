/**
 * WP392（docs/104）：竞品监控积木的服务端（替身进料口、内存库；不联网、不花钱）。
 *
 * - 调度：到点（本地 9 点后一天一次）、新加的源马上读、关机错过只补一次、失败隔一小时再试、下次读的时刻；
 * - 监控源从唯一工作清单同步（竞品的独立站 / Amazon 对标款、自家 ASIN）；
 * - 管道：第一天只建底子、第二天改一格出一条降价；一家读不到照实记失败；某类进料口没接上照实说；C8 和自家比差价。
 */
import type {
  BrandWatch,
  CatalogReadResult,
  CatalogSnapshotRow,
  CompetitorIntakeAdapter,
  CompetitorWatchSettings,
  CompetitorWatchSource,
  WorkspaceId,
} from '@agentsws/contracts'
import { COMPETITOR_WATCH_SETTINGS_DEFAULTS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createCompetitorWatch,
  createCompetitorWatchDb,
  dueSources,
  nextReadAt,
  syncSources,
  wantedSources,
} from '../src/competitor-watch/index.js'

const WS = 'ws_cw' as WorkspaceId
const S: CompetitorWatchSettings = { ...COMPETITOR_WATCH_SETTINGS_DEFAULTS }
const TZ = 480 // 东八区

const src = (over: Partial<CompetitorWatchSource> = {}) => ({
  id: 'cw_shop_c1',
  status: 'ok' as const,
  ...over,
})

describe('WP392 调度（due）', () => {
  it('一天一次：本地 9 点前不读，9 点后读；同一天读过不再读', () => {
    const ok = '2026-10-10T02:00:00.000Z' // 10-10 10:00 本地
    const at = (iso: string) =>
      dueSources({
        now: iso,
        tz_offset_minutes: TZ,
        settings: S,
        sources: [src({ last_ok_at: ok })],
      })
    expect(at('2026-10-10T20:00:00.000Z')).toEqual([]) // 10-11 04:00 本地，还没到 9 点
    expect(at('2026-10-11T01:30:00.000Z')).toEqual(['cw_shop_c1']) // 10-11 09:30
    expect(at('2026-10-10T08:00:00.000Z')).toEqual([]) // 同一天
  })

  it('新加的源马上读一次当底子（不等明早）；关机三天开机只补一次', () => {
    expect(
      dueSources({
        now: '2026-10-10T18:00:00.000Z',
        tz_offset_minutes: TZ,
        settings: S,
        sources: [src({ status: 'unchecked' })],
      }),
    ).toEqual(['cw_shop_c1'])
    const s = src({ last_ok_at: '2026-10-07T02:00:00.000Z' })
    const now = '2026-10-10T03:00:00.000Z'
    expect(dueSources({ now, tz_offset_minutes: TZ, settings: S, sources: [s] })).toHaveLength(1)
    // 补完这一次，同一天不再读
    const after = { ...s, last_ok_at: now, last_try_at: now }
    expect(
      dueSources({
        now: '2026-10-10T05:00:00.000Z',
        tz_offset_minutes: TZ,
        settings: S,
        sources: [after],
      }),
    ).toEqual([])
  })

  it('失败了隔一小时再试；暂停的、总开关关了不读；频率用户能改', () => {
    const failed = src({
      status: 'failed',
      last_ok_at: '2026-10-09T02:00:00.000Z',
      last_try_at: '2026-10-10T01:30:00.000Z',
    })
    const at = (now: string, settings = S, sources = [failed]) =>
      dueSources({ now, tz_offset_minutes: TZ, settings, sources })
    expect(at('2026-10-10T02:00:00.000Z')).toEqual([])
    expect(at('2026-10-10T02:30:00.000Z')).toEqual(['cw_shop_c1'])
    expect(at('2026-10-10T02:30:00.000Z', { ...S, enabled: false })).toEqual([])
    expect(at('2026-10-10T02:30:00.000Z', S, [{ ...failed, paused: true }])).toEqual([])
    // 改成每 6 小时一次
    const six = { ...S, every_hours: 6 }
    const ok = src({ last_ok_at: '2026-10-10T00:00:00.000Z' })
    expect(at('2026-10-10T03:00:00.000Z', six, [ok])).toEqual([])
    expect(at('2026-10-10T06:00:00.000Z', six, [ok])).toEqual(['cw_shop_c1'])
  })

  it('下次读的时刻：读过的是明早 9 点（本地）', () => {
    const next = nextReadAt({
      now: '2026-10-10T06:00:00.000Z',
      tz_offset_minutes: TZ,
      settings: S,
      sources: [src({ last_ok_at: '2026-10-10T02:00:00.000Z' })],
    })
    expect(next).toBe('2026-10-11T01:00:00.000Z')
  })
})

const watch = (over: Partial<Pick<BrandWatch, 'brand' | 'competitors'>> = {}) => ({
  brand: {
    name: 'Ours',
    aliases: [],
    domains: ['ours.test'],
    amazon: [{ marketplace: 'us', asin: 'b0own00001', label: 'Ranger' }],
  },
  competitors: [
    {
      id: 'c1',
      name: 'Alpha Bikes',
      aliases: [],
      domains: ['alpha.test'],
      store: { url: 'https://alpha.test', platform: 'shopify' as const },
      amazon: [{ marketplace: 'US', asin: 'B0ALPHA001', vs_own: 'B0OWN00001' }],
    },
    {
      id: 'c2',
      name: 'Beta Ride',
      aliases: [],
      domains: ['beta.test'],
      store: { url: 'https://beta.test', platform: 'woocommerce' as const },
    },
    { id: 'c3', name: 'Gamma', aliases: [], domains: [] },
  ],
  ...over,
})

describe('WP392 监控源从唯一工作清单同步', () => {
  it('竞品的独立站 / Amazon 对标款、自家 ASIN 各一条；没写格子的竞品不出源', () => {
    const w = wantedSources(watch(), { workspace_id: WS, every_hours: 24 })
    expect(w.map((s) => [s.id, s.kind, s.group]).sort()).toEqual([
      ['cw_amz__own_US', 'amazon_asin', 'own'],
      ['cw_amz_c1_US', 'amazon_asin', 'competitor'],
      ['cw_shop_c1', 'shop_catalog', 'competitor'],
      ['cw_shop_c2', 'shop_catalog', 'competitor'],
    ])
    expect(w.find((s) => s.id === 'cw_amz__own_US')?.asins).toEqual(['B0OWN00001'])
    expect(w.find((s) => s.id === 'cw_amz_c1_US')?.url).toBe('https://www.amazon.com')
  })

  it('店址改了 = 换了一家店，快照重来；删掉的竞品连源一起删', () => {
    const now = '2026-10-10T00:00:00.000Z'
    const first = syncSources(
      [],
      wantedSources(watch(), { workspace_id: WS, every_hours: 24 }),
      now,
    )
    const existing = first.put.map((s) => ({ ...s, status: 'ok' as const, last_ok_at: now }))
    const moved = watch({
      competitors: [
        {
          id: 'c1',
          name: 'Alpha Bikes',
          aliases: [],
          domains: [],
          store: { url: 'https://shop.alpha.test', platform: 'shopify' },
        },
      ],
    })
    const plan = syncSources(
      existing,
      wantedSources(moved, { workspace_id: WS, every_hours: 24 }),
      now,
    )
    expect(plan.reset).toEqual(['cw_shop_c1'])
    expect(plan.put.find((s) => s.id === 'cw_shop_c1')?.status).toBe('unchecked')
    expect(plan.remove.sort()).toEqual(['cw_amz_c1_US', 'cw_shop_c2'])
  })
})

/* ── 管道 ───────────────────────────────────────────────────────────── */

const shopRow = (product_key: string, price: number): CatalogSnapshotRow => ({
  source_id: '',
  competitor_id: '',
  product_key,
  variant_key: `${product_key}-v`,
  title: `Bike ${product_key}`,
  url: `https://alpha.test/products/${product_key}`,
  price,
  currency: 'USD',
  available: true,
  read_at: '2026-10-10T00:00:00.000Z',
})

function harness(
  opts: { adapters?: CompetitorIntakeAdapter[]; w?: ReturnType<typeof watch> } = {},
) {
  let now = '2026-10-10T02:00:00.000Z'
  let seq = 0
  const db = createCompetitorWatchDb()
  const store = db.forWorkspace(WS)
  const catalogs = new Map<string, CatalogSnapshotRow[]>()
  const broken = new Set<string>()
  const shop: CompetitorIntakeAdapter = {
    kind: 'shop_catalog',
    read: async (s): Promise<CatalogReadResult> => {
      if (broken.has(s.id))
        return { rows: [], complete: false, error: `读不到 ${new URL(s.url).host} 的商品数据` }
      return { rows: catalogs.get(s.id) ?? [], complete: true, via: 'direct' }
    },
  }
  const amazon: CompetitorIntakeAdapter = {
    kind: 'amazon_asin',
    read: async (s) => ({
      rows: (s.asins ?? []).map((asin) => ({
        source_id: s.id,
        competitor_id: s.competitor_id,
        product_key: asin,
        title: asin === 'B0OWN00001' ? 'Ranger' : 'Alpha Level',
        price: catalogs.get(asin)?.[0]?.price ?? 999,
        currency: 'USD',
        read_at: now,
      })),
      complete: true,
      via: 'browser',
    }),
  }
  const adapters = opts.adapters ?? [shop, amazon]
  const cw = createCompetitorWatch({
    workspace_id: WS,
    store,
    now: () => now,
    newId: (p) => `${p}_${++seq}`,
    tzOffsetMinutes: () => TZ,
    brandWatch: async () => opts.w ?? watch(),
    adapters: () => Object.fromEntries(adapters.map((a) => [a.kind, a])),
  })
  return {
    cw,
    store,
    catalogs,
    broken,
    setNow: (iso: string) => {
      now = iso
    },
  }
}

describe('WP392 管道（替身进料口）', () => {
  it('第一天只建底子；第二天快照改一格 → 变化表出「降价」', async () => {
    const h = harness()
    h.catalogs.set('cw_shop_c1', [shopRow('p1', 1799), shopRow('p2', 999)])
    h.catalogs.set('cw_shop_c2', [shopRow('q1', 499)])
    const day1 = await h.cw.runNow({ trigger: 'added' })
    expect(day1.changes).toBe(0)
    expect(day1.parts.every((p) => p.status === 'ok' && p.baseline === true)).toBe(true)
    expect(h.cw.changes()).toEqual([])

    h.setNow('2026-10-11T02:00:00.000Z')
    h.catalogs.set('cw_shop_c1', [shopRow('p1', 1599), shopRow('p2', 999)])
    const tick = await h.cw.tick()
    expect(tick.ran).toBe(true)
    const list = h.cw.changes()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      kind: 'price',
      competitor: 'Alpha Bikes',
      before: 1799,
      after: 1599,
      pct: -11.1,
      source_kind: 'shop_catalog',
    })
    // 同一天再敲一拍：不到点，不读
    expect((await h.cw.tick()).skipped).toBe('not_due')
  })

  it('一家读不到：照实记失败、连接卡那句写出是哪家；别家照常', async () => {
    const h = harness()
    h.catalogs.set('cw_shop_c1', [shopRow('p1', 1799)])
    h.broken.add('cw_shop_c2')
    const run = await h.cw.runNow()
    const part = run.parts.find((p) => p.source_id === 'cw_shop_c2')
    expect(part).toMatchObject({ status: 'failed', label: 'Beta Ride' })
    expect(run.notes.join('\n')).toContain('beta.test')
    const view = await h.cw.view()
    expect(view.summary).toMatchObject({ failed: 1, failed_labels: ['Beta Ride'] })
    expect(view.summary.competitors).toBe(3) // Alpha、Beta、自家
    expect(h.store.source('cw_shop_c2')?.last_error).toContain('beta.test')
    expect(view.next_read_at).toBeDefined()
  })

  it('某类进料口这台电脑还没接上：照实标出来，不算失败', async () => {
    const h = harness({
      adapters: [
        {
          kind: 'shop_catalog',
          read: async () => ({ rows: [shopRow('p1', 1)], complete: true }),
        },
      ],
    })
    const run = await h.cw.runNow()
    expect(run.parts.find((p) => p.source_id === 'cw_amz_c1_US')?.status).toBe('skipped')
    const view = await h.cw.view()
    expect(view.missing_adapters).toEqual(['amazon_asin'])
    expect(view.summary.failed).toBe(0)
  })

  it('C8：Amazon 对标款降价时，和自家那一款比差价（自家的先读）', async () => {
    const h = harness()
    h.catalogs.set('B0ALPHA001', [shopRow('x', 1299)])
    h.catalogs.set('B0OWN00001', [shopRow('y', 1399)])
    await h.cw.runNow()
    h.setNow('2026-10-11T02:00:00.000Z')
    h.catalogs.set('B0ALPHA001', [shopRow('x', 1199)])
    await h.cw.runNow()
    const c = h.cw.changes({ source_kind: 'amazon_asin' })
    expect(c).toHaveLength(1)
    expect(c[0]?.vs_own).toMatchObject({ own_key: 'B0OWN00001', own_price: 1399, diff: -200 })
  })

  it('频率能改（写进设置，源跟着改）', () => {
    const h = harness()
    const next = h.cw.updateSettings({ every_hours: 12, day_start_hour: 7 })
    expect(next).toMatchObject({ every_hours: 12, day_start_hour: 7, enabled: true })
    expect(h.cw.settings().every_hours).toBe(12)
  })
})
