/**
 * WP63（51 §2.1 / §2.2）：店铺管理与内容与博客的面板积木。
 *
 * 要钉住的四句话：
 *
 * 1. **待审改动分四条车道**，每条只收自己那几种 `ChangeKind`——混成一张「待审 12 条」
 *    人就只能一张张点开看它到底是哪一类。
 * 2. **库存那几块看的是职责 yml 里的阈值**，不是代码里写死的数。
 * 3. **评价应用没接就明说**：差评那一块 `not_connected`，而且 `note` 说得出
 *    "还没做"而不是"你去连一下"。
 * 4. **算不出就不出卡**：GA4 没连 → 一张转化异常卡都不出，而不是拿 0 去比出个 100%。
 */
import { describe, expect, it } from 'vitest'
import {
  ANOMALY_DEFAULTS,
  assembleView,
  blocksForRole,
  computeBlock,
  computeTile,
  DEFAULT_HOME_TILES,
  detectAnomalies,
  PENDING_LANES,
  queryNames,
  runQuery,
  tileSpec,
} from '../src/index.js'
import type { TableResult } from '../src/types.js'
import { INVENTORY, POSTS, queryContext, storeChangeItem } from './fixtures.js'

const rowsOf = (data: unknown): Record<string, string | number>[] =>
  (data as TableResult).rows ?? []

describe('51 §2.1 待审改动：四条车道各收各的', () => {
  const ctx = queryContext({
    role_id: 'dtc.store',
    approvals: [
      storeChangeItem('listing_edit'),
      storeChangeItem('collection_edit'),
      storeChangeItem('price_change'),
      storeChangeItem('publish_product'),
      storeChangeItem('unpublish_product'),
      storeChangeItem('discount_code'),
      storeChangeItem('promotion'),
      storeChangeItem('publish_post'),
      // 已经批过的那条不该出现在"待审"里
      storeChangeItem('price_change', { id: 'ap_done', state: 'applied' }),
    ],
  })

  it('每条车道都在查询注册表里', () => {
    for (const lane of PENDING_LANES) {
      expect(queryNames(), lane.lane).toContain(`changes.pending_${lane.lane}`)
    }
  })

  it('文案车道收 listing_edit 与 collection_edit；改价车道只收改价', () => {
    const listing = runQuery('changes.pending_listing', ctx, 'yesterday')
    expect(listing.status).toBe('ok')
    if (listing.status !== 'ok') return
    expect(
      rowsOf(listing.data)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['collection_edit', 'listing_edit'])

    const price = runQuery('changes.pending_price', ctx, 'yesterday')
    if (price.status !== 'ok') return
    // 已 applied 的那条不算"待审"
    expect(rowsOf(price.data).map((r) => r.kind)).toEqual(['price_change'])
  })

  it('上下架车道收两条、促销车道收两条——加起来就是 51 §2.1 那四条车道', () => {
    const publish = runQuery('changes.pending_publish', ctx, 'yesterday')
    const promo = runQuery('changes.pending_promotion', ctx, 'yesterday')
    if (publish.status !== 'ok' || promo.status !== 'ok') throw new Error('unreachable')
    expect(
      rowsOf(publish.data)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['publish_product', 'unpublish_product'])
    expect(
      rowsOf(promo.data)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['discount_code', 'promotion'])
  })

  it('博客那条车道归内容与博客，不混进店铺管理的四条里', () => {
    const post = runQuery('changes.pending_publish_post', ctx, 'yesterday')
    if (post.status !== 'ok') return
    expect(rowsOf(post.data).map((r) => r.kind)).toEqual(['publish_post'])
    // 店铺那四条车道里一条 publish_post 都没有
    for (const lane of ['listing', 'price', 'publish', 'promotion']) {
      const r = runQuery(`changes.pending_${lane}`, ctx, 'yesterday')
      if (r.status !== 'ok') continue
      expect(
        rowsOf(r.data).map((x) => x.kind),
        lane,
      ).not.toContain('publish_post')
    }
  })
})

