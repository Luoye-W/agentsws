/**
 * WP394（docs/104 一期 B，docs/106 §13 A9）：Amazon 竞品对标款的服务端——录好的样本 + 替身（不联网、不花钱）。
 *
 * - 读页那一块：先设配送邮编（美国站 10001）再读；币种不符 / 不能配送 → 作废、重设一次再读，再不对照实说；
 *   验证页 → 暂停、之后一页 Amazon 都不开（不重试、不绕）；页与页之间固定间隔（不调随机数）；额度满了照实说；
 * - 方案卡：竞品按档案种、在 Amazon 搜「品牌名 + 品类」挑对标款（规则脑）、各配自家一款；自家 ASIN 没有就要链接；
 *   什么算重要按品类建议（模型不回 → 规则版）；存下先读一次当底子；
 * - 第二天降价 → 变化带「比你的 X 便宜 $N」、按确认过的规则算重要；
 * - 被拦 → 剩下的走云端（替身），积分照扣、对话里那一句；云端那一路划线价 / 优惠券照实空着；
 * - 现在读一次工具：没配好回 needs_setup、只给亚马逊店铺运营；stub「帮我盯 Amazon 上的竞品」要方案卡。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrandWatch, DataTaskView, RunRequest, WorkspaceId } from '@agentsws/contracts'
import { competitorId } from '@agentsws/seo-core'
import { setupRequestBranch } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  type AmazonFrontState,
  createAmazonFrontReader,
  readAmazonCloud,
} from '../src/amazon-front/index.js'
import {
  createAmazonAsinAdapter,
  createAmazonCompetitor,
  createAmazonCompetitorTools,
  createCompetitorWatch,
  createCompetitorWatchDb,
  dueSources,
  parseAmazonPairs,
} from '../src/competitor-watch/index.js'
import type { SetupResearchKit } from '../src/setup-research.js'
import { createSearchThrottle, type SearchBrowserChannel } from '../src/web-browser/index.js'

const WS = 'ws_wp394' as WorkspaceId
const FIX = join(import.meta.dirname, '../../../packages/brand-intake/test/fixtures/amazon-watch')
const fx = (n: string) => readFileSync(join(FIX, n), 'utf8')

const ownPage = (title: string, price: string) =>
  fx('us-normal.html')
    .replace(
      /Rival Gear Trail 500 Electric Bike, 750W Commuter Ebike with Removable Battery/g,
      title,
    )
    .replace(/Visit the Rival Gear Store/g, 'Visit the Nordvik Store')
    .replace(/\$1,299\.00/g, price)
    .replace(/1,299/g, price.replace(/[$.]00$/g, '').replace('$', ''))

/** 替身 Amazon（路由表）：`captcha` 里的 ASIN 回验证页、`region` 打开时回「配送到加拿大」那一页。 */
function amazon() {
  const pages: Record<string, string> = {
    B0TESTRG01: fx('us-normal.html'),
    B0TESTRG02: fx('out-of-stock.html'),
    B0TESTRG03: fx('deal-coupon.html'),
    B0OWNMINE1: ownPage('Nordvik Ranger Electric Bike 750W Commuter', '$1,399.00'),
    B0OWNMINE2: ownPage('Nordvik Fold Folding Electric Bike', '$1,099.00'),
  }
  const captcha = new Set<string>()
  const opened: string[] = []
  const deliveries: string[] = []
  const state = { region: 'us' as 'us' | 'ca' | 'stuck' }
  const channel: SearchBrowserChannel = {
    async open(input) {
      opened.push(input.url)
      expect(input.kind).toBe('html')
      const u = new URL(input.url)
      const asin = /\/dp\/([A-Z0-9]{10})/.exec(u.pathname)?.[1]
      let html: string | undefined
      if (u.pathname === '/s') html = fx('search.html')
      else if (asin !== undefined) {
        if (captcha.has(asin)) html = fx('captcha.html')
        else if (state.region !== 'us') html = fx('ca-undeliverable.html')
        else html = pages[asin]
      }
      if (html === undefined)
        return {
          ok: true,
          status: 404,
          final_url: input.url,
          page: { signals: sig(), text: '<title>Page Not Found</title>', truncated: false },
        }
      return {
        ok: true,
        status: 200,
        final_url: input.url,
        page: { signals: sig(), text: html, truncated: false },
      }
    },
    reveal: async () => false,
    status: async () => ({ revealed: false }),
    async amazonDelivery(input) {
      deliveries.push(`${input.url}|${input.zip}`)
      if (state.region === 'ca') state.region = 'us'
      return { ok: true }
    },
  }
  return { channel, pages, captcha, opened, deliveries, state }
}
const CID = competitorId('Rival Gear')
const KEY = `amz__${CID}`
const sig = () => ({ title: '', text: '', captcha: false, passwordInputs: 0 })

