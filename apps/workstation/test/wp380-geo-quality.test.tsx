/**
 * WP380（决策 1066）：看板「说得对不对 · 比得过谁」那一块与两种新卡面。
 *
 * 钉：两个数照服务端给的画（带 n 与「AI 判断」）；两条线是 genui 图表、不到 2 周不画；逐项 / 说错的几句 /
 * 和谁比 / 官方事实 / 对外说法 / 复查各有出现条件；还没判过一行字、不出 0；「现在对一次」调接口；
 * 分派卡按岗位分组、勾掉的不派（approve 带改过的分组）；复查卡写前 → 后与建议。不出批发商名。
 */

import type { GeoMetricsView, GeoWatchCardPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const W = '2026-10-12'
const pt = (week: string, extra: Record<string, number> = {}) => ({
  week,
  planned: 8,
  ok: 8,
  mentioned: 4,
  cited: 1,
  mention_rate: 0.5,
  coverage: 1,
  ...extra,
})

const quality = {
  week: W,
  fields: [
    { field: 'price' as const, correct: 1, wrong: 0, outdated: 1 },
    { field: 'markets' as const, correct: 0, wrong: 1, outdated: 0 },
  ],
  bad_claims: [
    {
      answer_id: 'a2',
      week: W,
      platform: 'gemini' as const,
      market: 'US',
      prompt_text: 'Best power bank for long flights?',
      field: 'price' as const,
      verdict: 'outdated' as const,
      said: 'about $39',
      quote: 'NordVolt sells for about $39.',
      official: '$45–$69',
    },
  ],
  rivals: [{ name: 'Anker', wins: 1, losses: 0, ties: 1 }],
  facts: [
    { key: 'price' as const, value: '$45–$69', as_of: '2026-10-01', source: 'profile' as const },
  ],
  rechecks: [
    {
      id: 'r1',
      created_at: '2026-10-05T00:00:00Z',
      source: 'alert' as const,
      change: '改了长途飞行那页的标题',
      metric: 'mention_rate' as const,
      prompt_ids: ['p1'],
      due: '2026-10-19',
      before: { value: 0.25, n: 4 },
      status: 'waiting' as const,
    },
  ],
  by: 'ai' as const,
}

const base: GeoMetricsView = {
  week: W,
  trends: [
    {
      kind: 'all',
      key: 'all',
      points: [
        pt('2026-10-05', { win_rate: 0.4, compared: 5, accuracy: 0.6, claims: 5 }),
        pt(W, { win_rate: 0.5, compared: 2, accuracy: 0.5, claims: 6 }),
      ],
    },
  ],
  brands: [],
  sentiment: { positive: 0, neutral: 0, negative: 0, by: 'ai' },
  top_domains: [],
  top_pages: [],
  our_pages: [],
  competitor_pages: [],
  changes: [],
  rank: { rows: [], in_top20: 0, out_of_20: 0, entered_top10: 0, left_top10: 0 },
  brand_gsc: { connected: false, weeks: [] },
  notes: [],
  grid: { week: W, platforms: ['chatgpt'], markets: ['US'], rows: [] },
  quality,
}

let metrics: GeoMetricsView = base
const runGeoConsistency = vi.fn(async () => ({ id: 'g1', at: W, pages: [], findings: [] }))
const decide = vi.fn(async (..._args: unknown[]) => ({}))

vi.mock('@/lib/geo-watch-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/geo-watch-api')>('@/lib/geo-watch-api')
  return {
    ...actual,
    getGeoMetrics: async () => metrics,
    getGeoWatch: async () => ({ search_data: 'configured', estimate: {} }),
    runGeoConsistency: () => runGeoConsistency(),
  }
})
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (...args: unknown[]) => decide(...args) }
})

const { GeoBoard } = await import('@/components/seo/geo-board')
const { qualityChartSpec } = await import('@/components/seo/geo-quality')
const { GeoWatchCardBody, isGeoWatchPayload } = await import('@/components/seo/geo-watch-card-body')

