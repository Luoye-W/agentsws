/**
 * WP394（docs/104 一期 B）：Amazon 运营面板的「竞品动向」块——盯几家几款、下次读、没读到亮红点照实说；
 * 最近的 Amazon 对标款变化（带「比你的 X 便宜 $N」）；还没盯就是 WP395 那一行灰字；不提数据供应商名。
 */
import type {
  CompetitorChange,
  CompetitorWatchSource,
  CompetitorWatchView,
} from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AmazonOpsBoard } from '@/components/amazon/amazon-ops-board'
import '@/components/amazon/amazon-competitors'
import { runCompetitorWatch } from '@/lib/competitor-watch-api'
import { renderWithProviders } from './helpers'

type Row = CompetitorChange & { text: { zh: string; en: string } }
const change = (over: Partial<Row>): Row => ({
  id: 'cc_1',
  workspace_id: 'ws_1' as never,
  kind: 'price',
  competitor_id: 'c_rival',
  competitor: 'Rival Gear',
  source_id: 'cw_amz_c_rival_US',
  source_kind: 'amazon_asin',
  product_key: 'B0TESTRG01',
  title: 'Trail 500',
  url: 'https://www.amazon.com/dp/B0TESTRG01',
  before: 1299,
  after: 1149,
  pct: -11.5,
  currency: 'USD',
  detected_at: '2026-10-20T01:30:00.000Z',
  vs_own: {
    own_key: 'B0OWNMINE1',
    own_title: 'Ranger',
    own_price: 1399,
    diff: -250,
    currency: 'USD',
  },
  text: {
    zh: 'Trail 500：降价11.5%（$1,299 → $1,149），比你的 Ranger 便宜 $250',
    en: 'Trail 500: price down 11.5%; $250 cheaper than your Ranger',
  },
  ...over,
})

const src = (over: Partial<CompetitorWatchSource>): CompetitorWatchSource =>
  ({
    id: 'cw_amz_c_rival_US',
    workspace_id: 'ws_1' as never,
    kind: 'amazon_asin',
    url: 'https://www.amazon.com',
    group: 'competitor',
    label: 'Rival Gear',
    competitor_id: 'c_rival',
    marketplace: 'US',
    asins: ['B0TESTRG01', 'B0TESTRG02', 'B0TESTRG03'],
    every_hours: 24,
    added_via: 'suggest',
    status: 'ok',
    created_at: '2026-10-19T01:30:00.000Z',
    ...over,
  }) as CompetitorWatchSource

const view = (sources: CompetitorWatchSource[]): CompetitorWatchView =>
  ({
    settings: { enabled: true, day_start_hour: 9, every_hours: 24, new_within_days: 7 },
    sources,
    summary: {
      sources: sources.length,
      competitors: 1,
      ok: 1,
      failed: sources.filter((s) => s.status === 'failed').length,
      partial: 0,
      unchecked: 0,
      failed_labels: [],
    },
    next_read_at: '2026-10-21T01:00:00.000Z',
    missing_adapters: [],
  }) as CompetitorWatchView

let current: CompetitorWatchView | null = null
vi.mock('@/lib/competitor-watch-api', async (orig) => {
  const real = await orig<typeof import('@/lib/competitor-watch-api')>()
  return {
    ...real,
    getCompetitorWatch: vi.fn(async () => current),
    getCompetitorChanges: vi.fn(async () => [
      change({}),
      change({ id: 'cc_own', competitor_id: '_own', competitor: 'Nordvik' }),
      change({ id: 'cc_shop', source_kind: 'shop_catalog', competitor: 'Shop Rival' }),
    ]),
    runCompetitorWatch: vi.fn(async () => ({})),
  }
})

describe('WP394 · 竞品动向块', () => {
  it('还没盯：WP395 那一行灰字', async () => {
    current = null
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect((await screen.findByTestId('amzops-empty-competitors')).textContent).toBe(
      '还没有在盯的竞品',
    )
  })

  it('盯着：几家几款、下次读；变化不在块里重复（WP420 B7：只在竞品变化表里列），块里一句「最近 N 条」只数 Amazon 竞品', async () => {
    current = view([
      src({}),
      src({
        id: 'cw_amz__own_US',
        group: 'own',
        competitor_id: '_own',
        label: 'Nordvik',
        asins: ['B0OWNMINE1'],
      }),
    ])
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect((await screen.findByTestId('amzcw-summary')).textContent).toContain('盯 1 家 · 3 款')
    expect((await screen.findByTestId('amzcw-see-table')).textContent).toContain('最近 1 条')
    expect(screen.queryAllByTestId('amzcw-change')).toHaveLength(0)
    expect(screen.getByTestId('amzcw-block').textContent).not.toMatch(/apify|keepa/i)
    fireEvent.click(screen.getByTestId('amzcw-run'))
    await waitFor(() => {
      expect(runCompetitorWatch).toHaveBeenCalledWith('asg_amz')
    })
  })

  it('有一家没读到：红点 + 照实写是哪家', async () => {
    current = view([src({ status: 'failed', last_error: 'x' })])
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect((await screen.findByTestId('amzcw-failed')).textContent).toContain('Rival Gear')
  })
})