function cloudPort() {
  const submitted: string[][] = []
  let polls = 0
  const view = (asins: string[], status: DataTaskView['status']): DataTaskView => ({
    id: 'task_1',
    capability: 'amazon.product',
    status,
    max_items: asins.length,
    item_count: status === 'succeeded' ? asins.length : 0,
    reserved_credits: 0.18 * asins.length,
    credits: status === 'succeeded' ? Math.round(0.18 * asins.length * 100) / 100 : 0,
    created_at: '2026-10-19T01:00:00.000Z',
    source: 'official',
  })
  let last: string[] = []
  return {
    submitted,
    polls: () => polls,
    port: {
      async submit(input: { input: Record<string, unknown> }) {
        last = input.input.asins as string[]
        submitted.push(last)
        return view(last, 'queued')
      },
      async task() {
        polls += 1
        return view(last, polls >= 2 ? 'succeeded' : 'running')
      },
      async items() {
        return {
          task_id: 'task_1',
          total: last.length,
          items: last.map((asin) => ({
            asin,
            title: `cloud ${asin}`,
            price: 999,
            currency: 'USD',
            rating: 4.2,
            reviews_count: 600,
            bsr: 3000,
            category: 'Sports & Outdoors › Cycling',
            in_stock: true,
          })),
        }
      },
    },
  }
}

function setup(opts: { maxPerHour?: number; cloud?: boolean } = {}) {
  const amz = amazon()
  const db = createCompetitorWatchDb()
  const store = db.forWorkspace(WS)
  let now = '2026-10-19T01:30:00.000Z'
  let seq = 0
  let watch: Pick<BrandWatch, 'brand' | 'competitors'> = {
    brand: { name: 'Nordvik', aliases: [], domains: ['nordvik.example'] },
    competitors: [],
  }
  const throttle = createSearchThrottle({
    now: () => Date.parse(now),
    random: () => {
      throw new Error('读 Amazon 不许用随机间隔')
    },
    sleep: async () => {},
    minGapMs: 0,
    maxGapMs: 0,
    ...(opts.maxPerHour === undefined ? {} : { maxPerHour: opts.maxPerHour }),
  })
  const reader = createAmazonFrontReader({
    workspace_id: WS,
    channel: () => amz.channel,
    page: (task) => throttle.run(task, { steady: true }),
    nowMs: () => Date.parse(now),
    state: () => store.kv<AmazonFrontState>('amazon_front') ?? {},
    saveState: (s) => store.setKv('amazon_front', s),
  })
  const cloud = cloudPort()
  let ac: ReturnType<typeof createAmazonCompetitor> | undefined
  const adapter = createAmazonAsinAdapter({
    reader: () => reader,
    cloud: () =>
      opts.cloud === false
        ? undefined
        : (input) =>
            readAmazonCloud(cloud.port, input, {
              sleep: async () => {},
              nowMs: () => Date.parse(now),
            }),
    store: () => store,
    onCredits: (id, c) => ac?.noteCredits(id, c),
  })
  const cw = createCompetitorWatch({
    workspace_id: WS,
    store,
    now: () => now,
    newId: (p) => `${p}_${++seq}`,
    tzOffsetMinutes: () => 480,
    brandWatch: async () => watch,
    adapters: () => ({ amazon_asin: adapter }),
  })
  ac = createAmazonCompetitor({
    workspace_id: WS,
    store,
    now: () => now,
    watch: () => cw,
    brandWatch: async () => watch,
    saveWatch: async (patch) => {
      watch = {
        brand: { ...watch.brand, amazon: patch.brand_amazon },
        competitors: patch.competitors,
      }
    },
    profile: () => ({
      name: 'Nordvik',
      category: 'Electric Bicycles',
      markets: ['US'],
      competitors: [{ name: 'Rival Gear' }],
    }),
    reader: () => reader,
  })
  return {
    amz,
    store,
    reader,
    cloud,
    cw,
    ac,
    watch: () => watch,
    setWatch: (w: typeof watch) => {
      watch = w
    },
    at: (iso: string) => {
      now = iso
    },
  }
}

