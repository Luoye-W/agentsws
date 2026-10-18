/**
 * WP420（自查 ads-amazon B1 / B4 / B5 / B10 / B11 / B14）：Amazon 运营那一侧。
 *
 * - B1：Listing 体检的取数链——内置浏览器被拦 / 暂停 → 你自己的浏览器（先问同意、每款每天一次）→ 照实说停到几点；
 * - B4 / B9：有人担亚马逊店铺运营就种一条每周体检 + 刷新词库的自动化任务（只种一次）；
 * - B5：竞品方案卡「你的商品」按品牌名搜候选（标题带品牌名、不是广告位）；
 * - B10：拆词不要「power station power」这种重复拼出来的词组；差距按 ASIN 说；
 * - B11：要 SP-API 的官方技能没连上不进可加载清单；
 * - B14：只在这个岗位里「列着、默认不勾」的职责（Amazon 客服），没安放的老分配不算这里的。
 *
 * 全是替身（不打开 Amazon、不连任何真账号）。
 */
import type { Assignment } from '@agentsws/contracts'
import { extractPhrases, keywordRows } from '@agentsws/seo-core'
import { describe, expect, it } from 'vitest'
import type { AmazonOwnBrowser } from '../src/amazon-front/own-browser.js'
import type { AmazonFrontReader } from '../src/amazon-front/reader.js'
import { createListingChain, frontStoppedMessage } from '../src/amazon-listing/chain.js'
import {
  AMAZON_WEEKLY_PROMPT,
  AMAZON_WEEKLY_SELECTOR,
  seedAmazonWeekly,
} from '../src/amazon-listing/weekly.js'
import { ownCandidatesFromCards } from '../src/competitor-watch/amazon-plan.js'
import { belongsTo } from '../src/position-placements.js'
import { usableSkills } from '../src/runtime.js'

const HTML = '<html><span id="productTitle">Nordvolt Power Station</span></html>'

function front(over: Partial<AmazonFrontReader>): AmazonFrontReader {
  return {
    ready: () => true,
    pausedUntil: () => undefined,
    readProduct: async () => ({ status: 'ok', url: 'https://www.amazon.com/dp/B0X', html: HTML }),
    search: async () => ({ status: 'failed', url: '', message: 'x' }),
    ...over,
  } as AmazonFrontReader
}

function own(gate: 'ok' | 'needs_consent' | 'limited', calls: string[] = []): AmazonOwnBrowser {
  return {
    available: () => true,
    needConsent: async () => {
      calls.push('asked')
    },
    rawProduct: async (key: string) => {
      calls.push(key)
      if (gate !== 'ok') return { status: gate }
      return { status: 'ok', url: 'https://www.amazon.com/dp/B0OWN', html: HTML }
    },
  } as unknown as AmazonOwnBrowser
}

