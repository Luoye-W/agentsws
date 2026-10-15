/**
 * WP335（docs/99 §5.4 / §5.6）：「内容与搜索」职责页的 AI 回答监测看板。
 *
 * 钉：数字 ×4 照服务端给的画（不自己算）；没数据一行字、不出 0；点不够不画趋势；没竞品不画对比；
 * 方格四态 + 点一格在第三栏开「一条回答」；Claude 那一列带问号；「现在跑一轮」先说多少积分、确认了再跑；
 * 页面少字；不出批发商名。
 */
import type { GeoMetricsView, GeoWatchView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const W = '2026-10-05'
const point = (week: string, rate: number, extra: Record<string, number> = {}) => ({
  week,
  planned: 8,
  ok: 8,
  mentioned: Math.round(rate * 8),
  cited: 1,
  mention_rate: rate,
  citation_rate: 0.125,
  avg_rank: 1.5,
  sov: 0.4,
  coverage: 1,
  ...extra,
})

const full: GeoMetricsView = {
  week: W,
  trends: [
    {
      kind: 'all',
      key: 'all',
      points: [
        point('2026-09-21', 0.25),
        point('2026-09-28', 0.33),
        point(W, 0.38, { change_pp: 5 }),
      ],
    },
    { kind: 'platform', key: 'chatgpt', points: [point('2026-09-21', 0.5), point(W, 0.5)] },
    { kind: 'platform', key: 'claude', points: [point('2026-09-28', 0.25), point(W, 0.25)] },
  ],
  brands: [
    { entity: 'ours', name: 'NordVolt', mentioned: 3, sov: 0.4 },
    { entity: 'c1', name: 'Anker', mentioned: 5, sov: 0.6 },
  ],
  sentiment: { positive: 2, neutral: 1, negative: 0, by: 'ai' },
  top_domains: [
    {
      domain: 'reddit.com',
      site_kind: 'forum',
      group: 'offsite',
      citations: 4,
      prompts: 2,
      platforms: ['chatgpt', 'claude'],
      previous: 0,
      new: true,
    },
  ],
  top_pages: [
    {
      domain: 'reddit.com',
      url_norm: 'https://reddit.com/r/x/1',
      url: 'https://www.reddit.com/r/x/1',
      title: 'Best power bank?',
      site_kind: 'forum',
      group: 'offsite',
      citations: 3,
      prompts: 1,
      platforms: ['chatgpt'],
      previous: 0,
      new: true,
    },
  ],
  our_pages: [],
  competitor_pages: [],
  changes: [],
  rank: {
    week: W,
    rows: [
      {
        keyword: 'travel power bank',
        market: 'US',
        device: 'mobile',
        rank: 8,
        previous: 11,
        change: 3,
        features: { ai_overview: true, people_also_ask: true, shopping: false, video: false },
        aio_mentions_us: true,
        aio_cites_us: false,
        gsc_position: 9.2,
      },
    ],
    avg_rank: 8,
    in_top20: 1,
    out_of_20: 0,
    entered_top10: 1,
    left_top10: 0,
  },
  brand_gsc: { connected: false, weeks: [] },
  notes: [],
  grid: {
    week: W,
    platforms: ['chatgpt', 'claude'],
    markets: ['US'],
    rows: [
      {
        prompt_id: 'p1',
        prompt_text: 'Best power bank for flights?',
        cells: [
          {
            platform: 'chatgpt',
            market: 'US',
            state: 'mentioned',
            rank: 2,
            cited: true,
            answer_id: 'a1',
            change: 'up',
          },
          { platform: 'claude', market: 'US', state: 'failed', cited: false, answer_id: 'a2' },
        ],
        change: 'up',
      },
      {
        prompt_id: 'p2',
        prompt_text: 'Is NordVolt good?',
        branded: true,
        cells: [
          { platform: 'chatgpt', market: 'US', state: 'absent', cited: false, answer_id: 'a3' },
          { platform: 'claude', market: 'US', state: 'mentioned', cited: false, answer_id: 'a4' },
        ],
      },
    ],
  },
}

const watchView = {
  search_data: 'configured',
  estimate: {
    route: 'official',
    prompts: 5,
    markets: 1,
    platforms: [],
    credits: 20,
    needs_confirm: true,
  },
} as unknown as GeoWatchView

let metrics: GeoMetricsView = full
const getGeoMetrics = vi.fn(async () => metrics)
const getGeoWatch = vi.fn(async () => watchView)
const runGeoWatch = vi.fn(async (input: { confirm?: boolean }) =>
  input.confirm === true
    ? { started: true, estimate: watchView.estimate, runs: [], pending_tasks: 0, notes: [] }
    : {
        started: false,
        needs_confirm: true,
        estimate: { ...watchView.estimate, credits: 20.4 },
        runs: [],
        pending_tasks: 0,
        notes: [],
      },
)
const opened: string[] = []
const shown: string[] = []

vi.mock('@/lib/geo-watch-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/geo-watch-api')>('@/lib/geo-watch-api')
  return {
    ...actual,
    getGeoMetrics: () => getGeoMetrics(),
    getGeoWatch: () => getGeoWatch(),
    runGeoWatch: (input: { confirm?: boolean }) => runGeoWatch(input),
  }
})
vi.mock('@/components/rail/rail-state', async () => {
  const actual = await vi.importActual<typeof import('@/components/rail/rail-state')>(
    '@/components/rail/rail-state',
  )
  return {
    ...actual,
    useRailState: () => ({
      ...actual.useRailState(),
      openAddress: (a: string) => {
        opened.push(a)
        return true
      },
      show: (p: string | null) => {
        if (p !== null) shown.push(p)
      },
    }),
  }
})

