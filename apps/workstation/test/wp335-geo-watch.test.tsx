/**
 * WP335（docs/99 §5.1 / §5.4）：「设定 → 关注设置」与 `geo_watch` 设定卡的「改」。
 *
 * 钉：花多少写在明处（Claude 那一格写每月多少，数是服务端的）；每样改了立刻按单样存；
 * 「关注设置」标签只在「内容与搜索」职责层出；设定卡「改」后带着改过的策略批（approve + edited_payload）。
 */
import type { GeoWatchCardPayload, GeoWatchView } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const q = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  origin: 'ai_suggest' as const,
  enabled: true,
  topic: 'category' as const,
  branded: false,
  ...extra,
})

const view: GeoWatchView = {
  watch: {
    brand: { name: 'NordVolt', aliases: ['NV'], domains: ['nordvolt.example'] },
    competitors: [{ id: 'c_anker', name: 'Anker', aliases: [], domains: ['anker.com'] }],
    prompt_candidates: [q('p3', 'Cheapest power bank?', { topic: 'price_value' })],
    prompts: [
      q('p1', 'Best power bank for flights?', { selected: true }),
      q('p2', 'Is NordVolt good?', { selected: true, branded: true, topic: 'branded' }),
    ],
    prompt_limit: 5,
    prompt_cap: 20,
    keywords: [{ keyword: 'travel power bank', branded: false, enabled: true }],
    markets: ['US'],
    platforms: ['chatgpt', 'gemini', 'claude', 'google_ai_overview'],
    frequency: 'weekly',
    rank_device: 'mobile',
    enabled: true,
    updated_at: '2026-10-05T00:00:00Z',
  },
  estimate: {
    route: 'official',
    prompts: 2,
    markets: 1,
    platforms: [],
    credits: 9.2,
    credits_per_month: 39.8,
    claude_credits_per_month: 31.2,
    needs_confirm: true,
  },
  setup: 'needed',
  last_runs: [],
  pending_tasks: 0,
  search_data: 'configured',
  gsc_connected: false,
  notes: [],
}

const setGeoWatch = vi.fn(async (_patch: unknown) => view)
const suggestGeoWatch = vi.fn(async () => ({
  strategy: {},
  estimate: {},
  approval_item_id: 'ap_1',
}))
const decide = vi.fn(async (..._args: unknown[]) => ({}))

vi.mock('@/lib/geo-watch-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/geo-watch-api')>('@/lib/geo-watch-api')
  return {
    ...actual,
    getGeoWatch: async () => view,
    setGeoWatch: (patch: unknown) => setGeoWatch(patch),
    suggestGeoWatch: () => suggestGeoWatch(),
  }
})
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (...args: unknown[]) => decide(...args) }
})

const { GeoWatchSettings } = await import('@/components/seo/geo-watch-settings')
const { GeoWatchCardBody, editedStrategy } = await import('@/components/seo/geo-watch-card-body')
const { tabsOf } = await import('@/components/rail/panels/settings-panel')

