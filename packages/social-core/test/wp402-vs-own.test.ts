/**
 * WP402（决策 1137）：「比你便宜 $N」——拿竞品这一款的**起价**（各款式里最低的现价）和自家**对应款**比；
 * WP408（决策 1154）：没有对应款就不比，只报竞品自己的价格变化。
 */
import type { CatalogSnapshotRow, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { describeChange, diffCatalog } from '../src/index.js'

const WS = 'ws_wp402' as WorkspaceId
const SHOP = { id: 'cw_shop_c1', kind: 'shop_catalog' as const, competitor_id: 'c1' }
const DAY1 = '2026-10-10T01:00:00.000Z'
const DAY2 = '2026-10-11T01:00:00.000Z'

const row = (over: Partial<CatalogSnapshotRow> & { product_key: string }): CatalogSnapshotRow => ({
  source_id: SHOP.id,
  competitor_id: 'c1',
  title: 'Trail 500',
  price: 1000,
  currency: 'USD',
  available: true,
  product_created_at: '2025-01-01T00:00:00.000Z',
  read_at: DAY1,
  ...over,
})

// Trail 500 两个款式：$999 / $949；第二天降到 $799 / $779。变得最多的是 $999 → $799（-20%），起价是 $779
// ——老算法拿 $799 比，决策 1137 拿起价 $779 比
const day1 = [
  row({ product_key: 'trail', variant_key: 'a', price: 999 }),
  row({ product_key: 'trail', variant_key: 'b', price: 949 }),
]
const day2 = [
  row({ product_key: 'trail', variant_key: 'a', price: 799 }),
  row({ product_key: 'trail', variant_key: 'b', price: 779 }),
]

const diff = (extra: Parameters<typeof diffCatalog>[0] extends infer T ? Partial<T> : never) => {
  const base = diffCatalog({
    workspace_id: WS,
    source: SHOP,
    competitor: 'Rival',
    previous: undefined,
    read: { rows: day1, complete: true },
    now: DAY1,
  }).snapshot
  return diffCatalog({
    workspace_id: WS,
    source: SHOP,
    competitor: 'Rival',
    previous: base,
    read: { rows: day2, complete: true },
    now: DAY2,
    ...extra,
  })
}

describe('WP402 / WP408 · 比你便宜多少（决策 1137 / 1154）', () => {
  it('有对应款：竞品这一款的起价（$779）对你的对应款（$899）——不是拿变得最多的那个款式比', () => {
    const out = diff({
      ownRef: () => ({ own_key: 'ridge', own_title: 'Ridge 500', own_price: 899, currency: 'USD' }),
    })
    const c = out.changes.find((x) => x.kind === 'price')
    expect(c?.vs_own).toMatchObject({ own_key: 'ridge', diff: -120, basis: 'pair' })
    expect(describeChange(c as never)).toContain('比你的 Ridge 500 便宜 $120')
  })

  it('WP408（决策 1154）：没有对应款就不比——给了「店里最便宜的」也不看，只报竞品自己的价格变化', () => {
    const out = diff({
      ownRef: () => undefined,
      ownLowest: { own_key: 'mini', own_title: 'Mini 200', own_price: 599, currency: 'USD' },
    })
    const c = out.changes.find((x) => x.kind === 'price')
    expect(c).toBeDefined()
    expect(c?.vs_own).toBeUndefined()
    const line = describeChange(c as never)
    expect(line).toContain('Trail 500')
    expect(line).not.toContain('便宜 $')
    expect(line).not.toContain('最便宜')
    expect(describeChange(c as never, { lang: 'en' })).not.toContain('your cheapest')
  })

  it('有对应款时新数据一律 basis = pair；老数据的 lowest 照旧照实说', () => {
    const out = diff({
      ownRef: () => ({ own_key: 'ridge', own_title: 'Ridge 500', own_price: 899, currency: 'USD' }),
      ownLowest: { own_key: 'mini', own_title: 'Mini 200', own_price: 599, currency: 'USD' },
    })
    const c = out.changes.find((x) => x.kind === 'price')
    expect(c?.vs_own).toMatchObject({ own_key: 'ridge', basis: 'pair' })
    const old = {
      ...c,
      vs_own: {
        own_key: 'mini',
        own_title: 'Mini 200',
        own_price: 599,
        diff: 180,
        currency: 'USD',
        basis: 'lowest',
      },
    }
    expect(describeChange(old as never)).toContain('起价比你店里最便宜的 Mini 200 贵 $180')
  })

  it('两边都没有（没连店）/ 币种不一样：不比', () => {
    expect(diff({}).changes.find((x) => x.kind === 'price')?.vs_own).toBeUndefined()
    const eur = diff({ ownLowest: { own_key: 'm', own_price: 500, currency: 'EUR' } })
    expect(eur.changes.find((x) => x.kind === 'price')?.vs_own).toBeUndefined()
  })
})
