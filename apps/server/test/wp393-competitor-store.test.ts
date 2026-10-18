/**
 * WP393（docs/104 一期 A）：店铺管理「竞品动向」的服务端——录好的样本 + 替身（不联网、不花钱）。
 *
 * - 方案卡：清单空着按档案种、每家探一次平台写清走哪条路、什么算要紧 AI 按品类建议（规则脑替身）、默认一天一次；
 * - 存下就先读一次当底子（不报上新）、第一次读完配对标款；
 * - 第二天降价 → 变化带「比你的 X 便宜 $N」、简报出「竞品动向」；一家读不到 → 失败、简报照实写；
 * - 探平台 / 现在读一次两个工具；没配好回 needs_setup（运行时出方案卡）；只给店铺管理。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PageFetch } from '@agentsws/brand-intake'
import type {
  BrandWatch,
  BrandWatchCompetitor,
  OwnShopProduct,
  StoreProbeResult,
  WorkspaceId,
} from '@agentsws/contracts'
import { setupRequestBranch } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  browserTextReadOf,
  createCompetitorStore,
  createCompetitorStoreTools,
  createCompetitorWatch,
  createCompetitorWatchDb,
  createShopCatalogAdapter,
} from '../src/competitor-watch/index.js'
import { setupNeedOf } from '../src/run-blocked.js'
import type { SetupResearchKit } from '../src/setup-research.js'
import type { SearchBrowserChannel } from '../src/web-browser/index.js'

const WS = 'ws_wp393' as WorkspaceId
const FIX = join(import.meta.dirname, '../../../packages/brand-intake/test/fixtures/shop-catalog')
const fx = (n: string) => readFileSync(join(FIX, n), 'utf8')

const RIVAL = 'https://rival-bikes.example'
const RIDE = 'https://ride.example'
const p1 = `${RIVAL}/products.json?limit=250&page=1`

const OWN: OwnShopProduct[] = [
  { key: 'ranger-commuter', title: 'Ranger Commuter eBike', price: 1699, currency: 'USD' },
  { key: 'city-helmet', title: 'City Helmet', price: 79, currency: 'USD' },
]

/** 竞品店（路由表；没登记的地址回 503）。第一页的 JSON 可以换（「第二天降价」）。 */
function shops() {
  let page1 = fx('shopify-products-p1.json')
  const broken = new Set<string>()
  const fetch: PageFetch = async (url) => {
    const origin = new URL(url).origin
    if (broken.has(origin))
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const routes: Record<string, string> = {
      [p1]: page1,
      [`${RIVAL}/collections/all.atom`]: fx('shopify-all.atom'),
      [`${RIDE}/wp-json/wc/store/v1/products?per_page=100&page=1`]: fx('woo-products-p1.json'),
    }
    const body = routes[url]
    return body === undefined
      ? { ok: false, status: 503, text: async () => '' }
      : { ok: true, status: 200, text: async () => body }
  }
  return {
    fetch,
    broken,
    dropLevel3: () => {
      page1 = page1.replaceAll('"price":"1599.00"', '"price":"1439.00"')
    },
  }
}

const PROBES: Record<string, StoreProbeResult> = {
  'https://rival-bikes.example': {
    url: RIVAL,
    platform: 'shopify',
    route: 'direct',
    via: 'direct',
    checked_at: '2026-10-18T00:00:00.000Z',
  },
  'https://ride.example': {
    url: RIDE,
    platform: 'woocommerce',
    route: 'direct',
    via: 'direct',
    checked_at: '2026-10-18T00:00:00.000Z',
  },
  'https://northwind.example': {
    url: 'https://northwind.example',
    platform: 'other',
    route: 'unsupported',
    reason: '这家网站暂时读不了商品数据',
    checked_at: '2026-10-18T00:00:00.000Z',
  },
}