const kit = (asks: string[] = []): SetupResearchKit & { notes: string[] } => {
  const notes: string[] = []
  return {
    notes,
    profile: async () => ({ category: 'Electric Bicycles', markets: ['US'] }),
    search: async () => undefined,
    ask: async (p) => {
      asks.push(p)
      return undefined
    },
    note: (t) => {
      notes.push(t)
    },
  }
}

describe('WP394 · 读 Amazon 前台那一块', () => {
  it('先设配送邮编（美国站 10001，一周内不重设）再读；页与页之间固定间隔', async () => {
    const t = setup()
    const a = await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })
    expect(a.status).toBe('ok')
    if (a.status === 'ok') expect(a.facts).toMatchObject({ price: 1299, currency: 'USD' })
    await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG03' })
    expect(t.amz.deliveries).toEqual(['https://www.amazon.com|10001'])
    expect(t.amz.opened).toHaveLength(2)
  })

  it('配送到加拿大（加元 + 不能配送）：这次作废、重设一次再读；再不对就照实说', async () => {
    const t = setup()
    t.amz.state.region = 'ca'
    const ok = await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })
    // 第一次设邮编就把替身拨回美国了：读一次就对
    expect(ok.status).toBe('ok')
    t.amz.state.region = 'stuck'
    const bad = await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })
    expect(bad.status).toBe('wrong_region')
    if (bad.status === 'wrong_region') expect(bad.message).toMatch(/Canada.*CAD.*作废/)
    // 重设了一次（强制）、又读了一次
    expect(t.amz.deliveries).toHaveLength(2)
    expect(t.amz.opened.filter((u) => u.endsWith('B0TESTRG01'))).toHaveLength(3)
  })

  it('验证页：暂停，之后一页 Amazon 都不开（不重试、不绕）', async () => {
    const t = setup()
    t.amz.captcha.add('B0TESTRG02')
    expect((await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG02' })).status).toBe(
      'blocked',
    )
    const before = t.amz.opened.length
    expect((await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })).status).toBe(
      'blocked',
    )
    expect((await t.reader.searchCards({ marketplace: 'US', query: 'x' })).status).toBe('blocked')
    expect(t.amz.opened.length).toBe(before)
    expect(t.reader.ready()).toBe(false)
    // 暂停 24 小时（和 WP398 联想词那一路一样长），过了才再读
    t.at('2026-10-20T01:00:00.000Z')
    expect(t.reader.ready()).toBe(false)
    t.at('2026-10-20T02:00:00.000Z')
    expect(t.reader.ready()).toBe(true)
  })

  it('这一小时额度满了：回 quota，不开页', async () => {
    const t = setup({ maxPerHour: 1 })
    // 第一页额度给了配送邮编那一下
    const r = await t.reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })
    expect(r.status).toBe('quota')
    expect(t.amz.opened).toEqual([])
  })

  it('WP396 那一口（原文）同样先设地址', async () => {
    const t = setup()
    const raw = await t.reader.readProduct({ marketplace: 'US', asin: 'B0TESTRG01' })
    expect(raw.status).toBe('ok')
  })
})

