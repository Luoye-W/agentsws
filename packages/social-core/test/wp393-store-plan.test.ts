/**
 * WP393（docs/104 C5 / C8）：哪条算重要（只按用户确认过的规则）、简报「有才出」、对标款与差价。
 */
import type {
  CatalogSnapshotRow,
  CompetitorChange,
  CompetitorImportanceRules,
  OwnShopProduct,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  competitorBriefSection,
  diffCatalog,
  formatPairs,
  isImportantChange,
  ownRefFromPairs,
  parsePairs,
  suggestPairs,
} from '../src/index.js'

const NOW = '2026-10-19T01:00:00.000Z'
const change = (over: Partial<CompetitorChange>): CompetitorChange => ({
  id: 'cc_1',
  workspace_id: 'ws_1' as never,
  kind: 'price',
  competitor_id: 'c_aventon',
  competitor: 'Aventon',
  source_id: 'cw_shop_c_aventon',
  source_kind: 'shop_catalog',
  product_key: '7001',
  title: 'Level 3',
  detected_at: NOW,
  ...over,
})

const row = (over: Partial<CatalogSnapshotRow>): CatalogSnapshotRow => ({
  source_id: 'cw_shop_c_aventon',
  competitor_id: 'c_aventon',
  product_key: '7001',
  title: 'Level 3 Commuter eBike',
  price: 1799,
  currency: 'USD',
  available: true,
  read_at: NOW,
  ...over,
})

const OWN: OwnShopProduct[] = [
  { key: 'ranger-commuter', title: 'Ranger Commuter eBike', price: 1899, currency: 'USD' },
  { key: 'city-helmet', title: 'City Helmet', price: 79, currency: 'USD' },
]

describe('WP393 · 哪条算重要（C5：只按确认过的规则）', () => {
  const rules: CompetitorImportanceRules = {
    price_drop_pct: 10,
    cheaper_than_own: true,
    new_products: true,
  }

  it('没确认过方案：一条都不算', () => {
    expect(isImportantChange(change({ pct: -50 }), undefined)).toBe(false)
  })

  it('降价到线才算；涨价不算；没到线但降完比你便宜也算', () => {
    expect(isImportantChange(change({ pct: -12 }), rules)).toBe(true)
    expect(isImportantChange(change({ pct: -5 }), rules)).toBe(false)
    expect(isImportantChange(change({ pct: 15 }), rules)).toBe(false)
    expect(
      isImportantChange(
        change({ pct: -5, vs_own: { own_key: 'ranger', own_price: 1899, diff: -200 } }),
        rules,
      ),
    ).toBe(true)
    // 多款式合成：看变得最多的那一款
    expect(isImportantChange(change({ pct: -4, pct_range: [-12, -4] }), rules)).toBe(true)
  })

  it('上新 / 打折 / 断货 / 下架各看各的开关', () => {
    expect(isImportantChange(change({ kind: 'new' }), rules)).toBe(true)
    expect(isImportantChange(change({ kind: 'discount_start' }), rules)).toBe(false)
    expect(isImportantChange(change({ kind: 'discount_start' }), { discounts: true })).toBe(true)
    expect(isImportantChange(change({ kind: 'out_of_stock' }), { stock: true })).toBe(true)
    expect(isImportantChange(change({ kind: 'removed' }), rules)).toBe(false)
    expect(isImportantChange(change({ kind: 'discount_end' }), { discounts: true })).toBe(false)
  })
})

describe('WP393 · 简报「竞品动向」有才出', () => {
  const rules: CompetitorImportanceRules = { price_drop_pct: 10 }

  it('没有重要变化、也没有哪家没读到：不出', () => {
    expect(
      competitorBriefSection({ changes: [change({ pct: -3 })], rules, failed: [] }),
    ).toBeUndefined()
    expect(
      competitorBriefSection({ changes: [change({ pct: -30 })], rules: undefined }),
    ).toBeUndefined()
  })

  it('有重要变化：一条一句，带竞品名和比你便宜多少', () => {
    const s = competitorBriefSection({
      changes: [
        change({
          pct: -11.1,
          before: 1799,
          after: 1599,
          currency: 'USD',
          vs_own: {
            own_key: 'ranger-commuter',
            own_title: 'Ranger',
            own_price: 1899,
            diff: -300,
            currency: 'USD',
          },
        }),
        change({ id: 'cc_2', pct: -2 }),
      ],
      rules,
    })
    expect(s?.title).toBe('竞品动向')
    expect(s?.important).toBe(1)
    expect(s?.lines[0]).toBe(
      'Aventon · Level 3：降价11.1%（$1,799 → $1,599），比你的 Ranger 便宜 $300',
    )
  })

  it('有一家没读到：照实写（不显示成 0）', () => {
    const s = competitorBriefSection({ changes: [], rules, failed: ['Cyrusher', 'Cyrusher'] })
    expect(s?.lines).toEqual([])
    expect(s?.failed).toEqual(['Cyrusher 这次没读到'])
  })
})

