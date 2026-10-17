/**
 * WP396（docs/106 §13）：自家 Listing 体检——录好的商品页样本（美国站 / 英国站）逐条判、被拦就停不重试、
 * 规则过期标出来、按 ASIN 留历史、自家 ASIN 没填出配置卡、工具只给亚马逊店铺运营。不联网。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrandWatchAmazonItem, RunRequest } from '@agentsws/contracts'
import { LISTING_CHECKUP_FOOTER_ZH } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AmazonListingReader,
  createAmazonListingCheckup,
  createAmazonListingToolExecutor,
  type ListingPageRead,
} from '../src/amazon-listing/index.js'

const FIX = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
  'listing',
)
const page = (name: string): string => readFileSync(join(FIX, name), 'utf8')

/** 替身读页积木：ASIN → 样本文件；记下读了几次。 */
function fakeReader(map: Record<string, string | ListingPageRead>, search?: string) {
  const calls: string[] = []
  const reader: AmazonListingReader = {
    async readProduct({ marketplace, asin }) {
      calls.push(asin)
      const v = map[asin]
      const url = `https://www.amazon.${marketplace === 'GB' ? 'co.uk' : 'com'}/dp/${asin}`
      if (v === undefined) return { status: 'failed', url, message: '打不开' }
      if (typeof v !== 'string') return v
      return { status: 'ok', url, html: page(v) }
    },
    ...(search === undefined
      ? {}
      : {
          async search() {
            calls.push('search')
            return {
              status: 'ok' as const,
              url: 'https://www.amazon.com/s?k=nordvik',
              html: search,
            }
          },
        }),
  }
  return { reader, calls }
}

function setup(
  own: BrandWatchAmazonItem[],
  map: Record<string, string | ListingPageRead>,
  o: { search?: string; dir?: string } = {},
) {
  let t = Date.parse('2026-10-18T08:00:00.000Z')
  const state = { own: [...own] }
  const { reader, calls } = fakeReader(map, o.search)
  const events: string[] = []
  const svc = createAmazonListingCheckup({
    workspace_id: 'ws_test',
    ...(o.dir === undefined ? {} : { dir: o.dir }),
    now: () => {
      t += 1000
      return new Date(t).toISOString()
    },
    newId: (p) => `${p}_${events.length}_${t}`,
    reader: () => reader,
    brand: async () => ({ name: 'Nordvik', own: state.own, markets: ['US'] }),
    saveOwn: async (items) => {
      state.own = items
    },
    emit: (type) => events.push(type),
  })
  return { svc, calls, state, events }
}

const US = (asin: string): BrandWatchAmazonItem => ({ marketplace: 'US', asin })

