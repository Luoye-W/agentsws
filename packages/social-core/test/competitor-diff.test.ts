import type { CatalogSnapshot, CatalogSnapshotRow, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type CatalogDiffInput,
  describeChange,
  diffCatalog,
  queryCompetitorChanges,
  watchItemOfChange,
} from '../src/index.js'

const WS = 'ws_demo' as WorkspaceId
const SHOP = { id: 'cw_shop_c1', kind: 'shop_catalog' as const, competitor_id: 'c1' }
const AMZ = { id: 'cw_amz_c1_US', kind: 'amazon_asin' as const, competitor_id: 'c1' }
const DAY1 = '2026-10-10T01:00:00.000Z'
const DAY2 = '2026-10-11T01:00:00.000Z'
const DAY3 = '2026-10-12T01:00:00.000Z'

const row = (over: Partial<CatalogSnapshotRow> & { product_key: string }): CatalogSnapshotRow => ({
  source_id: SHOP.id,
  competitor_id: 'c1',
  title: `Bike ${over.product_key}`,
  url: `https://example-bikes.test/products/${over.product_key}`,
  price: 1000,
  currency: 'USD',
  available: true,
  product_created_at: '2025-01-01T00:00:00.000Z',
  read_at: DAY1,
  ...over,
})

/** 跑一次：previous 是上一次的快照。 */
const run = (
  previous: CatalogSnapshot | undefined,
  rows: CatalogSnapshotRow[],
  now: string,
  extra: Partial<CatalogDiffInput> = {},
) =>
  diffCatalog({
    workspace_id: WS,
    source: SHOP,
    competitor: 'Example Bikes',
    previous,
    read: { rows, complete: true },
    now,
    ...extra,
  })

const catalog = (): CatalogSnapshotRow[] => [
  row({ product_key: 'p1', variant_key: 'v1', variant_title: 'S' }),
  row({ product_key: 'p1', variant_key: 'v2', variant_title: 'M' }),
  row({ product_key: 'p1', variant_key: 'v3', variant_title: 'L' }),
  row({ product_key: 'p2', variant_key: 'v4', price: 1599, compare_at_price: 1799 }),
  row({ product_key: 'p3', variant_key: 'v5', price: 499 }),
]

describe('WP392 快照对比：底子与上新', () => {
  it('第一次读只当底子，398 件也不报上新', () => {
    const many = Array.from({ length: 398 }, (_, i) =>
      row({ product_key: `p${i}`, product_created_at: DAY1 }),
    )
    const out = run(undefined, many, DAY1)
    expect(out.baseline).toBe(true)
    expect(out.changes).toEqual([])
    expect(out.snapshot.rows).toHaveLength(398)
    expect(out.snapshot.reads).toBe(1)
  })

  it('第一次出现 + 最近 7 天内创建 = 上新；读不到创建时间就只看第一次出现', () => {
    const base = run(undefined, catalog(), DAY1).snapshot
    const out = run(
      base,
      [
        ...catalog(),
        row({ product_key: 'p9', variant_key: 'v9', product_created_at: '2026-10-09T00:00:00Z' }),
        row({ product_key: 'p10', variant_key: 'v10', product_created_at: undefined }),
        // 老货（创建于去年，这次才翻到）不算上新
        row({ product_key: 'p11', variant_key: 'v11' }),
      ],
      DAY2,
    )
    expect(out.baseline).toBe(false)
    expect(out.changes.map((c) => [c.kind, c.product_key]).sort()).toEqual([
      ['new', 'p10'],
      ['new', 'p9'],
    ])
  })

  it('老商品新加一个款式不算上新；判过下架再出现（重新上架）也不算', () => {
    let snap = run(undefined, catalog(), DAY1).snapshot
    const withoutP3 = catalog().filter((r) => r.product_key !== 'p3')
    snap = run(snap, withoutP3, DAY2).snapshot
    const gone = run(snap, withoutP3, DAY3)
    expect(gone.changes.map((c) => c.kind)).toEqual(['removed'])
    const back = run(
      gone.snapshot,
      [
        ...catalog().map((r) => ({ ...r, product_created_at: '2026-10-12T00:00:00Z' })),
        row({ product_key: 'p1', variant_key: 'v99', variant_title: 'XL' }),
      ],
      '2026-10-13T01:00:00.000Z',
    )
    expect(back.changes).toEqual([])
    expect(back.snapshot.rows.find((r) => r.product_key === 'p3')?.removed).toBeUndefined()
  })
})