describe('B1 Listing 体检的取数链', () => {
  const input = { marketplace: 'US', asin: 'b0own' }

  it('内置浏览器读得到 → 就用它（不碰你的浏览器）', async () => {
    const calls: string[] = []
    const chain = createListingChain({
      front: () => front({}),
      own: () => own('ok', calls),
      tzOffsetMinutes: () => 480,
    })
    expect((await chain?.readProduct(input))?.status).toBe('ok')
    expect(calls).toEqual([])
  })

  it('内置浏览器被拦后在暂停里 → 换你自己的浏览器读（按 ASIN 一个键）', async () => {
    const calls: string[] = []
    const chain = createListingChain({
      front: () =>
        front({ ready: () => false, pausedUntil: () => Date.parse('2026-10-20T02:00:00Z') }),
      own: () => own('ok', calls),
      tzOffsetMinutes: () => 480,
    })
    const got = await chain?.readProduct(input)
    expect(got?.status).toBe('ok')
    expect(calls).toEqual(['listing:B0OWN'])
  })

  it('读到一半被拦 → 也换你的浏览器；还没同意 → 出卡问、照实说停到几点', async () => {
    const calls: string[] = []
    const chain = createListingChain({
      front: () =>
        front({
          readProduct: async () => ({ status: 'blocked', url: '' }),
          pausedUntil: () => Date.parse('2026-10-20T02:00:00Z'),
        }),
      own: () => own('needs_consent', calls),
      tzOffsetMinutes: () => 480,
    })
    const got = await chain?.readProduct(input)
    expect(got?.status).toBe('blocked')
    expect(got?.status === 'blocked' ? got.message : '').toContain('停到 10:00')
    expect(got?.status === 'blocked' ? got.message : '').toContain('已出一张卡')
    expect(calls).toEqual(['listing:B0OWN', 'asked'])
  })

  it('今天已经用你的浏览器读过这一款 → 照实说明天再试', async () => {
    const chain = createListingChain({
      front: () => front({ ready: () => false }),
      own: () => own('limited'),
      tzOffsetMinutes: () => 0,
    })
    const got = await chain?.readProduct(input)
    expect(got?.status === 'blocked' ? got.message : '').toContain('明天再试')
  })

  it('没有内置浏览器、也没装插件 → 没有这条链（体检照实说这里读不了）', () => {
    expect(
      createListingChain({
        front: () => undefined,
        own: () => undefined,
        tzOffsetMinutes: () => 0,
      }),
    ).toBeUndefined()
    expect(frontStoppedMessage(undefined, 0)).toContain('验证页')
  })
})

describe('B4 / B9 每周体检 + 刷新词库（官方自动化任务，只种一次）', () => {
  const holder = {
    id: 'as_amz',
    person_id: 'p_1',
    role_id: 'amz.store',
    workspace_id: 'ws_1',
  } as unknown as Assignment

  it('有人担就种：每周一 10:30，提示词里体检 + 刷新词库；种过不再种', async () => {
    let kv: unknown
    const seeds: unknown[] = []
    const matters: string[] = []
    const deps = {
      workspace_id: 'ws_1' as never,
      holder: () => holder,
      createMatter: (i: { title: string }) => {
        matters.push(i.title)
        return { id: `mt_${matters.length}` }
      },
      automation: {
        seed: async (i: unknown) => {
          seeds.push(i)
          return 'sched_1'
        },
      },
      kv: { get: () => kv, set: (v: unknown) => (kv = v) },
      now: () => '2026-10-19T00:00:00Z',
    }
    expect(await seedAmazonWeekly(deps)).toEqual({ matter_id: 'mt_1', task_id: 'sched_1' })
    expect(await seedAmazonWeekly(deps)).toBeUndefined()
    expect(matters).toEqual(['Amazon 每周体检'])
    expect(seeds[0]).toMatchObject({ selector: AMAZON_WEEKLY_SELECTOR, role_id: 'amz.store' })
    expect(AMAZON_WEEKLY_PROMPT).toContain('read_amazon_listings')
    expect(AMAZON_WEEKLY_PROMPT).toContain('read_amazon_keywords')
  })

  it('没人担 → 不种、不开事项', async () => {
    const out = await seedAmazonWeekly({
      workspace_id: 'ws_1' as never,
      holder: () => undefined,
      createMatter: () => {
        throw new Error('不该开')
      },
      automation: { seed: async () => 'x' },
      kv: { get: () => undefined, set: () => undefined },
      now: () => '2026-10-19T00:00:00Z',
    })
    expect(out).toBeUndefined()
  })
})

describe('B5 竞品方案卡「你的商品」按品牌名搜候选', () => {
  it('标题带品牌名、不是广告位的前几款', () => {
    expect(
      ownCandidatesFromCards(
        [
          { asin: 'b0ad000001', title: 'Nordvolt 1000 Ad', sponsored: true },
          { asin: 'b0own00001', title: 'NORDVOLT Portable Power Station', sponsored: false },
          { asin: 'b0rival001', title: 'Rival Gear Station', sponsored: false },
          { asin: 'B0OWN00001', title: 'Nordvolt again', sponsored: false },
        ],
        'Nordvolt',
      ),
    ).toEqual([{ asin: 'B0OWN00001', title: 'NORDVOLT Portable Power Station' }])
    expect(ownCandidatesFromCards([], ' ')).toEqual([])
  })
})