describe('WP393 · 对标款（C8）', () => {
  const rivals = [
    {
      competitor_id: 'c_aventon',
      name: 'Aventon',
      rows: [
        row({}),
        row({ variant_key: 'b', price: 1899 }),
        row({ product_key: '7003', title: 'Aventon Helmet Pro', price: 89 }),
        row({ product_key: '7004', title: 'Cargo Max', price: 3999 }),
      ],
    },
  ]

  it('规则版：每款自家商品配一款标题像、价位近的竞品款；价差太远的不配', () => {
    const pairs = suggestPairs({ rivals, own: OWN, own_brand: 'Ranger Bikes' })
    expect(pairs.map((p) => `${p.product_key}->${p.own_key}`).sort()).toEqual([
      '7001->ranger-commuter',
      '7003->city-helmet',
    ])
    expect(pairs.every((p) => p.by === 'ai')).toBe(true)
  })

  it('人改过的不动；那一款竞品不再自动配', () => {
    const pairs = suggestPairs({
      rivals,
      own: OWN,
      own_brand: 'Ranger Bikes',
      keep: [
        { competitor_id: 'c_aventon', product_key: '7004', own_key: 'ranger-commuter', by: 'user' },
        { competitor_id: 'c_aventon', product_key: '7001', own_key: 'city-helmet', by: 'ai' },
      ],
    })
    expect(pairs.find((p) => p.product_key === '7004')?.by).toBe('user')
    expect(pairs.find((p) => p.product_key === '7001')?.own_key).toBe('ranger-commuter')
  })

  it('比价口：配了、自家有价、币种一样才比；进对比引擎写出「比你便宜 $N」', () => {
    const pairs = suggestPairs({ rivals, own: OWN, own_brand: 'Ranger Bikes' })
    const ref = ownRefFromPairs(pairs, OWN)
    expect(ref?.(row({}))).toMatchObject({ own_key: 'ranger-commuter', own_price: 1899 })
    expect(ref?.(row({ currency: 'EUR' }))).toBeUndefined()
    expect(ref?.(row({ product_key: '9999' }))).toBeUndefined()
    expect(ownRefFromPairs([], OWN)).toBeUndefined()

    const source = {
      id: 'cw_shop_c_aventon',
      kind: 'shop_catalog' as const,
      competitor_id: 'c_aventon',
    }
    const first = diffCatalog({
      workspace_id: 'ws_1' as never,
      source,
      competitor: 'Aventon',
      previous: undefined,
      read: { rows: [row({})], complete: true },
      now: NOW,
    })
    const second = diffCatalog({
      workspace_id: 'ws_1' as never,
      source,
      competitor: 'Aventon',
      previous: first.snapshot,
      read: { rows: [row({ price: 1599 })], complete: true },
      now: '2026-10-20T01:00:00.000Z',
      ...(ref === undefined ? {} : { ownRef: ref }),
    })
    expect(second.changes[0]?.vs_own).toMatchObject({
      diff: -300,
      own_title: 'Ranger Commuter eBike',
    })
  })

  it('卡上那一格：写出来、改回去（认不出的照实回）', () => {
    const pairs = suggestPairs({ rivals, own: OWN, own_brand: 'Ranger Bikes' })
    const text = formatPairs(pairs, new Map([['c_aventon', 'Aventon']]))
    expect(text).toContain('Aventon · Level 3 Commuter eBike = Ranger Commuter eBike')
    const back = parsePairs(`${text}；Aventon · Cargo Max = ranger-commuter；瞎写一对 = 没有这款`, {
      rivals,
      own: OWN,
    })
    expect(back.pairs.map((p) => `${p.product_key}->${p.own_key}`)).toEqual([
      '7001->ranger-commuter',
      '7003->city-helmet',
      '7004->ranger-commuter',
    ])
    expect(back.pairs.every((p) => p.by === 'user')).toBe(true)
    expect(back.bad).toEqual(['瞎写一对 = 没有这款'])
  })
})
