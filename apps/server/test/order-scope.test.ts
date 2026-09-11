/**
 * WP47 / 44 G2 读那一半：订单按产品线切。
 *
 * 钉住四件事：
 * 1. 能下推的翻成 Shopify 搜索语法，有人挂着整家店就**不下推**（共用一份缓存，切了别人也没得看）；
 * 2. 拉回来按行项目再切一次，混单两边都看得见、金额各算各的一半；
 * 3. 没有行项目就切不动 → 不进产品线视角（宁可少算，不把别人的钱算到你头上）；
 * 4. 挂整店的岗位原样看全部；一条范围都没有的看不到任何东西（05 §5）。
 */
import type { ProductLine, RangeRef } from '@agentsws/contracts'
import type { OrderRow } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { lineItemsOf } from '../src/live-data.js'
import {
  LINE_ITEM_BACKFILL_DAYS,
  type OrderScopePort,
  pushdownQueryOf,
  scopedOrders,
  sliceOrder,
} from '../src/order-scope.js'

const line = (id: string, rule: ProductLine['rule'], parent = 'store_main'): ProductLine => ({
  id,
  workspace_id: 'ws_1',
  name: id,
  parent: { kind: 'store', id: parent },
  rule,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
})

function scopeOf(input: {
  lines?: ProductLine[]
  assignments?: Record<string, RangeRef[]>
}): OrderScopePort {
  const lines = input.lines ?? []
  const assignments = input.assignments ?? {}
  return {
    rangesOf: (id) => assignments[id] ?? [],
    productLine: (id) => lines.find((l) => l.id === id),
    productLines: () => lines,
    activeRanges: () => Object.values(assignments),
  }
}

const order = (id: string, total: number, items?: OrderRow['line_items']): OrderRow => ({
  id,
  name: `#${id}`,
  email: 'a@example.com',
  currency: 'USD',
  created_at: '2026-09-08T09:00:00.000Z',
  total_price: total,
  refunded_amount: 0,
  financial_status: 'paid',
  fulfillment_status: 'fulfilled',
  ...(items === undefined ? {} : { line_items: items }),
})

describe('过滤下推（19 §3）', () => {
  it('全公司都只挂产品线、判据又翻得成搜索语法 → 下推', () => {
    const kitchen = line('pl_kitchen', { platform: 'shopify', tags: ['kitchen'] })
    const outdoor = line('pl_outdoor', { platform: 'shopify', vendors: ['Outdoorly'] })
    const scope = scopeOf({
      lines: [kitchen, outdoor],
      assignments: {
        a1: [{ kind: 'product_line', id: 'pl_kitchen' }],
        a2: [{ kind: 'product_line', id: 'pl_outdoor' }],
      },
    })
    expect(pushdownQueryOf(scope)).toBe('(tag:kitchen) OR (vendor:Outdoorly)')
  })

  it('只要有一个人挂着整家店就不下推（缓存是全公司共用的一份）', () => {
    const scope = scopeOf({
      lines: [line('pl_kitchen', { platform: 'shopify', tags: ['kitchen'] })],
      assignments: {
        a1: [{ kind: 'product_line', id: 'pl_kitchen' }],
        a2: [{ kind: 'store', id: 'store_main' }],
      },
    })
    expect(pushdownQueryOf(scope)).toBeUndefined()
  })

  it('判据翻不成搜索语法（亚马逊 / 手填清单）就全拉回来本地切', () => {
    expect(
      pushdownQueryOf(
        scopeOf({
          lines: [line('pl_kitchen', { platform: 'manual', product_ids: ['prod_1'] })],
          assignments: { a1: [{ kind: 'product_line', id: 'pl_kitchen' }] },
        }),
      ),
    ).toBeUndefined()
    expect(
      pushdownQueryOf(
        scopeOf({
          lines: [line('pl_kitchen', { platform: 'amazon', asins: ['B01'] })],
          assignments: { a1: [{ kind: 'product_line', id: 'pl_kitchen' }] },
        }),
      ),
    ).toBeUndefined()
  })

  it('一条产品线都没有 / 没装制度口子 → 一次都不下推', () => {
    expect(pushdownQueryOf(undefined)).toBeUndefined()
    expect(pushdownQueryOf(scopeOf({}))).toBeUndefined()
    // 有产品线但没人挂：也不下推（挂了范围的一个都没有）
    expect(
      pushdownQueryOf(
        scopeOf({ lines: [line('pl_kitchen', { platform: 'shopify', tags: ['kitchen'] })] }),
      ),
    ).toBeUndefined()
  })

  it('引用到的产品线定义丢了 → 不下推（宁可多拉，不少拉）', () => {
    expect(pushdownQueryOf(scopeOf({ lines: [], assignments: {} }))).toBeUndefined()
    const scope = scopeOf({
      lines: [line('pl_kitchen', { platform: 'shopify', tags: ['kitchen'] })],
      assignments: { a1: [{ kind: 'product_line', id: 'pl_gone' }] },
    })
    expect(pushdownQueryOf(scope)).toBeUndefined()
  })
})