describe('WP396 · 录好的样本逐条判（美国站 / 英国站）', () => {
  it('每个 ASIN 一份结果，每处问题带规则出处；数字照页面原样', async () => {
    const { svc, calls } = setup(
      [
        US('B0NORDV001'),
        US('B0NORDLONG'),
        US('B0NORDNOBL'),
        US('B0NORDNOAP'),
        US('B0NORDOOS1'),
        US('B0NORDBBOX'),
        { marketplace: 'GB', asin: 'B0NORDUK01' },
        { marketplace: 'GB', asin: 'B0NORDUK02' },
      ],
      {
        B0NORDV001: 'us-normal.html',
        B0NORDLONG: 'us-long-title.html',
        B0NORDNOBL: 'us-no-bullets.html',
        B0NORDNOAP: 'us-no-aplus.html',
        B0NORDOOS1: 'us-out-of-stock.html',
        B0NORDBBOX: 'us-buybox-other.html',
        B0NORDUK01: 'uk-normal.html',
        B0NORDUK02: 'uk-issues.html',
      },
    )
    const r = await svc.run({ trigger: 'manual' })
    const run = r.run
    expect(run?.items).toHaveLength(8)
    expect(calls).toHaveLength(8)
    const ids = (asin: string) =>
      run?.items.find((i) => i.asin === asin)?.issues.map((x) => x.rule_id) ?? []
    expect(ids('B0NORDV001')).toEqual(['variants.unavailable'])
    expect(ids('B0NORDLONG')).toEqual(
      expect.arrayContaining([
        'title.max_chars',
        'title.repeat_words',
        'title.special_chars',
        'title.promo_words',
      ]),
    )
    expect(ids('B0NORDNOBL')).toEqual(
      expect.arrayContaining(['bullets.min_count', 'bullets.empty']),
    )
    expect(ids('B0NORDNOAP')).toEqual(
      expect.arrayContaining([
        'content.description_or_aplus',
        'content.aplus',
        'images.min_count',
        'images.video',
      ]),
    )
    expect(ids('B0NORDOOS1')[0]).toBe('offer.in_stock')
    expect(ids('B0NORDBBOX')[0]).toBe('offer.buybox_own')
    expect(ids('B0NORDUK01')).toEqual(['variants.unavailable'])
    expect(ids('B0NORDUK02')).toEqual(
      expect.arrayContaining([
        'title.all_caps',
        'title.special_chars',
        'reviews.rating_min',
        'reviews.count_min',
        'claims.market',
      ]),
    )
    for (const item of run?.items ?? [])
      for (const issue of item.issues) {
        expect(issue.source.title).not.toBe('')
        expect(issue.rule_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(issue.rule_stale).toBe(false)
      }
    const uk = run?.items.find((i) => i.asin === 'B0NORDUK02')
    expect(uk?.facts).toMatchObject({
      rating: 3.6,
      reviews_count: 7,
      price: '£49.99',
      currency: 'GBP',
    })
    expect(run?.summary.worst?.severity).toBe('blocker')
    expect(run?.summary.checked).toBe(8)
  })

  it('断变体：两款几乎同名、不在一组 → 各标一处、建议人看一眼', async () => {
    const { svc } = setup([US('B0NORDBRN1'), US('B0NORDTAN1')], {
      B0NORDBRN1: 'us-broken-variant-a.html',
      B0NORDTAN1: 'us-broken-variant-b.html',
    })
    const run = (await svc.run({ trigger: 'manual' })).run
    for (const item of run?.items ?? []) {
      const broken = item.issues.find((i) => i.rule_id === 'variants.broken')
      expect(broken?.needs_human).toBe(true)
    }
  })

  it('配送地址不对：这次读数作废，不拿来判', async () => {
    const { svc } = setup([US('B0NORDUND1')], { B0NORDUND1: 'us-undeliverable.html' })
    const item = (await svc.run({ trigger: 'manual' })).run?.items[0]
    expect(item?.status).toBe('failed')
    expect(item?.message).toContain('作废')
    expect(item?.issues).toEqual([])
  })
})

describe('WP396 · 被拦就停、不重试', () => {
  it('第二页是验证页：停下，第三个不去读，读页积木只被叫了两次', async () => {
    const { svc, calls } = setup([US('B0NORDV001'), US('B0NORDCAP1'), US('B0NORDLONG')], {
      B0NORDV001: 'us-normal.html',
      B0NORDCAP1: 'captcha.html',
      B0NORDLONG: 'us-long-title.html',
    })
    const r = await svc.run({ trigger: 'manual' })
    expect(calls).toEqual(['B0NORDV001', 'B0NORDCAP1'])
    expect(r.run?.stopped).toBe('blocked')
    expect(r.run?.items.map((i) => i.status)).toEqual(['checked', 'blocked', 'skipped'])
    expect(r.message).toContain('不重试')
  })

  it('读页积木自己判出被拦（blocked）、额度满了（quota）同样停', async () => {
    const a = setup([US('B0NORDBLK1'), US('B0NORDV001')], {
      B0NORDBLK1: { status: 'blocked', url: 'https://www.amazon.com/dp/B0NORDBLK1' },
      B0NORDV001: 'us-normal.html',
    })
    expect((await a.svc.run({ trigger: 'manual' })).run?.stopped).toBe('blocked')
    expect(a.calls).toEqual(['B0NORDBLK1'])
    const q = setup([US('B0NORDQ001'), US('B0NORDV001')], {
      B0NORDQ001: { status: 'quota' },
      B0NORDV001: 'us-normal.html',
    })
    expect((await q.svc.run({ trigger: 'manual' })).run?.stopped).toBe('quota')
    expect(q.calls).toEqual(['B0NORDQ001'])
  })

  it('这里没有读页积木：照实说读不了，不存一份空结果', async () => {
    const svc = createAmazonListingCheckup({
      workspace_id: 'ws_test',
      now: () => '2026-10-18T08:00:00.000Z',
      newId: (p) => `${p}_1`,
      reader: () => undefined,
      brand: async () => ({ name: 'Nordvik', own: [US('B0NORDV001')], markets: ['US'] }),
      saveOwn: async () => {},
    })
    const r = await svc.run({ trigger: 'tool' })
    expect(r.run?.stopped).toBe('unavailable')
    expect(svc.latest()).toBeUndefined()
    expect((await svc.view()).reader_ready).toBe(false)
  })
})

describe('WP396 · 规则表带日期、能改；按 ASIN 留历史', () => {
  it('把一条规则日期改到一年前：体检结果上标「可能过时」', async () => {
    const { svc } = setup([US('B0NORDLONG')], { B0NORDLONG: 'us-long-title.html' })
    expect(svc.setRule({ rule_id: 'title.max_chars', checked_at: '2025-10-18' }).ok).toBe(true)
    const issue = (await svc.run({ trigger: 'manual' })).run?.items[0]?.issues.find(
      (i) => i.rule_id === 'title.max_chars',
    )
    expect(issue?.rule_stale).toBe(true)
  })

  it('改建议值：参数名 / 类型不对的不收', () => {
    const { svc } = setup([], {})
    expect(
      svc.setRule({ rule_id: 'title.max_chars', params: { max_chars: 150 } }).rule?.params
        .max_chars,
    ).toBe(150)
    expect(svc.setRule({ rule_id: 'title.max_chars', params: { nope: 1 } }).ok).toBe(false)
    expect(svc.setRule({ rule_id: 'nope' }).ok).toBe(false)
  })

  it('第二次体检：上次几处、修了几处（存在品牌目录里）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp396-'))
    const own = [US('B0NORDNOAP')]
    const first = setup(own, { B0NORDNOAP: 'us-no-aplus.html' }, { dir })
    const r1 = await first.svc.run({ trigger: 'manual' })
    const before = r1.run?.items[0]?.issues.length ?? 0
    expect(before).toBeGreaterThanOrEqual(4)
    expect(r1.run?.items[0]?.previous).toBeUndefined()
    // 修好了（换成正常页；子体买不了那一处还在），重开服务（从盘上读历史）
    const second = setup(own, { B0NORDNOAP: 'us-normal.html' }, { dir })
    const r2 = await second.svc.run({ trigger: 'manual' })
    expect(r2.run?.items[0]?.previous).toMatchObject({ issues: before, fixed: before - 1, added: 0 })
  })
})