function setup(opts: { connected?: boolean; competitors?: BrandWatchCompetitor[] } = {}) {
  const db = createCompetitorWatchDb()
  const store = db.forWorkspace(WS)
  let now = '2026-10-19T01:30:00.000Z'
  let seq = 0
  const shop = shops()
  let watch: Pick<BrandWatch, 'brand' | 'competitors'> = {
    brand: { name: 'Ranger Bikes', aliases: [], domains: ['ranger.example'] },
    competitors: opts.competitors ?? [],
  }
  const probed: string[] = []
  const cw = createCompetitorWatch({
    workspace_id: WS,
    store,
    now: () => now,
    newId: (p) => `${p}_${++seq}`,
    tzOffsetMinutes: () => 480,
    brandWatch: async () => watch,
    adapters: () => ({ shop_catalog: createShopCatalogAdapter({ fetch: shop.fetch }) }),
    extraOwnRef: async () => cs.ownRef(),
    afterRun: async (run) => cs.afterRun(run),
  })
  const cs = createCompetitorStore({
    workspace_id: WS,
    store,
    now: () => now,
    watch: () => cw,
    brandWatch: async () => watch,
    saveCompetitors: async (list) => {
      watch = { ...watch, competitors: list }
    },
    profile: () => ({
      category: '电助力自行车',
      competitors: [
        { name: 'Rival Bikes', url: 'https://rival-bikes.example' },
        { name: 'Ride Co', url: 'ride.example' },
        { name: 'Northwind', url: 'https://northwind.example/about' },
      ],
    }),
    probe: async (url) => {
      probed.push(url)
      const hit = PROBES[url]
      if (hit === undefined) throw new Error(`没登记的探平台 ${url}`)
      return hit
    },
    ownShop: async () =>
      opts.connected === false
        ? { connected: false, products: [] }
        : { connected: true, products: OWN },
  })
  const notes: string[] = []
  const kit: SetupResearchKit = {
    profile: async () => ({ category: '电助力自行车' }),
    search: async () => undefined,
    ask: async () => undefined,
    note: (t) => {
      notes.push(t)
    },
  }
  return {
    cw,
    cs,
    store,
    shop,
    kit,
    notes,
    probed,
    watch: () => watch,
    setNow: (iso: string) => {
      now = iso
    },
  }
}

/** 方案卡「就这样」：每格取方案值（research）或现值（fields）。 */
async function acceptPlan(t: ReturnType<typeof setup>): Promise<Record<string, string>> {
  const target = t.cs.setupTarget()
  const fields = await target.fields()
  const plan = (await target.research?.(t.kit)) ?? {}
  const values: Record<string, string> = {}
  for (const f of fields) values[f.key] = plan[f.key]?.value ?? f.suggested ?? ''
  await target.apply(values)
  await t.cs.pending()
  return values
}