describe('本地按行项目切（44 §3 G2）', () => {
  const kitchen = line('pl_kitchen', { platform: 'manual', product_ids: ['prod_1'] })

  it('混了两条产品线的订单：两边都看得见，金额只算自己那部分行', () => {
    const mixed = order('ord_mix', 100, [
      { product_id: 'prod_1', quantity: 1, total: 40 },
      { product_id: 'prod_7', quantity: 1, total: 60 },
    ])
    mixed.refunded_amount = 10
    const sliced = sliceOrder(mixed, [kitchen])
    expect(sliced?.total_price).toBe(40)
    expect(sliced?.partial).toBe(true)
    expect(sliced?.full_total_price).toBe(100)
    // 退款按占比折算（40% 的单，摊 40% 的退款）
    expect(sliced?.refunded_amount).toBe(4)
    expect(sliced?.line_items).toHaveLength(1)
  })

  it('整单都是自己的 → 原样回，不标 partial', () => {
    const mine = order('ord_mine', 40, [{ product_id: 'prod_1', quantity: 1, total: 40 }])
    const sliced = sliceOrder(mine, [kitchen])
    expect(sliced).toBe(mine)
    expect(sliced?.partial).toBeUndefined()
  })

  it('一行都不是自己的 → 这张订单不属于他', () => {
    const theirs = order('ord_theirs', 60, [{ product_id: 'prod_7', quantity: 1, total: 60 }])
    expect(sliceOrder(theirs, [kitchen])).toBeUndefined()
  })

  it('没有行项目就切不动 → 不进产品线视角', () => {
    expect(sliceOrder(order('ord_bare', 60), [kitchen])).toBeUndefined()
    expect(sliceOrder(order('ord_empty', 60, []), [kitchen])).toBeUndefined()
  })

  it('整单金额为 0 时退款不按比例乱摊', () => {
    const zero = order('ord_zero', 0, [
      { product_id: 'prod_1', quantity: 1, total: 0 },
      { product_id: 'prod_7', quantity: 1, total: 0 },
    ])
    zero.refunded_amount = 5
    expect(sliceOrder(zero, [kitchen])?.refunded_amount).toBe(0)
  })
})

