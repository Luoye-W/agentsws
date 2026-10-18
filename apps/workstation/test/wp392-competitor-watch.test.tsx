/**
 * WP392（docs/104 §3.5）：右侧面板里的竞品监控——报表卡的竞品变化表（按竞品 / 种类筛、价格带走势）、
 * 连接卡的监控源状态（坏了亮红点、照实说是哪家）、计划卡的下次读。只在担店铺管理 / 亚马逊店铺运营的那一层出。
 */
import type { CompetitorChange, CompetitorWatchView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RailScope } from '@/components/rail/rail-scope'
import {
  CompetitorChangesTable,
  CompetitorWatchConnectionRow,
  CompetitorWatchPlanRow,
  competitorAssignmentOf,
  competitorStatusText,
  priceTrend,
} from '@/components/reports/competitor-watch'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

type Row = CompetitorChange & { text: { zh: string; en: string } }
const change = (over: Partial<Row>): Row => ({
  id: 'cc_1',
  workspace_id: 'ws_1' as never,
  kind: 'price',
  competitor_id: 'c_jackery',
  competitor: 'Jackery',
  source_id: 'cw_shop_c_jackery',
  source_kind: 'shop_catalog',
  product_key: '8001',
  title: 'Explorer 1000 v2',
  url: 'https://jackery.example/products/explorer-1000-v2',
  before: 799,
  after: 679,
  pct: -15,
  currency: 'USD',
  detected_at: '2026-10-12T01:00:00.000Z',
  text: { zh: 'Explorer 1000 v2：降价15%（$799 → $679）', en: 'Explorer 1000 v2: price down 15%' },
  ...over,
})

const ROWS = [
  change({
    id: 'cc_2',
    before: 679,
    after: 649,
    pct: -4.4,
    detected_at: '2026-10-13T01:00:00.000Z',
    text: { zh: 'Explorer 1000 v2：降价4.4%（$679 → $649）', en: '' },
  }),
  change({}),
  change({
    id: 'cc_3',
    kind: 'out_of_stock',
    competitor_id: 'c_ecoflow',
    competitor: 'EcoFlow',
    source_id: 'cw_shop_c_ecoflow',
    product_key: '9002',
    title: 'Delta 3',
    before: true,
    after: false,
    detected_at: '2026-10-13T02:00:00.000Z',
    text: { zh: 'Delta 3：断货', en: 'Delta 3: out of stock' },
  }),
]

const view = (over: Partial<CompetitorWatchView['summary']> = {}): CompetitorWatchView => ({
  settings: { enabled: true, day_start_hour: 9, every_hours: 24, new_within_days: 7 },
  sources: [
    {
      id: 'cw_shop_c_jackery',
      workspace_id: 'ws_1' as never,
      kind: 'shop_catalog',
      url: 'https://jackery.example',
      group: 'competitor',
      label: 'Jackery',
      every_hours: 24,
      status: 'ok',
      added_via: 'suggest',
      created_at: '2026-10-10T00:00:00.000Z',
      competitor_id: 'c_jackery',
    },
  ],
  summary: {
    sources: 3,
    competitors: 3,
    ok: 3,
    failed: 0,
    partial: 0,
    unchecked: 0,
    failed_labels: [],
    ...over,
  },
  next_read_at: '2026-10-14T01:00:00.000Z',
  missing_adapters: [],
})

let current = view()
vi.mock('@/lib/competitor-watch-api', async (orig) => {
  const real = await orig<typeof import('@/lib/competitor-watch-api')>()
  return {
    ...real,
    getCompetitorWatch: vi.fn(async () => current),
    getCompetitorChanges: vi.fn(async () => ROWS),
    runCompetitorWatch: vi.fn(async () => ({})),
  }
})

