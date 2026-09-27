/**
 * WP166：目标市场一处定、处处用——服务端那几件事。
 *
 * 钉住：品牌分析确认时连出处写进档案；设置页（HTTP）能增删、出处记成「人改的」；人改过的
 * 自动推断与店铺校正都不再覆盖；店铺连上后按店里配的市场校正一次、写一句改了什么；
 * 改了立刻生效（违规宣称规则那张表马上按新市场开组）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKET_COUNTRY_CODES, type MarketsSource } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import {
  countriesOfMarkets,
  countriesOfZones,
  createStoreMarketsSync,
  marketsFromIntake,
  reconcileStoreMarkets,
} from '../src/markets.js'
import { nextMarkets } from '../src/onboarding.js'

const AT = '2026-09-27T09:00:00.000Z'

describe('WP166 · 目标市场（纯函数）', () => {
  it('品牌分析那一格 → 档案：出处按证据分官网 / Amazon，人改过的记成人改的（清空也算）', () => {
    const site = marketsFromIntake(
      {
        value: ['US', 'CA'],
        confidence: 'medium',
        evidence: [
          { url: 'https://a.example/policies/shipping-policy', locator: 'policy:shipping' },
        ],
      },
      AT,
    )
    expect(site.markets).toEqual(['US', 'CA'])
    expect(site.markets_source?.from).toBe('site')
    const amazon = marketsFromIntake(
      { value: ['GB'], confidence: 'medium', evidence: [{ url: 'x', locator: 'url:host' }] },
      AT,
    )
    expect(amazon.markets_source?.from).toBe('amazon')
    const cleared = marketsFromIntake(
      {
        value: [],
        confidence: 'high',
        evidence: [{ url: 'human', locator: 'edited' }],
        edited: true,
      },
      AT,
    )
    expect(cleared).toEqual({ markets: [], markets_source: { from: 'human', at: AT } })
    expect(marketsFromIntake(undefined, AT)).toEqual({})
  })

  it('setProfile 的规矩：原样存不改出处；人改过的自动的不覆盖；人自己可以再改', () => {
    const human: MarketsSource = { from: 'human', at: AT }
    const site: MarketsSource = { from: 'site', at: AT }
    const prev = {
      legal_name: 'x',
      discoverable: true,
      set_at: AT,
      markets: ['US'],
      markets_source: site,
    }
    expect(nextMarkets(prev, { markets: ['us'] }, AT)).toEqual({
      markets: ['US'],
      markets_source: site,
    })
    expect(nextMarkets(prev, { markets: ['US', 'GB'] }, AT).markets_source?.from).toBe('human')
    const byHuman = { ...prev, markets_source: human }
    expect(nextMarkets(byHuman, { markets: ['DE'], markets_source: site }, AT).markets).toEqual([
      'US',
    ])
    expect(nextMarkets(byHuman, { markets: ['DE'] }, AT).markets).toEqual(['DE'])
    expect(nextMarkets(prev, {}, AT)).toEqual({ markets: ['US'], markets_source: site })
  })

  it('店里配的市场 / 配送区域两种回包都认；「世界其他地区」不算', () => {
    expect(
      countriesOfMarkets({
        markets: [
          { name: 'US', enabled: true, regions: { nodes: [{ code: 'US' }] } },
          { name: 'EU', enabled: false, regions: [{ code: 'DE' }] },
          {
            name: 'CA',
            status: 'ACTIVE',
            conditions: { regionsCondition: { regions: { nodes: [{ countryCode: 'CA' }] } } },
          },
        ],
      }),
    ).toEqual(['US', 'CA'])
    expect(
      countriesOfZones({
        shipping_zones: [
          { countries: [{ code: 'US' }, { code: 'GB' }] },
          { countries: [{ code: '*' }] },
        ],
      }),
    ).toEqual(['US', 'GB'])
  })

  it('校正：写一句加了 / 去了什么；人改过的、一样的、卖全世界的都不改', () => {
    const r = reconcileStoreMarkets({
      current: ['US', 'CA'],
      source: { from: 'site', at: AT },
      store: ['US', 'GB'],
      from: 'markets',
      at: AT,
    })
    expect(r?.markets).toEqual(['US', 'GB'])
    expect(r?.source.from).toBe('store')
    expect(r?.source.note).toBe('按店铺后台的「市场」校正：加上了 英国，去掉了 加拿大')
    const base = { current: ['US'], store: ['US', 'GB'], from: 'markets' as const, at: AT }
    expect(reconcileStoreMarkets({ ...base, source: { from: 'human', at: AT } })).toBeUndefined()
    expect(reconcileStoreMarkets({ ...base, source: undefined, store: ['US'] })).toBeUndefined()
    const many = MARKET_COUNTRY_CODES.slice(0, 26)
    expect(reconcileStoreMarkets({ ...base, source: undefined, store: many })).toBeUndefined()
    const fresh = reconcileStoreMarkets({ ...base, current: undefined, source: undefined })
    expect(fresh?.source.note).toBe('按店铺后台的「市场」设成了 美国、英国')
  })

  it('店铺连上后校正一次：只读 Action、每条连接只读一次、读不到下次再试', async () => {
    const executed: string[] = []
    let fail = true
    const connect = {
      actions: async () => [
        { id: 'shopify_admin.list_markets' },
        { id: 'shopify_admin.list_shipping_zones' },
      ],
      issueToken: async (input: { allowed_actions: string[] }) => {
        expect(input.allowed_actions).toEqual([
          'shopify_admin.list_markets',
          'shopify_admin.list_shipping_zones',
        ])
        return { token: 't' }
      },
      execute: async <T>(id: string): Promise<T> => {
        executed.push(id)
        if (fail) throw new Error('令牌还没就绪')
        return (
          id.endsWith('list_markets')
            ? { markets: [{ enabled: true, regions: [{ code: 'US' }, { code: 'AU' }] }] }
            : {}
        ) as T
      },
    }
    let profile: { markets?: string[]; markets_source?: MarketsSource } = {
      markets: ['US'],
      markets_source: { from: 'site', at: AT },
    }
    const sync = createStoreMarketsSync({
      connect,
      connection: () => ({ id: 'conn_1', service: 'shopify_admin' }),
      current: () => profile,
      apply: (markets, markets_source) => {
        profile = { markets, markets_source }
        return true
      },
      now: () => AT,
    })
    expect(await sync.check()).toBeUndefined()
    fail = false
    expect(await sync.check()).toEqual({
      changed: true,
      note: '按店铺后台的「市场」校正：加上了 澳大利亚',
    })
    expect(profile.markets).toEqual(['US', 'AU'])
    const before = executed.length
    expect(await sync.check()).toBeUndefined()
    expect(executed.length).toBe(before)
  })
})

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function boot() {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp166-'))
  let a = 7
  const s = await createServer({
    clock: { now: () => AT },
    random: () => {
      a = (a * 1664525 + 1013904223) % 4294967296
      return a / 4294967296
    },
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } }
  }
  return { s, call }
}

describe('WP166 · 设置页「公司档案」改目标市场（真服务进程）', () => {
  it('HTTP 能增删；出处记成人改的；改了违规宣称规则马上按新市场开组', async () => {
    const { call } = await boot()
    const put = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      markets: ['us', 'de', 'gb'],
    })
    expect(put.status).toBe(200)
    expect(put.json.data).toMatchObject({
      markets: ['US', 'DE', 'GB'],
      markets_source: { from: 'human' },
    })
    const state = await call('GET', '/v1/onboarding/state')
    expect((state.json.data.profile as { markets?: string[] }).markets).toEqual(['US', 'DE', 'GB'])
    const rules = await call('GET', '/v1/knowledge/claim-rules')
    const groups = rules.json.data.groups as { id: string; enabled: boolean }[]
    expect(groups.find((g) => g.id === 'eu_uk')?.enabled).toBe(true)

    // 删到只剩美国
    const cut = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      markets: ['US'],
    })
    expect(cut.json.data.markets).toEqual(['US'])
    const again = await call('GET', '/v1/knowledge/claim-rules')
    const g2 = again.json.data.groups as { id: string; enabled: boolean }[]
    expect(g2.find((g) => g.id === 'eu_uk')?.enabled).toBe(false)

    // 不认识的码被挡在校验那一层
    const bad = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      markets: ['USA'],
    })
    expect(bad.status).toBe(400)
  })
})

describe('WP169 · 档案里按市场覆盖探测语言（真服务进程）', () => {
  it('PUT 收 market_languages（归一化）；不给就沿用；空对象清空；改别的不丢', async () => {
    const { call } = await boot()
    const put = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      markets: ['CA', 'DE'],
      market_languages: { ca: 'FR' },
    })
    expect(put.status).toBe(200)
    expect(put.json.data.market_languages).toEqual({ CA: 'fr' })
    const keep = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      markets: ['CA', 'DE', 'GB'],
    })
    expect(keep.json.data.market_languages).toEqual({ CA: 'fr' })
    const state = await call('GET', '/v1/onboarding/state')
    expect((state.json.data.profile as { market_languages?: unknown }).market_languages).toEqual({
      CA: 'fr',
    })
    const cleared = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      market_languages: {},
    })
    expect(cleared.json.data.market_languages).toBeUndefined()
    const bad = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'Nordvik Supply AB',
      market_languages: { CA: 'french' },
    })
    expect(bad.status).toBe(400)
  })
})