describe('WP394 · 方案卡（挑对标款）', () => {
  it('竞品按档案种、在 Amazon 搜「品牌名 + 品类」挑对标款，各配自家一款；没回模型就用规则版建议', async () => {
    const t = setup()
    t.setWatch({
      brand: {
        name: 'Nordvik',
        aliases: [],
        domains: [],
        amazon: [
          {
            marketplace: 'US',
            asin: 'B0OWNMINE1',
            label: 'Nordvik Ranger Electric Bike 750W Commuter',
          },
          { marketplace: 'US', asin: 'B0OWNMINE2', label: 'Nordvik Fold Folding Electric Bike' },
        ],
      },
      competitors: [],
    })
    const asks: string[] = []
    const k = kit(asks)
    const plan = await t.ac.setupTarget().research?.(k)
    expect(plan?.marketplace?.value).toBe('US')
    expect(plan?.own).toBeUndefined()
    const key = KEY
    expect(plan?.[key]?.value).toBe(
      'B0TESTRG01 = B0OWNMINE1；B0TESTRG03 = B0OWNMINE1；B0TESTRG02 = B0OWNMINE2',
    )
    // WP420（自查 U15）：每款一行「短名 · $价格 · ★评分」（不再一大段理由）
    expect(plan?.[key]?.why?.split('\n')).toHaveLength(3)
    expect(plan?.[key]?.why).toMatch(/Rival Gear[^\n]* · \$\d/u)
    expect(t.amz.opened.some((u) => u.includes('/s?k=Rival%20Gear%20Electric%20Bicycles'))).toBe(
      true,
    )
    expect(plan?.price_drop_pct?.value).toBe('8')
    expect(plan?.cheaper_than_own?.value).toBe('true')
    expect(plan?.every_hours?.value).toBe('24')
    expect(asks).toHaveLength(1)
    expect(k.notes.join('')).not.toMatch(/apify|keepa/i)
  })

  it('自家 ASIN 没有：要一个店铺 / 商品链接（不让从零列）；没有内置浏览器就要人填 ASIN', async () => {
    const t = setup()
    const plan = await t.ac.setupTarget().research?.(kit())
    expect(plan?.own?.needs_you).toBe(true)
    expect(plan?.own?.why).toMatch(/店铺或商品链接/)
  })

  it('存下：写回唯一工作清单（竞品对标款 + 自家 ASIN）、先读一次当底子（不报变化）', async () => {
    const t = setup()
    await t.ac.setupTarget().apply({
      marketplace: 'US',
      own: 'https://www.amazon.com/dp/B0OWNMINE1；B0OWNMINE2',
      [KEY]: 'B0TESTRG01 = B0OWNMINE1；B0TESTRG02 = B0OWNMINE2',
      price_drop_pct: '8',
      cheaper_than_own: 'true',
      discounts: 'true',
      stock: 'false',
      rating_below: '4',
      every_hours: '24',
    })
    expect(await t.ac.setupTarget().satisfied()).toBe(true)
    const w = t.watch()
    expect(w.brand.amazon?.map((x) => x.asin)).toEqual(['B0OWNMINE1', 'B0OWNMINE2'])
    expect(w.competitors[0]?.amazon).toEqual([
      { marketplace: 'US', asin: 'B0TESTRG01', vs_own: 'B0OWNMINE1' },
      { marketplace: 'US', asin: 'B0TESTRG02', vs_own: 'B0OWNMINE2' },
    ])
    const r = await t.ac.readNow({})
    expect(r.changes).toEqual([])
    expect(
      t.cw
        .sources()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['cw_amz__own_US', `cw_amz_${CID}_US`].sort())
  })

  it('认不出的格子照实拒；超过 100 个 ASIN 拒', async () => {
    const t = setup()
    await expect(
      t.ac.setupTarget().apply({ marketplace: 'US', own: 'hello', every_hours: '24' }),
    ).rejects.toThrow(/认不出/)
    await expect(
      t.ac.setupTarget().apply({
        marketplace: 'US',
        own: 'B0OWNMINE1',
        [KEY]: 'B0TESTRG01 = ???',
        every_hours: '24',
      }),
    ).rejects.toThrow(/Rival Gear 那一格认不出/)
    const many = Array.from({ length: 101 }, (_, i) => `B0MANY${String(i).padStart(4, '0')}`).join(
      '；',
    )
    await expect(
      t.ac.setupTarget().apply({ marketplace: 'US', own: many, every_hours: '24' }),
    ).rejects.toThrow(/最多盯 100 个/)
    expect(parseAmazonPairs('B0TESTRG01=B0OWNMINE1, B0TESTRG02').items).toEqual([
      { asin: 'B0TESTRG01', vs_own: 'B0OWNMINE1' },
      { asin: 'B0TESTRG02' },
    ])
  })
})