describe('51 §2.1 库存：阈值来自职责 yml', () => {
  const ctx = (thresholds?: Record<string, number>) =>
    queryContext({
      role_id: 'dtc.store',
      inventory: INVENTORY,
      ...(thresholds === undefined ? {} : { thresholds }),
    })

  it('默认线 5：告急两行（2 与 0），40 那行不算', () => {
    const r = runQuery('inventory.low_stock', ctx(), 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data).map((x) => x.quantity)).toEqual([0, 2])
  })

  it('职责把线调到 50 → 三行全算告急（数字块跟着变）', () => {
    const c = ctx({ low_stock_quantity: 50 })
    const r = runQuery('inventory.low_stock', c, 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data)).toHaveLength(3)
    const tile = computeTile(tileSpec('low_stock_count'), c, 'yesterday')
    expect(tile.value).toBe(3)
  })

  it('「库存告急数」是存量：环比与迷你走势铺平，不编一条假走势', () => {
    const tile = computeTile(tileSpec('low_stock_count'), ctx(), 'yesterday')
    expect(tile.value).toBe(2)
    expect(tile.previous).toBe(2)
    expect(new Set(tile.spark)).toEqual(new Set([2]))
  })

  it('这个数据集不带库存 → 一行都不出（不当成 0 报一堆断货）', () => {
    const r = runQuery('inventory.low_stock', queryContext({ role_id: 'dtc.store' }), 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data)).toEqual([])
  })
})

describe('51 §2.1 差评表：评价应用还没接，面板上要说得出那句话', () => {
  const ctx = queryContext({ role_id: 'dtc.store' })

  it('差评那一块是 not_connected，不是空表', () => {
    const data = computeBlock('store.bad_reviews', ctx, 'yesterday')
    expect(data.status).toBe('not_connected')
  })

  it('分块上的 `note` 说的是"还没做"，不是"你去连一下"', () => {
    const view = assembleView('dtc.store', ctx)
    const section = view.find((s) => s.source === 'reviews')
    expect(section?.connected).toBe(false)
    expect(section?.note ?? '').not.toBe('')
    // 没连就别给「查看完整报告」——点进去也是别人的后台登录页
    expect(section?.report_url).toBeUndefined()
  })
})

describe('51 §2.2 内容与博客的三块', () => {
  const ctx = queryContext({ role_id: 'dtc.content', posts: POSTS })

  it('草稿队列只出没发的那些', () => {
    const r = runQuery('content.drafts', ctx, 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data).map((x) => x.title)).toEqual(['退换货说明（改写中）'])
  })

  it('近 30 天发布：半年前那篇不进来', () => {
    const r = runQuery('content.recent_posts', ctx, 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data).map((x) => x.title)).toEqual(['快充头怎么挑'])
  })

  it('GSC 没连 → 流量那一格是"—"而不是 0（0 会被读成"没人看"）', () => {
    const noClicks = queryContext({
      role_id: 'dtc.content',
      posts: POSTS.map((p) => {
        const { clicks: _drop, ...rest } = p
        return rest
      }),
    })
    const r = runQuery('content.recent_posts', noClicks, 'yesterday')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(rowsOf(r.data)[0]?.clicks).toBe('—')
  })

  it('面板里有那三块，且流量那一块归 Search Console（没连就明说）', () => {
    const ids = blocksForRole('dtc.content').map((b) => b.id)
    expect(ids).toContain('content.drafts')
    expect(ids).toContain('content.pending_publish')
    expect(ids).toContain('content.recent_posts')
    const gsc = assembleView('dtc.content', ctx).find((s) => s.source === 'gsc')
    expect(gsc?.connected).toBe(false)
  })
})