describe('B10 词库', () => {
  const ctx = { language: 'en', brands: [] as string[] }

  it('标题里同一个词组重复拼出来的那种不要（power station power）', () => {
    const terms = extractPhrases('Portable Power Station Power Station 1000W', ctx as never).map(
      (p) => p.norm,
    )
    expect(terms).toContain('power station')
    expect(terms).not.toContain('power station power')
    expect(terms).not.toContain('station power station')
  })

  it('差距按 ASIN 说（哪几个自家 ASIN 没写）', () => {
    const k = {
      id: 'kw_1',
      term: 'camping',
      norm: 'camping',
      marketplace: 'US',
      sources: ['competitor_listing'],
      marks: [],
    }
    const rows = keywordRows({
      bank: [k as never],
      own: [
        { asin: 'B0A', marketplace: 'US', title: 'camping station', bullets: [] },
        { asin: 'B0B', marketplace: 'US', title: 'power station', bullets: [] },
      ] as never,
      competitors: [],
      gaps: [
        {
          asin: 'B0B',
          marketplace: 'US',
          terms: [{ id: 'kw_1', term: 'camping', competitors: 2 }],
          competitors_compared: 2,
          common: 1,
          computed_at: '2026-10-19T00:00:00Z',
        },
      ] as never,
    })
    expect(rows[0]).toMatchObject({ in_own_text: true, gap: true, gap_asins: ['B0B'] })
  })
})

describe('B11 要 SP-API 的官方技能', () => {
  it('没连上 Amazon 官方卖家连接 → 不进可加载清单；连上了照旧', () => {
    const skills = [
      { name: 'amazon-sp-stockout-prevention' },
      { name: 'amazon-inventory' },
      { name: 'unit-economics' },
    ]
    expect(usableSkills(skills, { amazonSeller: false }).map((s) => s.name)).toEqual([
      'amazon-inventory',
      'unit-economics',
    ])
    expect(usableSkills(skills, { amazonSeller: true })).toHaveLength(3)
  })
})

describe('B14 Amazon 客服不再同时挂在两个岗位下', () => {
  const amazonOps = {
    id: 'amazon-ops',
    roles: [
      { role: 'amz.store', default: true },
      { role: 'amz.support', default: false },
    ],
  }
  const care = { id: 'customer-care', roles: [{ role: 'amz.support', default: true }] }
  const social = { id: 'social-media', roles: [{ role: 'social.reddit', default: false }] }

  it('没安放的老分配：只算它的家（默认勾它的客服岗）', () => {
    const a = { id: 'as_1', role_id: 'amz.support' as never }
    expect(
      belongsTo(
        a,
        amazonOps as never,
        () => undefined,
        () => true,
      ),
    ).toBe(false)
    expect(
      belongsTo(
        a,
        care as never,
        () => undefined,
        () => true,
      ),
    ).toBe(true)
  })

  it('勾了它（安放在 Amazon 运营）→ 算 Amazon 运营的', () => {
    const a = { id: 'as_1', role_id: 'amz.support' as never }
    expect(
      belongsTo(
        a,
        amazonOps as never,
        () => 'amazon-ops',
        () => true,
      ),
    ).toBe(true)
  })

  it('只挂在一个模板里的「默认不勾」职责照旧算（social.reddit）', () => {
    const a = { id: 'as_2', role_id: 'social.reddit' as never }
    expect(
      belongsTo(
        a,
        social as never,
        () => undefined,
        () => true,
      ),
    ).toBe(true)
  })
})