describe('WP392 快照对比：下架', () => {
  it('连续两次读全了都没读到才算下架；只少一次不算', () => {
    let snap = run(undefined, catalog(), DAY1).snapshot
    const withoutP3 = catalog().filter((r) => r.product_key !== 'p3')
    const once = run(snap, withoutP3, DAY2)
    expect(once.changes).toEqual([])
    expect(once.snapshot.rows.find((r) => r.product_key === 'p3')?.missing).toBe(1)
    snap = once.snapshot
    const twice = run(snap, withoutP3, DAY3)
    expect(twice.changes).toHaveLength(1)
    expect(twice.changes[0]).toMatchObject({ kind: 'removed', product_key: 'p3', title: 'Bike p3' })
  })

  it('读得不完整（翻页断了 / 被挡）整次不判下架，也不数「没读到」', () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const partial = catalog().slice(0, 2)
    const a = diffCatalog({
      workspace_id: WS,
      source: SHOP,
      competitor: 'Example Bikes',
      previous: snap,
      read: { rows: partial, complete: false },
      now: DAY2,
    })
    const b = diffCatalog({
      workspace_id: WS,
      source: SHOP,
      competitor: 'Example Bikes',
      previous: a.snapshot,
      read: { rows: partial, complete: false },
      now: DAY3,
    })
    expect([...a.changes, ...b.changes]).toEqual([])
    expect(b.snapshot.rows.every((r) => r.missing === 0)).toBe(true)
    expect(b.snapshot.rows).toHaveLength(5)
  })

  it('一行都没读到却说读全了：照没读全处理', () => {
    let snap = run(undefined, catalog(), DAY1).snapshot
    snap = run(snap, [], DAY2).snapshot
    expect(run(snap, [], DAY3).changes).toEqual([])
  })

  it('一个商品只少了一个款式，不出「下架」', () => {
    let snap = run(undefined, catalog(), DAY1).snapshot
    const noV3 = catalog().filter((r) => r.variant_key !== 'v3')
    snap = run(snap, noV3, DAY2).snapshot
    expect(run(snap, noV3, DAY3).changes).toEqual([])
  })
})

describe('WP392 快照对比：价、打折、库存', () => {
  it('同一商品三个款式一起降价，合成一条「3 个款式降价 10%–15%」', () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const next = catalog().map((r) =>
      r.product_key !== 'p1'
        ? r
        : { ...r, price: r.variant_key === 'v1' ? 900 : r.variant_key === 'v2' ? 880 : 850 },
    )
    const out = run(snap, next, DAY2)
    expect(out.changes).toHaveLength(1)
    const c = out.changes[0]
    expect(c).toMatchObject({
      kind: 'price',
      product_key: 'p1',
      variants: 3,
      before: 1000,
      after: 850,
      pct: -15,
      pct_range: [-15, -10],
      currency: 'USD',
    })
    expect(c?.variant_keys?.sort()).toEqual(['v1', 'v2', 'v3'])
    expect(describeChange(c as never)).toBe('Bike p1（3 个款式）：降价10%–15%（$1,000 → $850）')
  })

  it('划线价从无到有 = 开始打折（不另出改价）；从有到无 = 打折结束', () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const next = catalog().map((r) =>
      r.product_key === 'p3'
        ? { ...r, price: 449, compare_at_price: 499 }
        : r.product_key === 'p2'
          ? { ...r, price: 1799, compare_at_price: undefined }
          : r,
    )
    const out = run(snap, next, DAY2)
    const kinds = out.changes.map((c) => [c.kind, c.product_key]).sort()
    expect(kinds).toEqual([
      ['discount_end', 'p2'],
      ['discount_start', 'p3'],
    ])
    const start = out.changes.find((c) => c.kind === 'discount_start')
    expect(start).toMatchObject({ before: 499, after: 449, pct: -10 })
  })

  it('有没有货翻转 = 断货 / 补货', () => {
    let snap = run(undefined, catalog(), DAY1).snapshot
    const out1 = run(
      snap,
      catalog().map((r) => (r.product_key === 'p3' ? { ...r, available: false } : r)),
      DAY2,
    )
    expect(out1.changes.map((c) => c.kind)).toEqual(['out_of_stock'])
    snap = out1.snapshot
    const out2 = run(snap, catalog(), DAY3)
    expect(out2.changes.map((c) => c.kind)).toEqual(['back_in_stock'])
  })

  it('店铺自己的 updated_at、图片、链接怎么跳都不出变化', () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const noisy = catalog().map(
      (r, i) =>
        ({
          ...r,
          updated_at: `2026-10-11T0${i}:00:00Z`,
          image: `https://cdn.test/${i}.jpg?v=${i}`,
          read_at: DAY2,
        }) as CatalogSnapshotRow,
    )
    expect(run(snap, noisy, DAY2).changes).toEqual([])
  })

  it('C8：写了对标款，就和自家比差价', () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const next = catalog().map((r) => (r.product_key === 'p3' ? { ...r, price: 399 } : r))
    const out = run(snap, next, DAY2, {
      ownRef: (r) =>
        r.product_key === 'p3'
          ? { own_key: 'ranger', own_title: 'Ranger', own_price: 599, currency: 'USD' }
          : undefined,
    })
    expect(out.changes[0]?.vs_own).toEqual({
      own_key: 'ranger',
      own_title: 'Ranger',
      own_price: 599,
      diff: -200,
      currency: 'USD',
      basis: 'pair',
    })
    expect(describeChange(out.changes[0] as never)).toContain('比你的 Ranger 便宜 $200')
  })
})