describe('51 §2.1 数字块与日报卡', () => {
  it('店铺管理的默认四格 = 总销售额、订单数、转化率、库存告急数', () => {
    expect(DEFAULT_HOME_TILES['dtc.store']).toEqual([
      'sales_total',
      'orders_count',
      'conversion_rate',
      'low_stock_count',
    ])
  })

  it('日报卡五行数全部从结构化行算出来，一个字不经模型手', () => {
    const ctx = queryContext({
      role_id: 'dtc.store',
      inventory: INVENTORY,
      approvals: [storeChangeItem('price_change')],
    })
    const data = computeBlock('store.daily_report', ctx, 'yesterday')
    expect(data.status).toBe('ok')
    const rows = rowsOf(data.payload)
    expect(rows.map((r) => r.item)).toEqual(['销售额', '环比', '订单数', '库存告急', '待审改动'])
    expect(rows.find((r) => r.item === '库存告急')?.value).toBe('2 个 SKU')
    expect(rows.find((r) => r.item === '待审改动')?.value).toBe('1 条')
  })

  // WP63：件数不是钱。表格渲染层不给 `format` 就按金额念——所以库存那一列必须自己说
  it('库存与评分那几列标了 `format: count`（2 件货不该渲染成 US$2.00）', () => {
    const r = runQuery(
      'inventory.low_stock',
      queryContext({ role_id: 'dtc.store', inventory: INVENTORY }),
      'yesterday',
    )
    if (r.status !== 'ok') throw new Error('unreachable')
    const col = (r.data as TableResult).columns.find((c) => c.key === 'quantity')
    expect(col?.format).toBe('count')
  })
})

describe('51 §2.1 异常卡：算得出才出，阈值来自职责 yml', () => {
  // 昨天（本地 09-06）卖了 129，前天（09-05）卖了 89 —— 涨了，不该出卡
  const base = queryContext({ role_id: 'dtc.store', inventory: INVENTORY })

  it('断货 → 出一张卡，并带上断的是哪几个 SKU', () => {
    const out = detectAnomalies({ ctx: base, range: 'yesterday' })
    const stock = out.find((a) => a.kind === 'stock_out')
    expect(stock?.actual).toBe(1)
    expect(stock?.refs).toEqual(['SKU-3'])
  })

  it('销售涨了 → 不出"骤降"卡（不出"一切正常"卡，空数组就是空数组）', () => {
    expect(detectAnomalies({ ctx: base, range: 'yesterday' }).map((a) => a.kind)).toEqual([
      'stock_out',
    ])
  })

  it('跌幅超过职责给的线 → 出卡；把线调高到 90 就不出', () => {
    const ctx = queryContext({
      role_id: 'dtc.store',
      orders: [
        {
          id: 'o1',
          name: '#1',
          email: 'a@b.c',
          currency: 'USD',
          created_at: '2026-09-06T02:00:00.000Z',
          total_price: 10,
          refunded_amount: 0,
          financial_status: 'paid',
          fulfillment_status: 'delivered',
        },
        {
          id: 'o2',
          name: '#2',
          email: 'a@b.c',
          currency: 'USD',
          created_at: '2026-09-05T02:00:00.000Z',
          total_price: 100,
          refunded_amount: 0,
          financial_status: 'paid',
          fulfillment_status: 'delivered',
        },
      ],
    })
    const hit = detectAnomalies({ ctx, range: 'yesterday' }).find((a) => a.kind === 'sales_drop')
    expect(hit?.actual).toBe(90)
    expect(hit?.threshold).toBe(ANOMALY_DEFAULTS.sales_drop_pct)

    const raised = detectAnomalies({
      ctx: { ...ctx, thresholds: { sales_drop_pct: 95 } },
      range: 'yesterday',
    })
    expect(raised.map((a) => a.kind)).not.toContain('sales_drop')
  })

  it('GA4 没连（拿不到转化率）→ 一张转化异常卡都不出', () => {
    const out = detectAnomalies({ ctx: base, range: 'yesterday' })
    expect(out.map((a) => a.kind)).not.toContain('conversion_drop')
    // 给了转化率、而且跌穿了线 → 才出
    const withConv = detectAnomalies({
      ctx: base,
      range: 'yesterday',
      conversion: { value: 1, previous: 2 },
    })
    expect(withConv.map((a) => a.kind)).toContain('conversion_drop')
  })
})