const CONFIRM = {
  marketplace: 'US',
  own: 'B0OWNMINE1；B0OWNMINE2',
  [KEY]: 'B0TESTRG01 = B0OWNMINE1；B0TESTRG02 = B0OWNMINE2；B0TESTRG03 = B0OWNMINE1',
  price_drop_pct: '8',
  cheaper_than_own: 'true',
  discounts: 'true',
  stock: 'false',
  rating_below: '4',
  every_hours: '24',
}

describe('WP394 · 第二天：降价、比你便宜多少、算不算重要', () => {
  it('对标款降到比你的 Ranger 便宜 → 一条改价，带 vs_own 差价、按确认过的规则算重要；价格是美元、BSR 有数', async () => {
    const t = setup()
    await t.ac.setupTarget().apply(CONFIRM)
    await t.ac.readNow({})
    const base = t.store.snapshot(`cw_amz_${CID}_US`)
    expect(base?.rows.find((r) => r.product_key === 'B0TESTRG01')).toMatchObject({
      currency: 'USD',
      price: 1299,
      bsr: [
        { rank: 1234, category: 'Sports & Outdoors' },
        { rank: 5, category: 'Electric Bicycles' },
      ],
    })
    // 第二天：Trail 500 从 $1,299 降到 $1,149（-11.5%），比你的 Ranger（$1,399）便宜 $250
    t.at('2026-10-20T01:30:00.000Z')
    t.amz.pages.B0TESTRG01 = (t.amz.pages.B0TESTRG01 as string)
      .replace(/\$1,299\.00/g, '$1,149.00')
      .replace(/>1,299</g, '>1,149<')
    const r = await t.ac.readNow({ competitor: 'Rival Gear' })
    const price = r.changes?.find((c) => c.kind === 'price')
    expect(price).toMatchObject({
      competitor: 'Rival Gear',
      before: 1299,
      after: 1149,
      pct: -11.5,
      vs_own: { diff: -250, currency: 'USD' },
      important: true,
    })
    expect(r.credits).toBeUndefined()
    expect(r.say).toBeUndefined()
  })
})

