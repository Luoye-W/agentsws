/**
 * WP450（docs/109 §5.2 #9–11、17）：服务端——出一组主题（一张卡批整组）→ 排进编辑日历 → 到日子开写作事项；
 * 外链体检用录好的回包跑出变化与交公关清单；改写成社媒稿落到社媒运营的事项里；llms.txt 生成并交建站。
 * 真的审批总线，上游全是替身（搜索数据、官方数据接口、Search Console），不联网、不花钱。
 */
import type { DataCallResult, DataCapabilityList, GscRow } from '@agentsws/contracts'
import {
  BACKLINK_SAMPLE_COMPETITORS,
  BACKLINK_SAMPLE_ROWS,
  BACKLINK_SAMPLE_SUMMARY,
  PLAN_SAMPLE_OVERVIEW,
  planSampleSerp,
  standInSearchData,
  unconfiguredSearchData,
} from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createSeoPlan, type SeoPlanOptions } from '../src/seo-plan.js'

const actor = (role_id: string, person_id: string) => ({
  workspace_id: 'ws_1',
  person_id,
  assignment_id: `asg_${role_id}`,
  role_id,
})
const HOLDERS: Record<string, ReturnType<typeof actor>> = {
  'dtc.seo': actor('dtc.seo', 'p_li'),
  'dtc.content': actor('dtc.content', 'p_zhao'),
  'pr.press': actor('pr.press', 'p_pr'),
  'site.shopify-theme': actor('site.shopify-theme', 'p_site'),
  'social.x': actor('social.x', 'p_x'),
  'social.linkedin': actor('social.linkedin', 'p_x'),
  'social.tiktok': actor('social.tiktok', 'p_v'),
}

const GSC: GscRow[] = [
  {
    query: 'gan charger',
    page: 'https://shop.example/blogs/guide/gan-chargers-explained',
    clicks: 41,
    impressions: 2300,
    ctr: 0.018,
    position: 8.2,
  },
  {
    query: 'nordvolt',
    page: 'https://shop.example/',
    clicks: 300,
    impressions: 900,
    ctr: 0.33,
    position: 1,
  },
]

const caps: DataCapabilityList = {
  at: '2026-10-20T00:00:00.000Z',
  capabilities: [
    {
      id: 'seo.backlink_summary',
      label_zh: '外链概况',
      label_en: 'Backlink summary',
      group: 'seo',
      mode: 'sync',
      unit: 'call',
      credits_per_unit: 0.88,
      available: true,
      input: [],
    },
    {
      id: 'seo.backlinks',
      label_zh: '外链列表',
      label_en: 'Backlinks',
      group: 'seo',
      mode: 'sync',
      unit: 'row',
      credits_per_unit: 0.01,
      available: true,
      input: [],
    },
  ],
}

