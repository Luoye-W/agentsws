/**
 * WP394：云端那一路读不到划线价和优惠券（`fields_unread`）——这两格照实空着，对比时不当「打折结束」，
 * 快照里留着上一次读到的值；下一次内置浏览器读到了，和那个值比。
 */
import type { CatalogSnapshotRow, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { diffCatalog } from '../src/index.js'

const WS = 'ws_demo' as WorkspaceId
const AMZ = { id: 'cw_amz_c1_US', kind: 'amazon_asin' as const, competitor_id: 'c1' }
const DAY1 = '2026-10-10T01:00:00.000Z'
const DAY2 = '2026-10-11T01:00:00.000Z'
const DAY3 = '2026-10-12T01:00:00.000Z'

const row = (over: Partial<CatalogSnapshotRow>): CatalogSnapshotRow => ({
  source_id: AMZ.id,
  competitor_id: 'c1',
  product_key: 'B0TESTRG01',
  title: 'Trail 500',
  price: 1299,
  compare_at_price: 1499,
  coupon: 'Apply $100 coupon',
  currency: 'USD',
  available: true,
  read_at: DAY1,
  ...over,
})

const step = (
  previous: ReturnType<typeof diffCatalog>['snapshot'] | undefined,
  r: CatalogSnapshotRow,
  now: string,
) =>
  diffCatalog({
    workspace_id: WS,
    source: AMZ,
    competitor: 'Rival Gear',
    previous,
    read: { rows: [r], complete: true },
    now,
  })

describe('WP394 · 读不到的格子照实空着', () => {
  it('云端那一次没有划线价 / 优惠券：不报「打折结束」，价变了照报改价；快照留着上一次的划线价', () => {
    const d1 = step(undefined, row({}), DAY1)
    const cloud = row({
      price: 1199,
      read_at: DAY2,
      fields_unread: ['compare_at_price', 'coupon'],
    })
    delete cloud.compare_at_price
    delete cloud.coupon
    const d2 = step(d1.snapshot, cloud, DAY2)
    expect(d2.changes.map((c) => c.kind)).toEqual(['price'])
    const kept = d2.snapshot.rows[0]
    expect(kept?.compare_at_price).toBe(1499)
    expect(kept?.coupon).toBe('Apply $100 coupon')
    expect(kept?.fields_unread).toBeUndefined()
    // 第三天内置浏览器又读到了：优惠券没了 = 真的「打折结束」那一条
    const d3 = step(d2.snapshot, row({ price: 1199, read_at: DAY3, coupon: undefined }), DAY3)
    expect(d3.changes.map((c) => c.kind)).toEqual(['discount_end'])
  })

  it('第一次就是云端读的（底子里没有划线价）：下一次读到划线价也不报「开始打折」', () => {
    const first = row({ fields_unread: ['compare_at_price', 'coupon'] })
    delete first.compare_at_price
    delete first.coupon
    const d1 = step(undefined, first, DAY1)
    const d2 = step(d1.snapshot, row({ read_at: DAY2 }), DAY2)
    expect(d2.changes).toEqual([])
  })
})