const { GeoBoard } = await import('@/components/seo/geo-board')

describe('WP335 AI 回答监测看板', () => {
  it('数字 ×4 照服务端给的画；提及率带周变化；趋势 ≥ 3 周才画；表格、站、对比都在', async () => {
    metrics = full
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    const mention = await screen.findByTestId('geo-tile-mention')
    expect(mention.textContent).toContain('38%')
    expect(mention.textContent).toContain('5 个百分点')
    expect(screen.getByTestId('geo-tile-citation').textContent).toContain('13%')
    expect(screen.getByTestId('geo-tile-rank').textContent).toContain('第 1.5')
    expect(screen.getByTestId('geo-tile-sov').textContent).toContain('40%')
    expect(screen.getByTestId('geo-trend').dataset.lines).toBe('2')
    expect(screen.getAllByTestId('geo-rank-row')).toHaveLength(1)
    expect(screen.getByTestId('geo-rank-aio-us')).toBeDefined()
    expect(screen.getByTestId('geo-sites').textContent).toContain('新')
    expect(screen.getAllByTestId('geo-compare-row').map((r) => r.dataset.entity)).toEqual([
      'ours',
      'c1',
    ])
    expect(document.body.textContent ?? '').not.toMatch(/DataForSEO/i)
  })

  it('方格四态；Claude 一列带问号；点一格在第三栏开那条回答', async () => {
    metrics = full
    opened.length = 0
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    const cells = await screen.findAllByTestId('geo-cell')
    expect(cells.map((c) => c.dataset.state)).toEqual([
      'mentioned',
      'failed',
      'absent',
      'mentioned',
    ])
    expect(screen.getAllByTestId('geo-cell-cited')).toHaveLength(1)
    expect(screen.getByTestId('geo-claude-hint').getAttribute('aria-label')).toContain(
      'Claude 联网',
    )
    expect(screen.getAllByTestId('geo-change').length).toBeGreaterThan(0)
    fireEvent.click(cells[0] as HTMLElement)
    expect(opened).toEqual(['agentsws://geo-answer/asg_content/a1'])
    fireEvent.click(screen.getByTestId('geo-open-settings'))
    expect(shown).toContain('geo-watch')
  })

  it('点不够不画趋势；没竞品不画对比；没历史一行字（不出 0）', async () => {
    metrics = {
      ...full,
      trends: [{ kind: 'all', key: 'all', points: [point(W, 0.5)] }],
      brands: [{ entity: 'ours', name: 'NordVolt', mentioned: 4, sov: 1 }],
    }
    const { unmount } = renderWithProviders(<GeoBoard assignment="asg_content" />)
    await screen.findByTestId('geo-tiles')
    expect(screen.queryByTestId('geo-trend')).toBeNull()
    expect(screen.queryByTestId('geo-compare')).toBeNull()
    unmount()
    metrics = {
      ...full,
      trends: [],
      brands: [],
      top_domains: [],
      rank: { rows: [], in_top20: 0, out_of_20: 0, entered_top10: 0, left_top10: 0 },
      notes: [],
    }
    delete (metrics as { grid?: unknown }).grid
    delete (metrics as { week?: unknown }).week
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    expect((await screen.findByTestId('geo-empty')).textContent).toContain('还没跑过')
    expect(screen.queryByTestId('geo-tiles')).toBeNull()
  })

  it('现在跑一轮：有 Claude 先说这一轮多少积分，确认了才带 confirm 跑', async () => {
    metrics = full
    runGeoWatch.mockClear()
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    fireEvent.click(await screen.findByTestId('geo-run'))
    const ask = await screen.findByTestId('geo-run-confirm')
    expect(ask.textContent).toContain('20.4')
    fireEvent.click(screen.getByText('跑'))
    await waitFor(() => expect(runGeoWatch).toHaveBeenLastCalledWith({ confirm: true }))
    expect(await screen.findByTestId('geo-run-done')).toBeDefined()
  })

  it('减字守卫：看板上可见说明不超上限', async () => {
    metrics = full
    const { reportCard, CARD_TEXT_LIMIT } = await import('./less-text-guard')
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    await screen.findByTestId('geo-tiles')
    const report = reportCard(screen.getByTestId('geo-board'))
    expect(report.weight, report.text).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  })
})