const STORE: RailScope = {
  tier: 'position',
  scope_id: 'pos_web',
  name: '网站运营',
  assignment: 'asg_content',
  roles: [
    { role_id: 'dtc.content', assignment: 'asg_content' },
    { role_id: 'dtc.store', assignment: 'asg_store' },
  ],
}
const SUPPORT: RailScope = {
  tier: 'role',
  scope_id: 'support.email',
  name: '邮件客服',
  roles: [{ role_id: 'support.email', assignment: 'asg_mail' }],
}
const t = (key: string, vars?: Record<string, string | number>) => translate('zh', key, vars)

describe('WP392 竞品监控在右侧面板', () => {
  it('只在担店铺管理 / 亚马逊店铺运营的那一层出，带那条职责的分配', () => {
    expect(competitorAssignmentOf(STORE)).toBe('asg_store')
    expect(competitorAssignmentOf(SUPPORT)).toBeUndefined()
  })

  it('连接卡那一句：几家、几家没读到（照实说是哪家）', () => {
    expect(competitorStatusText(view(), t)).toEqual({ text: '3 家', bad: false })
    expect(competitorStatusText(view({ failed: 1, ok: 2, failed_labels: ['Jackery'] }), t)).toEqual(
      { text: '3 家 · 1 家没读到', bad: true, who: '没读到：Jackery' },
    )
  })

  it('价格走势：同一商品以前的每次改价，按时间排', () => {
    expect(priceTrend(ROWS, ROWS[0] as CompetitorChange)).toEqual([799, 679, 649])
    expect(priceTrend(ROWS, ROWS[2] as CompetitorChange)).toEqual([])
  })

  // WP402（决策 1145）：手写表改成积木表格，筛选走 WP401 那一套（竞品 / 种类勾、日期选起止、说了什么能搜）
  it('竞品变化表：按竞品、按种类筛；价格变化旁边一条走势线', { timeout: 120_000 }, async () => {
    // Node 25 自带那个全局 localStorage 是残的：换一份内存的（筛法记在本机）
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v)
      },
      removeItem: (k: string) => {
        mem.delete(k)
      },
    })
    current = view()
    renderWithProviders(<CompetitorChangesTable scope={STORE} />)
    const rows = () => within(screen.getByTestId('competitor-table')).getAllByRole('row').length - 1
    await waitFor(() => expect(rows()).toBe(3))
    expect(screen.getAllByTestId('table-sparkline').length).toBeGreaterThan(0)
    expect(screen.getByText('Explorer 1000 v2：降价15%（$799 → $679）')).toBeTruthy()
    const pick = async (col: string, value: string) => {
      fireEvent.click(screen.getByTestId(`table-filter-${col}`))
      const panel = await screen.findByTestId(`table-filter-panel-${col}`)
      const opt = within(panel)
        .getAllByTestId(`table-filter-opt-${col}`)
        .find((b) => b.getAttribute('data-value') === value)
      if (opt === undefined) throw new Error(`没有 ${value}`)
      fireEvent.click(opt)
    }
    await pick('competitor', 'EcoFlow')
    expect(rows()).toBe(1)
    fireEvent.click(screen.getByTestId('table-filtered-clear'))
    await pick('change', '改价')
    expect(rows()).toBe(2)
    vi.unstubAllGlobals()
  })

  it('连接卡一行：有没读到的亮红、写出是哪家；计划卡：下次读的时刻', async () => {
    current = view({ failed: 1, ok: 2, failed_labels: ['Jackery'] })
    renderWithProviders(
      <ul>
        <CompetitorWatchConnectionRow scope={STORE} />
        <CompetitorWatchPlanRow scope={STORE} />
      </ul>,
    )
    const row = await screen.findByTestId('competitor-watch-row')
    expect(row.getAttribute('data-bad')).toBe('true')
    expect(row.textContent).toContain('3 家 · 1 家没读到')
    expect(row.getAttribute('title')).toBe('没读到：Jackery')
    expect((await screen.findByTestId('competitor-watch-plan')).textContent).toContain('竞品监控')
  })

  it('不担竞品监控的那一层什么都不出', () => {
    renderWithProviders(<CompetitorChangesTable scope={SUPPORT} />)
    expect(screen.queryByTestId('competitor-changes')).toBeNull()
  })
})
