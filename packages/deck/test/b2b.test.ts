/**
 * WP171（docs/84）：B2B 五条职责的面板块（少字，36 §7）。
 *
 * 钉三件事：
 * 1. 块 id 与职责 yml 的 `home_blocks[].id` 一一对上（yml 与面板不许各写各的）；
 * 2. **空态**：宿主没递 `ctx.b2b`，十九块照样算得出（空表），源永远算连上——
 *    空的意思是"还没有"，不是"去连接"；
 * 3. 状态念成人话：报价"谁批 / 超了"、样品"已寄"、名单"官方档"，不印枚举值。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assembleView,
  type B2bDeckData,
  blocksForRole,
  computeBlock,
  dataSourcesFromConnections,
  type QueryContext,
} from '../src/index.js'

const NOW = '2026-09-28T09:00:00.000Z'

/** 职责 yml 里的 home_blocks（deck 不依赖 roles 包，按那一行的写法抠出来）。 */
function ymlBlocks(role: string): { id: string; query: string }[] {
  const file = new URL(`../../roles/roles/b2b/${role.split('.')[1]}.yml`, import.meta.url)
  const text = readFileSync(file, 'utf8')
  return [
    ...text.matchAll(/\{ id: ([\w.]+), placement: \w+, component: \w+, query: ([\w.]+),/g),
  ].map((m) => ({ id: m[1] as string, query: m[2] as string }))
}
const ROLES = ['b2b.sales', 'b2b.outbound', 'b2b.exhibition', 'b2b.fulfillment', 'b2b.marketplace']

const ctx = (b2b?: B2bDeckData, role_id = 'b2b.sales'): QueryContext => ({
  now: NOW,
  tz_offset_minutes: 480,
  base_currency: 'USD',
  role_id,
  position_id: 'pos_b2b',
  orders: [],
  approvals: [],
  sources: dataSourcesFromConnections([]),
  ...(b2b === undefined ? {} : { b2b }),
})

const EMPTY: B2bDeckData = {
  inquiries: [],
  quotes_pending: [],
  samples: [],
  dormant: [],
  outreach_today: [],
  sequence_funnel: [],
  replies: [],
  lists: [],
  shows: [],
  deadlines: [],
  show_leads: [],
  followups: [],
  in_production: [],
  to_ship: [],
  docs_to_check: [],
  balance_due: [],
  marketplace_inquiries: [],
  listings_to_improve: [],
  rfqs: [],
}

describe('B2B 面板块与职责 yml 对得上', () => {
  it.each(ROLES)('%s：块 id 与 home_blocks 一一对上，全走 b2b 源', (role) => {
    const yml = ymlBlocks(role)
    expect(yml.length).toBeGreaterThanOrEqual(3)
    const blocks = blocksForRole(role)
    expect(blocks.map((b) => b.id).sort()).toEqual(yml.map((b) => b.id).sort())
    expect(new Set(blocks.map((b) => b.source))).toEqual(new Set(['b2b']))
    // yml 里写的查询名就是面板真跑的那一个
    for (const b of yml) expect(blocks.find((x) => x.id === b.id)?.query).toBe(b.query)
  })
})

describe('空态：还没有 ≠ 去连接', () => {
  it.each(ROLES)('%s：没递 b2b 也算得出、源算连上', (role) => {
    const view = assembleView(role, ctx(undefined, role))
    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({ source: 'b2b', label: 'B2B 库', connected: true })
    for (const b of blocksForRole(role)) {
      const data = computeBlock(b.id, ctx(undefined, role), 'today')
      expect(data.status).toBe('ok')
      expect((data.payload as { rows: unknown[] }).rows).toEqual([])
    }
  })
})

describe('状态念成人话', () => {
  it('报价待审：谁批 + 超了哪几条', () => {
    const data = computeBlock(
      'b2b.sales.quotes',
      ctx({
        ...EMPTY,
        quotes_pending: [
          {
            number: 'Q-1',
            account: 'VoltHaus',
            version: 2,
            amount_usd: 18_400,
            margin_pct: 17,
            approver: 'scope_manager',
            breaches: ['quote_amount_over_mandate', 'quote_margin_under_mandate'],
          },
        ],
      }),
      'today',
    )
    expect((data.payload as { rows: unknown[] }).rows).toEqual([
      { account: 'VoltHaus · V2', amount: 18_400, approver: '上级', why: '金额、毛利' },
    ])
  })
  it('样品与名单', () => {
    const c = ctx({
      ...EMPTY,
      samples: [
        {
          account: 'A',
          items: '65W ×3',
          status: 'shipped',
          due: '2026-10-10',
          tracking_no: 'DHL1',
        },
      ],
      lists: [{ name: '展会名录', tier: 'official', count: 120, imported_at: NOW }],
    })
    expect(
      (computeBlock('b2b.sales.samples', c, 'today').payload as { rows: { status: string }[] })
        .rows[0]?.status,
    ).toBe('已寄')
    expect(
      (computeBlock('b2b.outbound.lists', c, 'today').payload as { rows: { tier: string }[] })
        .rows[0]?.tier,
    ).toBe('官方档')
  })
  it('单证：有不符点的排前面', () => {
    const c = ctx({
      ...EMPTY,
      docs_to_check: [
        { po: 'PO-1', doc: '装箱单', status: '已核', discrepancies: 0 },
        { po: 'PO-1', doc: '信用证单据', status: '有不符点', discrepancies: 2 },
      ],
    })
    const rows = (
      computeBlock('b2b.fulfillment.docs', c, 'today').payload as { rows: { doc: string }[] }
    ).rows
    expect(rows[0]?.doc).toBe('PO-1 · 信用证单据')
  })
})
