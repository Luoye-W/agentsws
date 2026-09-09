import { describe, expect, it } from 'vitest'
import type { HomePosition } from '../src/index.js'
import {
  allBlocks,
  assembleHome,
  assembleView,
  blockDef,
  blocksForRole,
  COMPONENTS,
  computeBlock,
  computeTile,
  computeTiles,
  DEFAULT_HOME_TILES,
  DeckError,
  defaultTilesFor,
  isRegisteredComponent,
  MAX_TILES_PER_POSITION,
  projectCard,
  SOURCE_LABELS,
  TILE_LIBRARY,
  tileSpec,
  validatePayload,
  validateTileSelection,
} from '../src/index.js'
import { item, NOW, policyItem, queryContext, refundItem } from './fixtures.js'

describe('组件注册表（29 §7 用例 1）', () => {
  it('六个组件在册；未注册的名字被拒', () => {
    expect(COMPONENTS.map((c) => c.name)).toEqual([
      'stat_tile',
      'table',
      'chart_line',
      'timeline',
      'kv',
      'markdown',
    ])
    expect(isRegisteredComponent('stat_tile')).toBe(true)
    expect(isRegisteredComponent('evil_component')).toBe(false)
    expect(() => validatePayload('evil_component', { rows: [] })).toThrow(DeckError)
  })

  it('payload 不满足 schema → PAYLOAD_INVALID', () => {
    expect(() => validatePayload('stat_tile', { rows: [] })).toThrow(DeckError)
    expect(() => validatePayload('table', { rows: [] })).toThrow(DeckError)
    expect(() => validatePayload('chart_line', { rows: [] })).toThrow(DeckError)
    expect(() => validatePayload('timeline', { columns: [], rows: [] })).not.toThrow()
    expect(() => validatePayload('kv', { x: [], series: [] })).toThrow(DeckError)
    expect(() => validatePayload('markdown', { rows: [] })).not.toThrow()
    expect(() => validatePayload('stat_tile', { value: 1, previous: 0, spark: [] })).not.toThrow()
    expect(() => validatePayload('chart_line', { x: [], series: [] })).not.toThrow()
  })
})

describe('岗位面板（36 §3 按数据源分块）', () => {
  it('售后客服只有店铺后台（它的职责里没有 analytics 域）', () => {
    expect(assembleView('dtc.aftersales', queryContext()).map((s) => s.source)).toEqual(['shop'])
  })

  it('独立站运营有店铺后台 / GA4 / Search Console 三块', () => {
    const sections = assembleView('dtc.analytics', queryContext())
    expect(sections.map((s) => s.source)).toEqual(['shop', 'ga4', 'gsc'])
    expect(sections[0]?.connected).toBe(true)
    expect(sections[0]?.report_url).toBe('https://admin.shopify.com')
    // 未连接的块不给「查看完整报告」，界面上出「去连接」
    expect(sections[1]?.connected).toBe(false)
    expect(sections[1]?.report_url).toBeUndefined()
    expect(sections[1]?.label).toBe(SOURCE_LABELS.ga4)
  })

  it('投放岗位是广告后台 + GA4', () => {
    expect(assembleView('ads.meta', queryContext()).map((s) => s.source)).toEqual(['ads', 'ga4'])
  })

  it('没在表里的职责回落到店铺后台', () => {
    expect(blocksForRole('common.member').every((b) => b.source === 'shop')).toBe(true)
  })

  it('至少三种积木：stat_tile、table、chart_line', () => {
    const components = new Set(blocksForRole('dtc.analytics').map((b) => b.component))
    expect(components.has('stat_tile')).toBe(true)
    expect(components.has('table')).toBe(true)
    expect(components.has('chart_line')).toBe(true)
  })

  it('积木 id 全局唯一，未知 id 被拒', () => {
    const ids = allBlocks().map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(blockDef('shop.sales_trend').component).toBe('chart_line')
    expect(() => blockDef('nope')).toThrow(DeckError)
  })

  it('29 §2 全管线：跑查询 → 校验 payload → 返回；未连接的只回状态', () => {
    const ok = computeBlock('shop.recent_orders', queryContext(), 'last_7d')
    expect(ok.status).toBe('ok')
    expect(ok.payload).toBeDefined()
    const off = computeBlock('ga4.active_users', queryContext(), 'yesterday')
    expect(off.status).toBe('not_connected')
    expect(off.payload).toBeUndefined()
  })
})