describe('WP394 · 被拦 → 不重试不绕、走云端、积分照扣、对话里说一句', () => {
  it('第二款碰到验证页：之后不再开 Amazon，剩下的走云端；划线价 / 优惠券照实空着、不报打折结束', async () => {
    const t = setup()
    await t.ac.setupTarget().apply(CONFIRM)
    await t.ac.readNow({})
    t.at('2026-10-20T01:30:00.000Z')
    t.amz.captcha.add('B0TESTRG02')
    const opened = t.amz.opened.length
    const r = await t.ac.readNow({ competitor: 'Rival Gear' })
    // 读了 RG01（最早读的那几个先读）……碰到 RG02 的验证页就停：RG02、RG03 走云端
    const after = t.amz.opened.slice(opened)
    expect(after.filter((u) => u.includes('B0TESTRG02'))).toHaveLength(1)
    expect(after.some((u) => u.includes('B0TESTRG03'))).toBe(false)
    expect(t.cloud.submitted.at(-1)?.sort()).toEqual(['B0TESTRG02', 'B0TESTRG03'])
    expect(r.credits).toBe(0.36)
    expect(r.say).toMatch(/人机验证.*没再读、也没绕.*工坊云端数据/)
    expect(r.say).toMatch(/扣了 0.36 积分/)
    expect(r.say).not.toMatch(/apify|keepa|junglee/i)
    // RG03 昨天有划线价和优惠券、今天云端读不到：不报「打折结束」
    expect(r.changes?.some((c) => c.kind === 'discount_end')).toBe(false)
    const rg03 = t.store
      .snapshot(`cw_amz_${CID}_US`)
      ?.rows.find((x) => x.product_key === 'B0TESTRG03')
    expect(rg03?.compare_at_price).toBe(1899.99)
    // 暂停期里再读一次：一页 Amazon 都不开，整条直接走云端
    const n = t.amz.opened.length
    const again = await t.ac.readNow({ competitor: 'Rival Gear' })
    expect(t.amz.opened.length).toBe(n)
    expect(again.say).toMatch(/扣了 0.54 积分/)
  })

  it('没有桌面壳也没关联账号：照实说没读（不出 0、不编）', async () => {
    const t = setup({ cloud: false })
    await t.ac.setupTarget().apply(CONFIRM)
    await t.ac.readNow({})
    t.amz.captcha.add('B0TESTRG01')
    t.amz.captcha.add('B0TESTRG02')
    t.amz.captcha.add('B0TESTRG03')
    t.at('2026-10-20T01:30:00.000Z')
    const r = await t.ac.readNow({ competitor: 'Rival Gear' })
    expect(r.read?.[0]?.status).toBe('failed')
    expect(r.say).toMatch(/Rival Gear 这次没读到/)
  })
})

describe('WP394 · ASIN 多的分几个小时读完', () => {
  it('这一小时额度满了：读到的先记、标没读全（不判下架），一小时后接着读剩下的', async () => {
    const t = setup({ maxPerHour: 4 })
    await t.ac.setupTarget().apply(CONFIRM)
    await t.ac.readNow({})
    const src = t.cw.sources().find((s) => s.id === `cw_amz_${CID}_US`)
    expect(src?.last_complete).toBe(false)
    const due = dueSources({
      now: '2026-10-19T02:30:00.000Z',
      tz_offset_minutes: 480,
      settings: t.cw.settings(),
      sources: t.cw.sources(),
    })
    expect(due).toContain(`cw_amz_${CID}_US`)
  })
})

describe('WP394 · 工具与 stub', () => {
  const req = (role_id: string) =>
    ({
      workspace_id: WS,
      actor: { role_id },
      tools: { allow: ['request_setup'] },
    }) as unknown as RunRequest

  it('还没配好：现在读一次回 needs_setup（运行时出方案卡）；只给亚马逊店铺运营', async () => {
    const t = setup()
    const exec = createAmazonCompetitorTools({ of: async () => t.ac })
    const out = await exec({
      name: 'read_amazon_competitors',
      input: {},
      request: req('amz.store'),
    })
    expect(out).toMatchObject({ status: 'ok', data: { needs_setup: 'amazon.competitor_watch' } })
    const no = await exec({ name: 'read_amazon_competitors', input: {}, request: req('dtc.store') })
    expect(no.status).toBe('blocked')
  })

  it('stub：「帮我盯 Amazon 上的竞品」→ 要 Amazon 竞品方案卡（不是独立站那张）', () => {
    const got = setupRequestBranch(
      req('amz.store'),
      '帮我盯 Amazon 上的竞品：先挑几款对标款，说说它们的价格、评分和排名',
    )
    expect(got).toMatchObject({
      tool: 'request_setup',
      input: { setting: 'amazon.competitor_watch' },
    })
  })

  it('云端那一路：提交 → 等跑完 → 取全部；扣的积分照任务实扣数', async () => {
    const c = cloudPort()
    const got = await readAmazonCloud(
      c.port,
      { marketplace: 'US', asins: ['B0TESTRG01'] },
      { sleep: async () => {}, nowMs: () => 0 },
    )
    expect(got).toMatchObject({ credits: 0.18, items: [{ asin: 'B0TESTRG01', price: 999 }] })
    expect(c.polls()).toBe(2)
  })
})
