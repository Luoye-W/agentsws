/**
 * WP346（决策 872）：品牌分析第二版——服务端这一侧。
 *
 * 钉住：
 * 1. 确认后 AI 那几格写进品牌档案，没人改过的标「AI 建议」，卡上改过的不标；
 * 2. 设置页改一格 / 点「对」就拿掉标；
 * 3. 「重新分析一次」只出对比、不覆盖；逐格采纳只写勾的那几格（人改过的不动）；
 * 4. 没接模型：AI 那几格跳过，照旧出解析结果；
 * 5. 下游四处读到档案值：红人搜索关键词、GEO 建议、广告（岗位提示词里的品牌上下文）、Reddit 巡查的品牌资料。
 *
 * 抓取口与模型口都是替身（本地夹具、写死的回复），不联网、不花钱。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import type { WorkspaceProfile } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createGeoMonitor } from '../src/geo-monitor.js'
import { createGeoStore } from '../src/geo-store.js'
import { createServer, type Server } from '../src/index.js'
import { createKolToolExecutor } from '../src/kol-tools.js'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
)
const TRAIL = 'https://trailmark.example'
const PAGES: Record<string, string> = {
  [`${TRAIL}/robots.txt`]: 'robots.txt',
  [`${TRAIL}/`]: 'specs-home.html',
  [`${TRAIL}/pages/about`]: 'specs-home.html',
  [`${TRAIL}/products/ridge-28`]: 'specs-ridge.html',
  [`${TRAIL}/products/summit-40`]: 'specs-summit.html',
}
const replay: PageFetch = async (url) => {
  const name = PAGES[url]
  if (name === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
}

const FIRST = {
  category: 'hiking backpacks',
  subcategory: 'daypacks',
  positioning: '给带娃徒步的家长做的轻量背包。',
  price_band: '$119-$189',
  audience: { buyers: '周末带孩子徒步的家长', concerns: ['背着累不累'] },
  keywords: {
    brand: ['Trailmark'],
    category: ['hiking daypack', 'hiking backpack'],
    scenario: ['hiking with kids'],
  },
  competitors: [
    { name: 'Osprey', reason: '同价位徒步背包', url: 'https://www.osprey.com' },
    { name: 'Deuter', reason: '亲子背负系列' },
  ],
}
const SECOND = {
  ...FIRST,
  positioning: '给周末出门的城市家庭做的徒步背包。',
  keywords: { brand: ['Trailmark'], category: ['family hiking pack'], scenario: [] },
  competitors: [{ name: 'Gregory', reason: '新竞品' }],
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(options: { model?: boolean } = {}) {
  let reply: unknown = FIRST
  const prompts: string[] = []
  let t = Date.parse('2026-10-15T09:00:00.000Z')
  const server = await createServer({
    clock: {
      now: () => {
        t += 1
        return new Date(t).toISOString()
      },
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'Trailmark' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: replay,
    ...(options.model === false
      ? {}
      : {
          brandIntakeModel: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt)
            return { text: JSON.stringify(reply) }
          },
        }),
  })
  servers.push(server)
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': server.bootstrap.ownerAssignment.id,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const parsed = (await res.json()) as { data?: T; message?: string }
    return { status: res.status, data: parsed.data as T, message: parsed.message }
  }
  type Run = {
    id: string
    status: string
    insights?: string
    profile: Record<string, { value: unknown; edited?: boolean } | undefined>
  }
  const analyze = async (): Promise<Run> => {
    const started = await call<Run>('POST', '/v1/brand-intake/runs', { urls: [`${TRAIL}/`] })
    expect(started.status, started.message).toBe(201)
    for (let i = 0; i < 400; i++) {
      const run = (await call<Run>('GET', `/v1/brand-intake/runs/${started.data.id}`)).data
      if (run.status !== 'running') return run
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('分析没跑完')
  }
  const ws = server.bootstrap.workspace.id
  const archive = () => server.onboarding.brandProfile(ws) as Partial<WorkspaceProfile>
  return {
    server,
    call,
    analyze,
    archive,
    prompts,
    setReply: (r: unknown) => {
      reply = r
    },
  }
}

describe('WP346 确认 → 写进档案（AI 建议要人确认）', () => {
  it('确认后新格子写进档案；没改的标「AI 建议」，卡上改过的不标；设置页改 / 点「对」拿掉标', async () => {
    const f = await boot()
    const run = await f.analyze()
    expect(run.status).toBe('awaiting_confirm')
    expect(run.insights).toBe('done')
    expect(f.prompts).toHaveLength(1)
    // 人在卡上改了竞品
    const confirmed = await f.call('POST', `/v1/brand-intake/runs/${run.id}/confirm`, {
      edits: { competitors: [{ name: 'Osprey', reason: '我们最常被拿来比的' }] },
    })
    expect(confirmed.status, confirmed.message).toBe(200)
    const a = f.archive()
    expect(a.positioning).toBe(FIRST.positioning)
    expect(a.subcategory).toBe('daypacks')
    expect(a.price_band).toBe('$119-$189')
    expect(a.audience?.buyers).toBe('周末带孩子徒步的家长')
    expect(a.keywords?.category).toEqual(['hiking daypack', 'hiking backpack'])
    expect(a.competitors).toEqual([{ name: 'Osprey', reason: '我们最常被拿来比的' }])
    expect(a.category).toBe('hiking backpacks')
    expect(a.website).toBe(`${TRAIL}/`)
    expect(a.ai_suggested).toEqual([
      'category',
      'subcategory',
      'positioning',
      'price_band',
      'audience',
      'keywords',
    ])

    // 设置页：改关键词 + 对人群点「对」→ 这两格不再是 AI 建议
    const put = await f.call<{ ai_suggested?: string[]; keywords?: unknown }>(
      'PUT',
      '/v1/workspace/profile',
      {
        legal_name: 'Trailmark',
        keywords: { brand: ['Trailmark'], category: ['kids hiking backpack'], scenario: [] },
        confirm_fields: ['audience'],
      },
    )
    expect(put.status, put.message).toBe(200)
    expect(put.data.ai_suggested).toEqual(['category', 'subcategory', 'positioning', 'price_band'])
    expect(f.archive().audience?.buyers).toBe('周末带孩子徒步的家长')
    // 清空：null / 空串
    await f.call('PUT', '/v1/workspace/profile', {
      legal_name: 'Trailmark',
      audience: null,
      price_band: '',
    })
    expect(f.archive().audience).toBeUndefined()
    expect(f.archive().price_band).toBeUndefined()
    expect(f.archive().ai_suggested).toEqual(['category', 'subcategory', 'positioning'])
  })

  it('没接模型：AI 那几格跳过，照旧出解析结果（品牌名、商品规格）', async () => {
    const f = await boot({ model: false })
    const run = await f.analyze()
    expect(run.status).toBe('awaiting_confirm')
    expect(run.insights).toBe('no_model')
    expect(run.profile.brand_name?.value).toBe('Trailmark')
    expect(run.profile.audience).toBeUndefined()
    const products = run.profile.products?.value as { specs?: unknown[] }[]
    expect(products[0]?.specs?.length).toBeGreaterThan(0)
  })
})

describe('WP346 老品牌重跑：只出对比、逐格采纳', () => {
  it('重跑不碰档案；采纳只写勾的那几格，人改过的不动', async () => {
    const f = await boot()
    const first = await f.analyze()
    await f.call('POST', `/v1/brand-intake/runs/${first.id}/confirm`, {
      edits: { competitors: [{ name: 'Osprey', reason: '人写的' }] },
    })
    const before = structuredClone(f.archive())

    f.setReply(SECOND)
    const again = await f.analyze()
    expect(again.profile.positioning?.value).toBe(SECOND.positioning)
    // 只出对比：档案一格都没变
    expect(f.archive()).toEqual(before)

    const adopted = await f.call<{ status: string }>(
      'POST',
      `/v1/brand-intake/runs/${again.id}/adopt`,
      { fields: ['positioning', 'brand_name'] },
    )
    expect(adopted.status, adopted.message).toBe(200)
    expect(adopted.data.status).toBe('confirmed')
    const after = f.archive()
    expect(after.positioning).toBe(SECOND.positioning)
    // 没勾的（关键词）、人改过的（竞品）都不动；品牌名不在能采纳的格子里
    expect(after.keywords).toEqual(before.keywords)
    expect(after.competitors).toEqual([{ name: 'Osprey', reason: '人写的' }])
    expect(after.ai_suggested).toContain('positioning')

    // 采纳时顺手改值：算人给的（不挂 AI 标）
    await f.call('POST', `/v1/brand-intake/runs/${again.id}/adopt`, {
      fields: ['keywords'],
      edits: { keywords: { brand: [], category: ['trail daypack'], scenario: [] } },
    })
    expect(f.archive().keywords?.category).toEqual(['trail daypack'])
    expect(f.archive().ai_suggested).not.toContain('keywords')
  })
})

describe('WP346 下游统一读档案', () => {
  it('广告 / 各岗位：品牌上下文里带人群、关键词、竞品（AI 建议的注明待核）', async () => {
    const f = await boot()
    const run = await f.analyze()
    await f.call('POST', `/v1/brand-intake/runs/${run.id}/confirm`, {
      edits: { competitors: [{ name: 'Osprey', reason: '人写的' }] },
    })
    const brand = f.server.personas
      .sections({ role_id: 'ads.google', workspace_id: f.server.bootstrap.workspace.id })
      .find((s) => s.id === 'brand')
    expect(brand?.text).toContain('目标人群：周末带孩子徒步的家长')
    expect(brand?.text).toContain('品类词 hiking daypack、hiking backpack')
    expect(brand?.text).toContain('（AI 归纳，待人核）')
    expect(brand?.text).toContain('主要竞品：Osprey')
    expect(brand?.text).not.toMatch(/主要竞品：Osprey（AI/)
  })

  it('红人：模型没给关键词时按档案里的品类关键词搜；一个没搜到就退回不带关键词', async () => {
    const asked: string[] = []
    let rows: unknown[] = []
    const port = {
      search: async (_: unknown, input: { q: string }) => {
        asked.push(input.q)
        return { ok: true, source: 'channel', rows: input.q === '' ? [{ handle: 'all' }] : rows }
      },
    }
    const exec = createKolToolExecutor({
      workspace_id: 'ws_1' as never,
      port: () => port as never,
      now: () => '2026-10-15T00:00:00.000Z',
      brandQuery: () => 'hiking daypack，hiking backpack',
    })
    const request = {
      actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'kol.youtube' },
    } as never
    rows = [{ handle: 'trailmom' }]
    const hit = await exec({ name: 'search_creators', input: {}, request })
    expect(asked).toEqual(['hiking daypack，hiking backpack'])
    expect((hit?.data as { criteria?: string } | undefined)?.criteria).toContain('品牌档案')
    // 模型自己给了关键词：照它的
    await exec({ name: 'search_creators', input: { q: 'camping' }, request })
    expect(asked.at(-1)).toBe('camping')
    // 档案关键词一个都没搜到：退回不带关键词
    rows = []
    asked.length = 0
    const miss = await exec({ name: 'search_creators', input: {}, request })
    expect(asked).toEqual(['hiking daypack，hiking backpack', ''])
    expect((miss?.data as { rows: unknown[] } | undefined)?.rows).toHaveLength(1)
  })

  it('GEO：竞品与关注词先读档案（模型只补），人群进策略提示词', async () => {
    const prompts: string[] = []
    let id = 0
    const store = createGeoStore()
    const monitor = createGeoMonitor({
      clock: { now: () => '2026-10-15T10:00:00.000Z' },
      nextId: (p) => `${p}_${++id}`,
      store: async () => store,
      brand: async () => ({
        name: 'Trailmark',
        domains: ['trailmark.example'],
        language: 'en',
        country: 'us',
        markets: ['US'],
        category: 'hiking backpacks',
        audience: { buyers: 'parents who hike with kids', concerns: ['comfort'] },
        keywords: { brand: ['Trailmark'], category: ['hiking daypack'], scenario: [] },
        competitors: [{ name: 'Osprey', reason: 'r', url: 'https://www.osprey.com/us' }],
      }),
      searchData: () =>
        ({
          status: async () => ({ configured: false, route: 'none', platforms: [] }),
        }) as never,
      translate: async (text) => ({ asked: text, language: 'en', untranslated: false }),
      languageOf: () => 'en',
      gsc: async () => ({ connected: false, rows: [] }),
      model:
        () =>
        async ({ prompt }) => {
          prompts.push(prompt)
          return {
            text: JSON.stringify({
              competitors: [{ name: 'Gregory', domains: [], aliases: [] }],
              keywords: [{ keyword: 'best hiking backpack', branded: false }],
            }),
          }
        },
    })
    const strategy = await monitor.suggest()
    expect(prompts[0]).toContain('target shoppers (from the brand profile): parents who hike')
    expect(prompts[0]).toContain('known competitors: Osprey')
    expect(strategy.competitors.map((c) => c.name)).toEqual(['Osprey', 'Gregory'])
    expect(strategy.competitors[0]?.domains).toEqual(['osprey.com'])
    expect(strategy.keywords.map((k) => k.keyword).slice(0, 3)).toEqual([
      'Trailmark',
      'hiking daypack',
      'best hiking backpack',
    ])
  })
})