describe('WP380 看板：说得对不对 · 比得过谁', () => {
  it('两个数照给的画（n + AI 判断）；逐项、说错的几句、和谁比、官方事实、复查都在', async () => {
    metrics = base
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    const win = await screen.findByTestId('geo-tile-win')
    expect(win.textContent).toContain('50%')
    expect(win.textContent).toContain('n=2')
    expect(screen.getByTestId('geo-tile-acc').textContent).toContain('n=6')
    expect(screen.getByTestId('geo-q-chart')).toBeTruthy()
    expect(screen.getAllByTestId('geo-q-field').map((x) => x.dataset.field)).toEqual([
      'price',
      'markets',
    ])
    expect(screen.getByTestId('geo-q-bad').textContent).toContain('$45–$69')
    expect(screen.getByTestId('geo-q-rivals').textContent).toContain('Anker')
    expect(screen.getByTestId('geo-q-facts').textContent).toContain('10-01')
    expect(screen.getByTestId('geo-q-recheck').textContent).toContain('10-19')
    expect(document.body.textContent).not.toMatch(/DataForSEO/i)
  })

  it('还没判过：一行字，不出 0；「现在对一次」调接口', async () => {
    metrics = {
      ...base,
      trends: [{ kind: 'all', key: 'all', points: [pt(W)] }],
      quality: { ...quality, fields: [], bad_claims: [], rivals: [], rechecks: [] },
    }
    renderWithProviders(<GeoBoard assignment="asg_content" />)
    expect(await screen.findByTestId('geo-q-empty')).toBeTruthy()
    expect(screen.queryByTestId('geo-tile-win')).toBeNull()
    expect(screen.queryByTestId('geo-q-rechecks')).toBeNull()
    fireEvent.click(screen.getByTestId('geo-q-consistency-run'))
    await waitFor(() => expect(runGeoConsistency).toHaveBeenCalled())
  })

  it('genui 图表：每条线 ≥ 2 周才画，数是百分数', () => {
    const spec = qualityChartSpec(base.trends[0]?.points ?? [], { win: '胜率', acc: '准确度' })
    expect(spec?.items[0]).toMatchObject({
      type: 'chart',
      kind: 'line',
      series: [
        {
          label: '胜率',
          data: [
            { label: '10-05', value: 40 },
            { label: '10-12', value: 50 },
          ],
        },
        {
          label: '准确度',
          data: [
            { label: '10-05', value: 60 },
            { label: '10-12', value: 50 },
          ],
        },
      ],
    })
    expect(qualityChartSpec([pt(W, { win_rate: 1 })], { win: 'a', acc: 'b' })).toBeUndefined()
  })
})

const card = {
  id: 'ap_9',
  version: 1,
  position_id: 'asg_content',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
} as unknown as DeckCard
const finding = (id: string, owner: 'site' | 'web-ops' | 'pr', field: 'price' | 'markets') => ({
  id,
  url: `https://example.test/${id}`,
  surface: 'review' as const,
  field,
  verdict: 'wrong' as const,
  said: 'UK only',
  official: 'US, DE',
  official_as_of: '2026-10-01',
  owner,
  by: 'ai' as const,
})

describe('WP380 卡面', () => {
  it('对外说法分派卡：按岗位分组；勾掉一处 → 带着改过的分组批', async () => {
    decide.mockClear()
    const payload: GeoWatchCardPayload = {
      form: 'geo_consistency',
      run_id: 'g1',
      batch_id: 'batch_g1',
      recheck_on: '2026-11-09',
      groups: [
        { owner: 'site', findings: [finding('f1', 'site', 'price')] },
        { owner: 'pr', findings: [finding('f2', 'pr', 'markets'), finding('f3', 'pr', 'price')] },
      ],
    }
    expect(isGeoWatchPayload(payload)).toBe(true)
    renderWithProviders(<GeoWatchCardBody card={card} payload={payload} />)
    expect(screen.getAllByTestId('deck-geo-consistency-group')).toHaveLength(2)
    expect(screen.getByTestId('deck-geo-consistency').textContent).toContain('11-09')
    fireEvent.click(screen.getAllByRole('checkbox')[2] as HTMLElement)
    fireEvent.click(screen.getByTestId('deck-geo-consistency-save'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    const body = decide.mock.calls[0]?.[1] as { edited_payload: typeof payload }
    expect(body.edited_payload.groups.map((g) => g.findings.map((f) => f.id))).toEqual([
      ['f1'],
      ['f2'],
    ])
  })

  it('复查卡：前 → 后带 n，写建议与为什么', () => {
    const payload: GeoWatchCardPayload = {
      form: 'geo_recheck',
      recheck: {
        ...quality.rechecks[0],
        status: 'done',
        after: { value: 0.75, n: 4 },
        delta_pp: 50,
        advice: 'expand',
        why: '明显变好',
      } as Extract<GeoWatchCardPayload, { form: 'geo_recheck' }>['recheck'],
    }
    renderWithProviders(<GeoWatchCardBody card={card} payload={payload} />)
    expect(screen.getByTestId('deck-geo-recheck-advice').textContent).toBe('扩大')
    expect(screen.getByTestId('deck-geo-recheck').textContent).toContain('25%（n=4）')
    expect(screen.getByTestId('deck-geo-recheck').textContent).toContain('75%（n=4）')
  })
})