describe('WP392 快照对比：Amazon 三项', () => {
  const asin = (over: Partial<CatalogSnapshotRow> = {}): CatalogSnapshotRow =>
    row({
      source_id: AMZ.id,
      product_key: 'B0TEST0001',
      variant_key: undefined,
      price: 1299,
      rating: 4.46,
      reviews: 1200,
      bsr: [
        { rank: 5400, category: 'Sports & Outdoors' },
        { rank: 12, category: 'Electric Bicycles' },
      ],
      ...over,
    })
  const amz = (previous: CatalogSnapshot | undefined, r: CatalogSnapshotRow, now: string) =>
    diffCatalog({
      workspace_id: WS,
      source: AMZ,
      competitor: 'Example Bikes',
      previous,
      read: { rows: [r], complete: true },
      now,
    })

  it('评分保留一位小数后变了才算；评论数、BSR 变了就记（重不重要不在这里判）', () => {
    const snap = amz(undefined, asin(), DAY1).snapshot
    // 4.46 → 4.54：一位小数都是 4.5，不算
    expect(amz(snap, asin({ rating: 4.54 }), DAY2).changes).toEqual([])
    const out = amz(
      snap,
      asin({
        rating: 4.31,
        reviews: 1260,
        bsr: [
          { rank: 5400, category: 'Sports & Outdoors' },
          { rank: 9, category: 'Electric Bicycles' },
        ],
      }),
      DAY2,
    )
    const by = Object.fromEntries(out.changes.map((c) => [c.kind, c]))
    expect(by.rating).toMatchObject({ before: 4.5, after: 4.3 })
    expect(by.reviews).toMatchObject({ before: 1200, after: 1260, pct: 5 })
    expect(by.bsr).toMatchObject({ before: 12, after: 9, category: 'Electric Bicycles' })
    expect(out.changes.every((c) => c.importance === undefined)).toBe(true)
    expect(describeChange(by.reviews as never)).toBe('Bike B0TEST0001：评论数 1200 → 1260（+60）')
  })

  it('优惠券上了 / 没了 = 开始 / 结束打折', () => {
    const snap = amz(undefined, asin(), DAY1).snapshot
    const on = amz(snap, asin({ coupon: 'Save $100 with coupon' }), DAY2)
    expect(on.changes).toHaveLength(1)
    expect(on.changes[0]).toMatchObject({
      kind: 'discount_start',
      category: 'coupon',
      after: 'Save $100 with coupon',
    })
    expect(describeChange(on.changes[0] as never)).toBe(
      'Bike B0TEST0001：优惠券上了「Save $100 with coupon」',
    )
    const off = amz(on.snapshot, asin(), DAY3)
    expect(off.changes.map((c) => c.kind)).toEqual(['discount_end'])
  })
})

describe('WP392 变化表查询', () => {
  const changes = () => {
    const snap = run(undefined, catalog(), DAY1).snapshot
    const next = catalog().map((r) =>
      r.product_key === 'p3'
        ? { ...r, price: 449 }
        : r.product_key === 'p2'
          ? { ...r, available: false }
          : r,
    )
    return run(snap, next, DAY2).changes
  }

  it('按种类 / 竞品 / 时间窗筛，出参只有白名单', () => {
    const all = changes()
    const r = queryCompetitorChanges({ changes: all, filter: { kinds: ['price'] } })
    expect(r.totals.changes).toBe(1)
    expect(r.items[0]).toEqual({
      kind: 'price',
      kind_label: '改价',
      competitor: 'Example Bikes',
      title: 'Bike p3',
      url: 'https://example-bikes.test/products/p3',
      before: 499,
      after: 449,
      pct: -10,
      currency: 'USD',
      at: DAY2,
      text: 'Bike p3：降价10%（$499 → $449）',
    })
    expect(
      queryCompetitorChanges({ changes: all, filter: { competitor: 'example bikes' } }).totals,
    ).toMatchObject({ changes: 2, by_kind: { price: 1, out_of_stock: 1 } })
    expect(
      queryCompetitorChanges({
        changes: all,
        window: { since: DAY3, until: '2026-10-20T00:00:00Z' },
      }).totals.changes,
    ).toBe(0)
  })

  it('变成报告积木的条目：kind=change、外部、地点是竞品名', () => {
    const it0 = watchItemOfChange(changes()[0] as never)
    expect(it0).toMatchObject({ kind: 'change', platform: 'competitor', scope: 'external' })
    expect(it0.place).toBe('Example Bikes')
    expect(it0.change?.kind).toBeDefined()
  })
})