describe('数字块（36 §3）', () => {
  it('三个岗位的默认值就是 36 §3 写的那几个', () => {
    expect(DEFAULT_HOME_TILES['dtc.analytics']).toEqual([
      'sales_total',
      'orders_count',
      'refunds_total',
      'conversion_rate',
    ])
    expect(DEFAULT_HOME_TILES['dtc.aftersales']).toEqual([
      'pending_replies',
      'reply_rate_24h',
      'refund_requests',
      'csat',
    ])
    expect(DEFAULT_HOME_TILES['ads.meta']).toEqual(['ads_spend', 'ads_roas', 'ads_cpa', 'ads_ctr'])
    expect(defaultTilesFor('common.member')).toEqual([])
  })

  it('每个库里的块都有对应的命名查询', () => {
    for (const t of TILE_LIBRARY) expect(() => tileSpec(t.id)).not.toThrow()
    expect(() => tileSpec('nope')).toThrow(DeckError)
  })

  it('上限 6，超了就拒；重复的去掉', () => {
    expect(validateTileSelection(['sales_total', 'sales_total', 'orders_count'])).toEqual([
      'sales_total',
      'orders_count',
    ])
    expect(() =>
      validateTileSelection(new Array(MAX_TILES_PER_POSITION + 1).fill('sales_total')),
    ).toThrow(DeckError)
    expect(() => validateTileSelection(['nope'])).toThrow(DeckError)
  })

  it('接了的块出数、没接的块出「去连接」', () => {
    const tiles = computeTiles(defaultTilesFor('dtc.analytics'), queryContext(), 'yesterday')
    expect(tiles.map((t) => t.status)).toEqual(['ok', 'ok', 'ok', 'not_connected'])
    expect(tiles[0]?.value).toBe(129)
    expect(tiles[0]?.currency).toBe('USD')
    expect(tiles[0]?.direction).toBe('up')
    expect(tiles[3]?.spark).toEqual([])
  })

  it('环比箭头三态', () => {
    const ctx = queryContext()
    expect(computeTile(tileSpec('sales_total'), ctx, 'yesterday').direction).toBe('up')
    const flat = computeTile(tileSpec('orders_count'), ctx, 'yesterday')
    expect(flat.direction).toBe('flat')
    const down = computeTile(
      tileSpec('sales_total'),
      queryContext({
        orders: [
          {
            id: 'o',
            name: '#1',
            email: 'x',
            currency: 'USD',
            created_at: '2026-09-05T02:00:00.000Z',
            total_price: 10,
            refunded_amount: 0,
            financial_status: 'paid',
            fulfillment_status: 'delivered',
          },
        ],
      }),
      'yesterday',
    )
    expect(down.direction).toBe('down')
  })

  it('数字块只接标量查询', () => {
    expect(() =>
      computeTile(
        {
          id: 'bad',
          label: 'bad',
          query: 'orders.recent',
          format: 'count',
          range_default: 'yesterday',
        },
        queryContext(),
        'yesterday',
      ),
    ).toThrow(DeckError)
  })
})

describe('首页装配（36 §3 三区 + 预计 X 分钟）', () => {
  const position = (over: Partial<HomePosition> = {}): HomePosition => ({
    position_id: 'asg_1',
    role_id: 'dtc.aftersales',
    role_name: '独立站售后客服',
    items: [item(), refundItem()],
    tile_ids: defaultTilesFor('dtc.aftersales'),
    range: 'yesterday',
    query: queryContext(),
    ...over,
  })

  it('队列 + 告警 + 每岗位一条数据条 + 预计分钟', () => {
    const home = assembleHome({ now: NOW, positions: [position()] })
    expect(home.queue).toHaveLength(2)
    expect(home.alerts).toHaveLength(0)
    expect(home.tiles).toHaveLength(1)
    expect(home.tiles[0]?.tiles).toHaveLength(4)
    expect(home.estimated_minutes).toBe(4)
    expect(home.range).toBe('yesterday')
  })

  it('首页数据条里只有数字块，没有表也没有图', () => {
    const home = assembleHome({ now: NOW, positions: [position()] })
    for (const bar of home.tiles) {
      for (const t of bar.tiles) {
        expect(Object.keys(t)).not.toContain('columns')
        expect(Object.keys(t)).not.toContain('series')
      }
    }
  })

  it('P0 与系统卡进告警区，摘要卡不进队列', () => {
    const home = assembleHome({
      now: NOW,
      positions: [
        position({
          items: [
            item({ id: 'urgent', priority: 'immediate' }),
            item({ id: 'digest_item', kind: 'digest' }),
          ],
        }),
      ],
      alerts: [
        {
          ...projectCard(item({ id: 'sys' }), { now: NOW, position_id: 'asg_1' }),
          kind: 'system_alert',
        },
      ],
    })
    expect(home.queue).toHaveLength(0)
    expect(home.alerts.map((c) => c.id).sort()).toEqual(['sys', 'urgent'])
  })

  it('全局 range 覆盖岗位记忆；摘要卡原样带出', () => {
    const digest = {
      ...projectCard(item({ id: 'd' }), { now: NOW, position_id: 'asg_1' }),
      kind: 'digest' as const,
    }
    const home = assembleHome({
      now: NOW,
      positions: [position({ range: 'yesterday' })],
      range: 'last_7d',
      digest,
      label: () => 'Anna',
      riskClass: () => 'low',
    })
    expect(home.range).toBe('last_7d')
    expect(home.tiles[0]?.range).toBe('last_7d')
    expect(home.digest?.id).toBe('d')
    expect(home.queue[0]?.risk_class).toBe('low')
  })

  it('一个岗位都没有时也不炸', () => {
    const home = assembleHome({ now: NOW, positions: [] })
    expect(home.range).toBe('yesterday')
    expect(home.estimated_minutes).toBe(0)
  })

  it('多岗位：队列合并、数据条各一条（首页形状不随岗位数变）', () => {
    const home = assembleHome({
      now: NOW,
      positions: [
        position(),
        position({
          position_id: 'asg_2',
          role_id: 'dtc.analytics',
          role_name: '独立站运营',
          items: [policyItem()],
          tile_ids: defaultTilesFor('dtc.analytics'),
          query: queryContext({ role_id: 'dtc.analytics', position_id: 'asg_2' }),
        }),
      ],
    })
    expect(home.tiles).toHaveLength(2)
    // policy_change 是高风险 → P1，排在两张 P2 前面
    expect(home.queue[0]?.kind).toBe('policy_change')
  })
})