describe('WP335 关注设置', () => {
  it('花多少写在明处：这一轮 / 每月、Claude 一个月多少（服务端的数）', async () => {
    renderWithProviders(<GeoWatchSettings assignment="asg_content" />)
    expect((await screen.findByTestId('geo-watch-cost')).textContent).toContain('9.2')
    expect(screen.getByTestId('geo-watch-cost').textContent).toContain('39.8')
    expect(screen.getByTestId('geo-watch-claude-cost').textContent).toContain('31.2')
    expect(screen.getByTestId('geo-watch-setup').textContent).toBe('还没定')
    expect(document.body.textContent ?? '').not.toMatch(/DataForSEO/i)
  })

  it('每样改了立刻按单样存：关掉 Claude、不追某条、加竞品、加关注词', async () => {
    setGeoWatch.mockClear()
    renderWithProviders(<GeoWatchSettings assignment="asg_content" />)
    fireEvent.click(await screen.findByTestId('geo-watch-platform-claude'))
    await waitFor(() =>
      expect(setGeoWatch).toHaveBeenLastCalledWith({
        platforms: ['chatgpt', 'gemini', 'google_ai_overview'],
      }),
    )
    const first = screen
      .getAllByTestId('geo-watch-prompt')[0]
      ?.querySelector('input[type=checkbox]')
    fireEvent.click(first as Element)
    await waitFor(() => expect(setGeoWatch).toHaveBeenLastCalledWith({ select: ['p2'] }))
    fireEvent.change(screen.getByTestId('geo-watch-rival-name'), { target: { value: 'Belkin' } })
    fireEvent.click(screen.getByTestId('geo-watch-add-rival'))
    await waitFor(() =>
      expect(setGeoWatch).toHaveBeenLastCalledWith({
        competitors: [
          view.watch.competitors[0],
          { id: 'c_belkin', name: 'Belkin', aliases: [], domains: [] },
        ],
      }),
    )
    fireEvent.change(screen.getByTestId('geo-watch-add-keyword'), {
      target: { value: 'nordvolt review' },
    })
    fireEvent.keyDown(screen.getByTestId('geo-watch-add-keyword'), { key: 'Enter' })
    await waitFor(() =>
      expect(setGeoWatch).toHaveBeenLastCalledWith({
        keywords: [
          ...view.watch.keywords,
          { keyword: 'nordvolt review', branded: true, enabled: true },
        ],
      }),
    )
  })

  it('让 AI 重新建议 = 出一张设定卡（决定在卡片流）', async () => {
    renderWithProviders(<GeoWatchSettings assignment="asg_content" />)
    fireEvent.click(await screen.findByTestId('geo-watch-suggest'))
    await waitFor(() => expect(suggestGeoWatch).toHaveBeenCalled())
  })

  it('「关注设置」标签只在「SEO 与 GEO」职责层出（WP446 从内容那条搬过来）', () => {
    expect(tabsOf({ tier: 'role', scope_id: 'dtc.seo', name: 'SEO 与 GEO' })).toContain('geo-watch')
    expect(tabsOf({ tier: 'role', scope_id: 'dtc.content', name: '内容与博客' })).not.toContain(
      'geo-watch',
    )
    expect(tabsOf({ tier: 'role', scope_id: 'dtc.support', name: '客服' })).not.toContain(
      'geo-watch',
    )
    expect(tabsOf({ tier: 'position', scope_id: 'web-ops', name: '网站运营' })).not.toContain(
      'geo-watch',
    )
  })
})

const strategy = {
  by: 'ai' as const,
  category: 'power bank',
  prompt_limit: 5,
  branded: 1,
  topic_mix: [],
  prompts: view.watch.prompts,
  candidates: view.watch.prompt_candidates,
  competitors: view.watch.competitors,
  keywords: [],
  platforms: view.watch.platforms,
  why: [],
  created_at: '2026-10-05T00:00:00Z',
}
const payload: GeoWatchCardPayload = {
  form: 'geo_watch_setup',
  strategy,
  estimate: view.estimate,
  first: true,
}
const card = {
  id: 'ap_1',
  version: 3,
  position_id: 'asg_content',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
} as unknown as DeckCard

describe('WP335 设定卡「改」', () => {
  it('改过的那几样 → 新策略：已选 = 勾着的，带品牌名几条、各方向几条重算', () => {
    const s = editedStrategy(strategy, {
      limit: 5,
      picked: ['p1', 'p3'],
      platforms: ['chatgpt'],
      competitors: [],
    })
    expect(s.prompts.map((p) => [p.id, p.selected])).toEqual([
      ['p1', true],
      ['p3', true],
    ])
    expect(s.candidates.map((p) => p.id)).toEqual(['p2'])
    expect(s.branded).toBe(0)
    expect(s.topic_mix).toEqual([
      { topic: 'category', count: 1 },
      { topic: 'price_value', count: 1 },
    ])
    expect(s.platforms).toEqual(['chatgpt'])
  })

  it('卡上一眼几行；改了再批 = approve 带改过的整份 payload', async () => {
    decide.mockClear()
    renderWithProviders(<GeoWatchCardBody card={card} payload={payload} />)
    expect(screen.getByTestId('deck-geo-watch-setup').textContent).toContain(
      '追 5 条（带品牌名 1 条）',
    )
    expect(screen.getByTestId('deck-geo-watch-cost').textContent).toContain('31.2')
    fireEvent.click(screen.getByTestId('deck-geo-watch-edit'))
    fireEvent.click(screen.getByTestId('deck-geo-watch-platform-claude'))
    fireEvent.click(screen.getByTestId('deck-geo-watch-save'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    const [id, body] = decide.mock.calls[0] as [
      string,
      { action: string; edited_payload: GeoWatchCardPayload },
    ]
    expect(id).toBe('ap_1')
    expect(body.action).toBe('approve')
    const edited = body.edited_payload as Extract<GeoWatchCardPayload, { form: 'geo_watch_setup' }>
    expect(edited.form).toBe('geo_watch_setup')
    expect(edited.strategy.platforms).not.toContain('claude')
  })
})