describe('WP393 · 方案卡（决策 887 / 888）', () => {
  it('清单空着按档案种；每家探一次平台、写清走哪条路；什么算要紧按品类给建议；默认一天一次', async () => {
    const t = setup()
    const target = t.cs.setupTarget()
    expect(target.id).toBe('store.competitor_watch')
    expect(await target.satisfied()).toBe(false)
    const fields = await target.fields()
    expect(fields.map((f) => f.label).slice(0, 3)).toEqual(['Rival Bikes', 'Ride Co', 'Northwind'])
    const plan = (await target.research?.(t.kit)) ?? {}
    expect(plan.store__c_rival_bikes ?? Object.values(plan)[0]).toBeDefined()
    const keyOf = (label: string) => fields.find((f) => f.label === label)?.key as string
    expect(plan[keyOf('Rival Bikes')]).toMatchObject({
      value: RIVAL,
      why: '直接读他店里公开的商品数据',
    })
    expect(plan[keyOf('Northwind')]?.why).toBe('这家网站暂时读不了商品数据')
    expect(plan.price_drop_pct?.value).toBe('10')
    expect(plan.price_drop_pct?.why).toContain('电助力自行车')
    expect(plan.cheaper_than_own?.value).toBe('true')
    expect(plan.every_hours).toMatchObject({ value: '24', why: '默认一天一次' })
    expect(plan.pairs?.why).toContain('第一次读完')
    expect(t.notes.some((n) => n.startsWith('Rival Bikes：'))).toBe(true)
    // 卡上的字不提实现名 / 供应商名
    expect(JSON.stringify({ fields, plan })).not.toMatch(/feedsmith|apify|keepa|dataforseo/i)
  })

  it('点「就这样」：竞品写进唯一清单（带平台）、先读一次只建底子、第一次读完配好对标款', async () => {
    const t = setup()
    await acceptPlan(t)
    const list = t.watch().competitors
    expect(list.map((c) => [c.name, c.store?.platform])).toEqual([
      ['Rival Bikes', 'shopify'],
      ['Ride Co', 'woocommerce'],
      ['Northwind', 'other'],
    ])
    expect(await t.cs.setupTarget().satisfied()).toBe(true)
    const run = t.cw.runs(1)[0]
    expect(run?.trigger).toBe('added')
    expect(run?.changes).toBe(0)
    expect(t.store.changes()).toHaveLength(0)
    const rival = t.cw.sources().find((s) => s.label === 'Rival Bikes')
    expect(rival).toMatchObject({ status: 'ok', last_complete: true, last_via: 'direct' })
    // 第一次读完：Level 3 对标你的 Ranger（价位近、都叫 Commuter eBike 一类）
    expect(t.cs.plan()?.pairs.map((p) => `${p.title}=${p.own_key}`)).toContain(
      'Level 3 Commuter=ranger-commuter',
    )
    // 第一次只建底子：简报不出（没有要紧的、也没有哪家没读到——不支持的那家不算没读到）
    expect(t.cs.brief()).toBeUndefined()
  })

  it('第二天降价：变化带「比你的 X 便宜 $N」；简报出「竞品动向」那一段', async () => {
    const t = setup()
    await acceptPlan(t)
    t.shop.dropLevel3()
    t.setNow('2026-10-20T01:30:00.000Z')
    await t.cw.runNow({ trigger: 'schedule' })
    const price = t.store.changes({ kinds: ['price'] })
    expect(price).toHaveLength(1)
    expect(price[0]).toMatchObject({ title: 'Level 3 Commuter', pct: -10, variants: 2 })
    expect(price[0]?.vs_own).toMatchObject({ own_key: 'ranger-commuter', diff: -260 })
    const brief = t.cs.brief()
    expect(brief?.title).toBe('竞品动向')
    expect(brief?.lines[0]).toContain('Rival Bikes · Level 3 Commuter（2 个款式）：降价10%')
    expect(brief?.lines[0]).toContain('比你的 Ranger Commuter eBike 便宜 $260')
  })

  it('一家地址坏了：连接卡那条源失败、简报写「这家没读到」', async () => {
    const t = setup()
    await acceptPlan(t)
    t.shop.broken.add(RIVAL)
    t.setNow('2026-10-20T01:30:00.000Z')
    await t.cw.runNow({ trigger: 'schedule' })
    const rival = t.cw.sources().find((s) => s.label === 'Rival Bikes')
    expect(rival?.status).toBe('failed')
    expect(rival?.last_error).toContain('读不到 rival-bikes.example 的商品数据')
    expect(t.cs.brief()?.failed).toEqual(['Rival Bikes 这次没读到'])
  })

  it('没连自家店：只报竞品自己的变化，照实说「连上你的店才能比价」', async () => {
    const t = setup({ connected: false })
    const plan = (await t.cs.setupTarget().research?.(t.kit)) ?? {}
    expect(plan.cheaper_than_own).toMatchObject({ value: 'false', why: '连上你的店才能比价' })
    expect(plan.pairs?.why).toContain('连上你的店才能比价')
    await acceptPlan(t)
    t.shop.dropLevel3()
    t.setNow('2026-10-20T01:30:00.000Z')
    await t.cw.runNow({ trigger: 'schedule' })
    expect(t.store.changes({ kinds: ['price'] })[0]?.vs_own).toBeUndefined()
    expect(t.cs.plan()?.pairs).toEqual([])
  })

  it('人在卡上改对标款 / 写错了照实说；再加几家；降价幅度写错照实说', async () => {
    const t = setup()
    const values = await acceptPlan(t)
    const target = t.cs.setupTarget()
    await expect(
      target.apply({ ...values, pairs: 'Rival Bikes · Helmet Pro = 没这款' }),
    ).rejects.toThrow('认不出')
    await expect(target.apply({ ...values, price_drop_pct: '200' })).rejects.toThrow('1–90')
    await target.apply({
      ...values,
      pairs: 'Rival Bikes · Sinch Step-Thru = City Helmet',
      more: 'Northwind northwind.example',
    })
    expect(t.cs.plan()?.pairs).toEqual([
      expect.objectContaining({ product_key: '7002', own_key: 'city-helmet', by: 'user' }),
    ])
  })

  it('WP408（决策 1154）：连了店但这一款没有对标款——不比（不拿你店里最便宜的那件凑），只报竞品自己的降价', async () => {
    const t = setup()
    const values = await acceptPlan(t)
    // Level 3 不再对标任何一款；店里最便宜的是 City Helmet $79（老做法会写「起价比你店里最便宜的 City Helmet 贵 $N」）
    await t.cs
      .setupTarget()
      .apply({ ...values, pairs: 'Rival Bikes · Sinch Step-Thru = City Helmet' })
    t.shop.dropLevel3()
    t.setNow('2026-10-20T01:30:00.000Z')
    await t.cw.runNow({ trigger: 'schedule' })
    const price = t.store.changes({ kinds: ['price'] })
    expect(price).toHaveLength(1)
    expect(price[0]).toMatchObject({ title: 'Level 3 Commuter', pct: -10 })
    expect(price[0]?.vs_own).toBeUndefined()
    const line = t.cs.brief()?.lines[0] ?? ''
    expect(line).toContain('Level 3 Commuter')
    expect(line).not.toContain('City Helmet')
    expect(line).not.toContain('最便宜')
  })
})