describe('WP396 · 自家 ASIN 没填：出配置卡，AI 搜一页给候选、人勾', () => {
  it('体检回 needs_setup；卡上是按品牌名搜到的候选，勾了存回关注设置', async () => {
    const search = `<div data-asin="B0NORDV001"><h2><span>Nordvik Granite Wallet for Men</span></h2></div>
<div data-asin="B0OTHER001"><h2><span>Generic Slim Wallet</span></h2></div>`
    const { svc, calls, state } = setup([], {}, { search })
    expect((await svc.run({ trigger: 'tool' })).needs_setup).toBe('amazon.own_asins')
    const target = svc.setupTarget()
    expect(await target.satisfied()).toBe(false)
    const fields = await target.fields()
    expect(fields.find((f) => f.key === 'asin_US_B0NORDV001')?.suggested).toBe('true')
    expect(fields.find((f) => f.key === 'asin_US_B0OTHER001')?.suggested).toBe('false')
    await target.fields()
    expect(calls.filter((c) => c === 'search')).toHaveLength(1)
    await target.apply({
      asin_US_B0NORDV001: 'true',
      asin_US_B0OTHER001: 'false',
      more: 'https://www.amazon.co.uk/dp/B0NORDUK01',
    })
    expect(state.own.map((o) => `${o.marketplace}:${o.asin}`)).toEqual([
      'US:B0NORDV001',
      'GB:B0NORDUK01',
    ])
    expect(await target.satisfied()).toBe(true)
    await expect(target.apply({ more: '不是链接' })).rejects.toThrow('认不出')
  })
})

describe('WP396 · 工具', () => {
  const req = (role_id: string): RunRequest =>
    ({
      id: 'run_1',
      workspace_id: 'ws_test',
      actor: { person_id: 'p1', assignment_id: 'a1', role_id },
    }) as unknown as RunRequest

  it('只给亚马逊店铺运营；回结果带出处与卡底那一句；没填 ASIN 回 needs_setup', async () => {
    const withAsin = setup([US('B0NORDNOAP')], { B0NORDNOAP: 'us-no-aplus.html' })
    const exec = createAmazonListingToolExecutor({ checkup: async () => withAsin.svc })
    const blocked = await exec({
      name: 'read_amazon_listings',
      input: {},
      request: req('dtc.store'),
    } as never)
    expect(blocked.status).toBe('blocked')
    const got = await exec({
      name: 'read_amazon_listings',
      input: {},
      request: req('amz.store'),
    } as never)
    const data = got.data as {
      footer: string
      items: { issues: { source: string; design_request?: boolean }[] }[]
    }
    expect(data.footer).toBe(LISTING_CHECKUP_FOOTER_ZH)
    expect(data.items[0]?.issues.every((i) => i.source !== '')).toBe(true)
    expect(data.items[0]?.issues.some((i) => i.design_request === true)).toBe(true)
    const latest = await exec({
      name: 'get_listing_checkup',
      input: { rules: true },
      request: req('amz.store'),
    } as never)
    expect((latest.data as { rules: unknown[] }).rules.length).toBeGreaterThan(10)

    const empty = setup([], {})
    const exec2 = createAmazonListingToolExecutor({ checkup: async () => empty.svc })
    const need = await exec2({
      name: 'read_amazon_listings',
      input: {},
      request: req('amz.store'),
    } as never)
    expect((need.data as { needs_setup: string }).needs_setup).toBe('amazon.own_asins')
    const set = await exec2({
      name: 'set_listing_check_rule',
      input: { own_sellers: ['Nordvik Official'] },
      request: req('amz.store'),
    } as never)
    expect((set.data as { own_sellers: string[] }).own_sellers).toEqual(['Nordvik Official'])
  })
})