function setup(over: Partial<SeoPlanOptions> = {}) {
  let now = '2026-10-25T00:00:00.000Z'
  const txn = createTxn({
    clock: { now: () => now },
    random: () => 0.5,
    eventSink: () => undefined,
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const matters: {
    id: string
    title: string
    summary?: string
    role_id?: string
    participants?: string[]
  }[] = []
  const dataCalls: { capability: string; input: Record<string, unknown> }[] = []
  const data = {
    capabilities: async () => caps,
    call: async (
      capability: string,
      input: { input: Record<string, unknown> },
    ): Promise<DataCallResult> => {
      dataCalls.push({ capability, input: input.input })
      if (capability === 'seo.keyword_overview') return PLAN_SAMPLE_OVERVIEW
      if (capability === 'seo.backlink_summary') return BACKLINK_SAMPLE_SUMMARY
      const target = String(input.input.target)
      if (target === 'shop.example') return BACKLINK_SAMPLE_ROWS
      const comp = BACKLINK_SAMPLE_COMPETITORS.get(target)
      if (comp === undefined) throw new Error('没有这家')
      return comp
    },
  }
  const search = standInSearchData({ serp: planSampleSerp() })
  const holders = { ...HOLDERS }
  const plan = createSeoPlan({
    workspace_id: 'ws_1' as never,
    clock: { now: () => now },
    approvals: txn.approvals,
    holderOf: (r) => holders[r] as never,
    work: {
      createMatter: (input) => {
        const m = { id: `mat_${String(matters.length + 1)}`, ...input }
        matters.push(m as never)
        return { id: m.id }
      },
    },
    searchConsole: () => ({
      connected: () => true,
      rows: async () => GSC,
      pages: async () => [],
    }),
    searchData: () => search,
    dataService: () => data,
    brand: () => ({
      name: 'NordVolt Gear',
      language: 'en',
      domains: ['shop.example'],
      shop_host: 'shop.example',
      currency: 'USD',
      country: 'us',
      subcategory: 'usb c charger',
      one_liner: 'USB-C chargers and cables for travel and desk.',
    }),
    competitors: async () => ['voltpeak.example', 'chargely.example'],
    publishedPosts: async () => [
      {
        change_id: 'chg_post_1',
        title: 'Usb C Charger: The Complete Guide',
        url: 'https://shop.example/blogs/guide/usb-c-charger-guide',
        published_at: '2026-10-26T09:00:00.000Z',
        body: '<p>Most laptops need 65W or more.</p><h2>Check the wattage</h2><p>A 65W charger covers most 13-inch laptops.</p><h2>Look for GaN</h2><p>GaN chargers run cooler.</p>',
      },
    ],
    siteUrls: async () => ({
      origin: 'https://shop.example',
      urls: [
        'https://shop.example/collections/chargers',
        'https://shop.example/collections/cables',
        'https://shop.example/products/usb-c-65w-charger',
      ],
    }),
    ...over,
  })
  return {
    plan,
    txn,
    matters,
    dataCalls,
    search,
    holders,
    setNow: (v: string) => {
      now = v
    },
  }
}

const approve = async (s: ReturnType<typeof setup>, id: string) => {
  const card = await s.txn.approvals.get(id)
  const token = card?.deliveries.find((d) => d.to === 'p_li')?.decision_token ?? ''
  const decided = await s.txn.approvals.decide(id, 'p_li', {
    action: 'approve',
    decision_token: token,
    via: 'web',
  })
  await s.plan.onDecided(decided)
}

describe('WP450 主题簇 → 编辑日历 → 到日子开写作事项', () => {
  it('合成数据出一组，一张卡批整组，按每天 2 篇排进日历，到日子给内容与博客开事项', async () => {
    const s = setup()
    const est = await s.plan.planEstimate()
    expect(est).toMatchObject({ available: true, serp_calls: 21 })
    const out = await s.plan.planClusters()
    expect(out.skipped).toBeUndefined()
    expect(out.cluster?.pillar.keyword).toBe('usb c charger')
    // 品类词一次 + 候选词各一次；关键词概况一次
    expect(s.search.calls.filter((c) => c.kind === 'serp').length).toBeGreaterThanOrEqual(7)
    expect(s.dataCalls.map((c) => c.capability)).toEqual(['seo.keyword_overview'])
    expect(out.cost.credits).toBeGreaterThan(0)
    const card = await s.txn.approvals.get(out.approval_item_id ?? '')
    expect(card?.kind).toBe('seo_cluster')
    expect(card?.title).toBe('一组主题：usb c charger（5 篇）')
    expect(card?.summary).not.toMatch(/dataforseo|semrush/i)
    const payload = card?.payload as { writer: string; schedule: { date: string }[] }
    expect(payload.writer).toBe('content')
    expect((await s.plan.calendarView()).pending).toHaveLength(1)

    await approve(s, out.approval_item_id ?? '')
    const view = await s.plan.calendarView()
    expect(view.pending).toBeUndefined()
    expect(view.entries.map((e) => e.date)).toEqual([
      '2026-10-26',
      '2026-10-26',
      '2026-10-27',
      '2026-10-27',
      '2026-10-28',
    ])
    expect(view.entries[0]).toMatchObject({ role: 'pillar', status: 'scheduled' })
    expect(view.entries.find((e) => e.keyword === 'gan charger')?.kind).toBe('refresh')
    expect(view.clusters).toEqual([
      { id: expect.any(String), topic: 'usb c charger', total: 5, published: 0 },
    ])

    // 还没到日子：不开
    expect(await s.plan.tickCalendar()).toEqual({ opened: 0 })
    s.setNow('2026-10-26T08:00:00.000Z')
    expect(await s.plan.tickCalendar()).toEqual({ opened: 2 })
    expect(s.matters).toHaveLength(2)
    expect(s.matters[0]?.role_id).toBe('dtc.content')
    expect(s.matters[0]?.title).toContain('编辑日历 2026-10-26')
    expect(s.matters[0]?.summary).toContain('总页')
    // 同一天再跑一次不重开
    expect(await s.plan.tickCalendar()).toEqual({ opened: 0 })
    // 发出去了（标题里有这篇的词）→ 日历上标「已发布」
    const after = await s.plan.calendarView()
    expect(after.entries.find((e) => e.role === 'pillar')?.status).toBe('published')
    expect(after.published[0]?.change_id).toBe('chg_post_1')
  })

  it('没接搜索数据：不出卡，照实说', async () => {
    const s = setup({ searchData: () => unconfiguredSearchData() })
    const out = await s.plan.planClusters()
    expect(out.approval_item_id).toBeUndefined()
    expect(out.skipped).toBeDefined()
    expect((await s.plan.planEstimate()).available).toBe(false)
  })
})

describe('WP450 外链体检：录好的回包', () => {
  it('跑出来源域名变化、锚文本、可疑来源，竞品差距 Top 10 交公关；一个月一次，可关', async () => {
    const s = setup()
    const view = await s.plan.backlinkView()
    expect(view).toMatchObject({ available: true, next_due: '2026-10-25', estimate: { calls: 4 } })
    expect(view.estimate.credits).toBeCloseTo(0.88 + 0.01 * 100 * 3)
    // 第一次：没有上一次可比
    const first = await s.plan.backlinkDue()
    expect(first?.status).toBe('ok')
    expect(first?.change).toBeUndefined()
    expect(first?.gap).toHaveLength(10)
    expect(first?.handed_to_pr?.sites).toBe(10)
    const pr = s.matters.find((m) => m.role_id === 'pr.press')
    expect(pr?.title).toContain('10 个站链了竞品')
    expect(pr?.summary).toContain('techradar-like.example')
    expect(pr?.summary).not.toMatch(/dataforseo|semrush|ahrefs/i)
    expect(first?.cost.calls).toBe(4)
    // 不到 30 天不再跑
    s.setNow('2026-11-10T00:00:00.000Z')
    expect(await s.plan.backlinkDue()).toBeUndefined()
    // 满 30 天：再跑一次，和上一次比（这次样本里少了来源域名就会报）
    s.setNow('2026-11-25T00:00:00.000Z')
    const second = await s.plan.backlinkDue()
    expect(second?.previous?.referring_domains).toBe(142)
    expect(second?.change).toEqual({ referring_domains: 0, pct: 0 })
    expect(second?.issues.map((i) => i.rule)).toContain('anchor_concentration')
    expect(second?.suspicious[0]?.domain).toBe('linkfarm-seo.example')
    // 关掉之后不跑
    await s.plan.setBacklinkSettings({ enabled: false })
    s.setNow('2027-01-01T00:00:00.000Z')
    expect(await s.plan.backlinkDue()).toBeUndefined()
    expect((await s.plan.backlinkView()).next_due).toBeUndefined()
  })

  it('没关联官方数据接口：不跑、不花钱', async () => {
    const s = setup({ dataService: () => undefined })
    expect(await s.plan.backlinkDue()).toBeUndefined()
    const run = await s.plan.backlinkAudit('manual')
    expect(run.status).toBe('skipped')
    expect(run.notes[0]).toContain('关联')
  })
})

describe('WP450 改写成社媒稿', () => {
  it('一键起草四个渠道，有人担的开事项交社媒运营，没人担的照实跳过；只起草不发', async () => {
    const s = setup()
    const out = await s.plan.repurpose({ change_id: 'chg_post_1' })
    expect(out.drafts.map((d) => d.channel)).toEqual(['x', 'linkedin', 'short_video'])
    expect(out.skipped).toEqual([{ channel: 'reddit', reason: '没人担Reddit 帖子那条社媒职责' }])
    expect(out.matters.map((m) => m.role_id)).toEqual([
      'social.x',
      'social.linkedin',
      'social.tiktok',
    ])
    const x = s.matters.find((m) => m.role_id === 'social.x')
    expect(x?.title).toBe('起草好了：X 串推（文章「Usb C Charger: The Complete Guide」）')
    expect(x?.summary).toContain('只起草、没发')
    expect(x?.participants).toEqual(['p_x'])
    expect((await s.plan.calendarView()).published[0]?.repurpose_matters).toHaveLength(3)
  })

  it('模型写的草稿里编的经历与数字照样拿掉', async () => {
    const s = setup({
      drafter: () => async () => ({
        text: 'A 65W charger covers most 13-inch laptops.\nWe tested 40 chargers and ours won.',
      }),
    })
    const out = await s.plan.repurpose({ change_id: 'chg_post_1', channels: ['x'] })
    expect(out.drafts[0]?.by).toBe('model')
    expect(out.drafts[0]?.text).not.toContain('40 chargers')
    expect(out.drafts[0]?.placeholders[0]).toContain('YOUR REAL EXPERIENCE')
  })
})

describe('WP450 llms.txt', () => {
  it('按网站结构生成，交建站（网页模板那一条）放上去，事项里写清在 Shopify 上怎么放', async () => {
    const s = setup()
    const v = await s.plan.llmsGenerate({ handoff: true })
    expect(v.draft?.content.startsWith('# NordVolt Gear\n\n> USB-C chargers')).toBe(true)
    expect(v.handed_to_site?.matter_id).toBeDefined()
    const m = s.matters.find((x) => x.role_id === 'site.shopify-theme')
    expect(m?.summary).toContain('llms.txt.liquid')
    expect(m?.summary).toContain('不用装 App')
    expect(v.placement.length).toBeGreaterThan(3)
  })
})

describe('WP450 体检里那一项：llms.txt 有没有、内容过不过时', () => {
  const O = 'https://shop.example'
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
    '/',
    '/collections/chargers',
    '/collections/cables',
    '/products/usb-c-65w-charger',
  ]
    .map((p) => `<url><loc>${O}${p}</loc></url>`)
    .join('')}</urlset>`
  const health = async (llms: string | undefined) => {
    const { createSiteHealthService } = await import('../src/site-health.js')
    const pages: Record<string, string> = {
      [`${O}/robots.txt`]: 'User-agent: *\nAllow: /\n',
      [`${O}/sitemap.xml`]: sitemap,
      [`${O}/`]: '<html><head><title>NordVolt</title></head><body><h1>NordVolt</h1></body></html>',
      ...(llms === undefined ? {} : { [`${O}/llms.txt`]: llms }),
    }
    const svc = createSiteHealthService({
      clock: { now: () => '2026-10-25T00:00:00.000Z' },
      newId: (p) => `${p}_1`,
      origin: async () => O,
      fetch: async (url) => ({
        ok: pages[url] !== undefined,
        status: pages[url] === undefined ? 404 : 200,
        url,
        text: async () => pages[url] ?? '',
      }),
      shop: async () => undefined,
      llmsBrand: async () => ({ name: 'NordVolt Gear' }),
    })
    return svc
  }

  it('没有 → missing；旧的少了合集、写着已经没有的页 → stale；生成的那份 → current', async () => {
    expect((await (await health(undefined)).run()).llms_txt?.state).toBe('missing')
    const old =
      '# NordVolt Gear\n\n- [Chargers](https://shop.example/collections/chargers)\n- [Old](https://shop.example/collections/discontinued)\n'
    const stale = (await (await health(old)).run()).llms_txt
    expect(stale?.state).toBe('stale')
    expect(stale?.missing_links).toContain('https://shop.example/collections/cables')
    expect(stale?.dead_links).toEqual(['https://shop.example/collections/discontinued'])
    // 体检读过的站点地图留给 llms.txt 生成用
    const svc = await health(undefined)
    await svc.run()
    expect((await svc.sitemapUrls())?.urls).toContain('https://shop.example/collections/cables')
    const s = setup({ siteUrls: () => svc.sitemapUrls() })
    const draft = (await s.plan.llmsGenerate()).draft?.content ?? ''
    expect((await (await health(draft)).run()).llms_txt?.state).toBe('current')
  })
})