describe('WP393 · 两个工具', () => {
  const req = (role_id: string) =>
    ({ workspace_id: WS, actor: { person_id: 'p', assignment_id: 'a', role_id } }) as never

  it('现在读一次：没配好回 needs_setup（运行时出方案卡）；只给店铺管理', async () => {
    const t = setup()
    const exec = createCompetitorStoreTools({ of: async () => t.cs })
    const res = await exec({ name: 'read_competitor_stores', input: {}, request: req('dtc.store') })
    expect(res.status).toBe('ok')
    expect(setupNeedOf('read_competitor_stores', res)).toMatchObject({
      kind: 'setup',
      target: 'store.competitor_watch',
    })
    const blocked = await exec({
      name: 'read_competitor_stores',
      input: {},
      request: req('dtc.support'),
    })
    expect(blocked.status).toBe('blocked')
  })

  it('现在读一次：配好之后读、回这一次的变化与要紧的那几条', async () => {
    const t = setup()
    await acceptPlan(t)
    t.shop.dropLevel3()
    t.setNow('2026-10-20T01:30:00.000Z')
    const exec = createCompetitorStoreTools({ of: async () => t.cs })
    const res = await exec({
      name: 'read_competitor_stores',
      input: { competitor: 'Rival Bikes' },
      request: req('dtc.store'),
    })
    const data = res.data as { ok: boolean; important: string[]; read: { competitor: string }[] }
    expect(data.ok).toBe(true)
    expect(data.read.map((r) => r.competitor)).toEqual(['Rival Bikes'])
    expect(data.important[0]).toContain('便宜 $260')
  })

  it('探平台：按跳转后的地址写进清单', async () => {
    const t = setup({
      competitors: [
        { id: 'c_rival', name: 'Rival Bikes', aliases: [], domains: ['rival-bikes.example'] },
      ],
    })
    const exec = createCompetitorStoreTools({ of: async () => t.cs })
    const res = await exec({
      name: 'find_competitor_store',
      input: { competitor: 'rival bikes' },
      request: req('dtc.store'),
    })
    expect(res.data).toMatchObject({
      ok: true,
      platform: 'shopify',
      how: '直接读他店里公开的商品数据',
      saved: true,
    })
    expect(t.watch().competitors[0]?.store).toMatchObject({ url: RIVAL, platform: 'shopify' })
  })

  it('stub 剧本：「帮我盯一下 ebike 竞品的上新和价格」→ 要方案卡；只是问动静不要卡', () => {
    const on = { tools: { allow: ['request_setup'] } } as never
    expect(setupRequestBranch(on, '帮我盯一下 ebike 竞品的上新和价格')?.input).toMatchObject({
      setting: 'store.competitor_watch',
    })
    expect(setupRequestBranch(on, '竞品最近有什么动静')).toBeUndefined()
  })
})

describe('WP393 · 内置浏览器那一口', () => {
  it('被挡时走 data 那一种、读回原文；页面上有验证照实标出来', async () => {
    const calls: unknown[] = []
    const channel: SearchBrowserChannel = {
      open: async (input) => {
        calls.push(input)
        return {
          ok: true,
          status: 200,
          final_url: input.url,
          page: {
            signals: { title: '', text: '', captcha: false, passwordInputs: 0 },
            text: '{"products":[]}',
            truncated: false,
          },
        }
      },
      reveal: async () => false,
      status: async () => undefined,
    }
    const read = browserTextReadOf(channel, WS)
    const r = await read(p1)
    expect(r).toMatchObject({ ok: true, text: '{"products":[]}', challenge: false })
    expect(calls[0]).toMatchObject({ kind: 'data', workspace_id: WS, url: p1 })
  })
})