describe('岗位视角的订单表', () => {
  const kitchen = line('pl_kitchen', { platform: 'manual', product_ids: ['prod_1'] })
  const outdoor = line('pl_outdoor', { platform: 'manual', product_ids: ['prod_7'] })
  const all = [
    order('ord_k', 40, [{ product_id: 'prod_1', quantity: 1, total: 40 }]),
    order('ord_o', 60, [{ product_id: 'prod_7', quantity: 1, total: 60 }]),
    order('ord_mix', 100, [
      { product_id: 'prod_1', quantity: 1, total: 40 },
      { product_id: 'prod_7', quantity: 1, total: 60 },
    ]),
  ]
  const scope = scopeOf({
    lines: [kitchen, outdoor],
    assignments: {
      a_zhao: [{ kind: 'product_line', id: 'pl_kitchen' }],
      a_qian: [{ kind: 'product_line', id: 'pl_outdoor' }],
      a_li: [{ kind: 'store', id: 'store_main' }],
      a_feng: [],
    },
  })

  it('两条产品线的两个运营互相看不到对方的订单', () => {
    const zhao = scopedOrders(all, scope, { assignment_id: 'a_zhao' })
    const qian = scopedOrders(all, scope, { assignment_id: 'a_qian' })
    expect(zhao.map((o) => o.id)).toEqual(['ord_k', 'ord_mix'])
    expect(qian.map((o) => o.id)).toEqual(['ord_o', 'ord_mix'])
    // 同一张混单，两边算出来的钱加起来正好是整单
    const zhaoMix = zhao.find((o) => o.id === 'ord_mix')
    const qianMix = qian.find((o) => o.id === 'ord_mix')
    expect((zhaoMix?.total_price ?? 0) + (qianMix?.total_price ?? 0)).toBe(100)
  })

  it('挂整家店的看全部；一条范围都没有的什么都看不到（05 §5）', () => {
    expect(scopedOrders(all, scope, { assignment_id: 'a_li' })).toHaveLength(3)
    expect(scopedOrders(all, scope, { assignment_id: 'a_feng' })).toHaveLength(0)
  })

  it('没给视角 / 没装制度口子 → 老行为，原样回全部', () => {
    expect(scopedOrders(all, scope, undefined)).toHaveLength(3)
    expect(scopedOrders(all, scope, { assignment_id: '' })).toHaveLength(3)
    expect(scopedOrders(all, undefined, { assignment_id: 'a_zhao' })).toHaveLength(3)
  })

  it('挂的产品线定义全丢了 → 看不到（不是看全部）', () => {
    const broken = scopeOf({
      lines: [],
      assignments: { a_x: [{ kind: 'product_line', id: 'pl_gone' }] },
    })
    expect(scopedOrders(all, broken, { assignment_id: 'a_x' })).toHaveLength(0)
  })
})

describe('行项目映射（真身与替身两种形状）', () => {
  it('REST 的 snake_case', () => {
    expect(
      lineItemsOf([
        { id: 'li_1', product_id: 4242, quantity: 2, price: '19.50', sku: 'KIT-1', vendor: 'Nord' },
      ]),
    ).toEqual([
      {
        id: 'li_1',
        product_id: '4242',
        sku: 'KIT-1',
        vendor: 'Nord',
        quantity: 2,
        total: 39,
      },
    ])
  })

  it('GraphQL 的 edges + 钱包结构', () => {
    expect(
      lineItemsOf({
        edges: [
          {
            node: {
              quantity: 1,
              title: 'USB-C 65W Charger',
              product: { id: 'gid://shopify/Product/1', productType: 'Charger', vendor: 'Nord' },
              originalTotalSet: { shopMoney: { amount: '129.00', currencyCode: 'USD' } },
            },
          },
        ],
      }),
    ).toEqual([
      {
        product_id: 'gid://shopify/Product/1',
        title: 'USB-C 65W Charger',
        vendor: 'Nord',
        product_type: 'Charger',
        quantity: 1,
        total: 129,
      },
    ])
  })

  it('认不出来回 undefined——绝不编一行出来', () => {
    expect(lineItemsOf(undefined)).toBeUndefined()
    expect(lineItemsOf('not a list')).toBeUndefined()
    expect(lineItemsOf([])).toBeUndefined()
    expect(lineItemsOf([1, 2, 3])).toBeUndefined()
  })

  it('补行项目只补近 7 天', () => {
    expect(LINE_ITEM_BACKFILL_DAYS).toBe(7)
  })
})
