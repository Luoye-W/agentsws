/**
 * WP398（docs/106 §13 A8）：Amazon 词库在工作台上的几样——岗位页「词库」块、体检卡那一行、第三栏词表。
 */
import type {
  AmazonKeywordBankView,
  AmazonKeywordPage,
  AmazonKeywordRow,
} from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const at = '2026-10-18T09:00:00.000Z'
const VIEW: AmazonKeywordBankView = {
  total: 42,
  gap_terms: 7,
  other_brand_terms: 1,
  by_source: { autocomplete: 20, competitor_listing: 25, own_listing: 9 },
  updated_at: at,
  gaps: [
    {
      asin: 'B0OWN00001',
      marketplace: 'US',
      title: 'Nordvolt Portable Power Station',
      competitors_compared: 3,
      common: 2,
      computed_at: at,
      terms: [
        {
          id: 'US:solar generator',
          term: 'solar generator',
          norm: 'solar generator',
          competitors: 3,
          competitor_names: ['A', 'B', 'C'],
          asins: [],
          missing_words: ['solar', 'generator'],
        },
        {
          id: 'US:pure sine wave',
          term: 'pure sine wave',
          norm: 'pure sine wave',
          competitors: 2,
          competitor_names: ['A', 'B'],
          asins: [],
          missing_words: ['pure', 'sine', 'wave'],
        },
        {
          id: 'US:camping',
          term: 'camping',
          norm: 'camping',
          competitors: 1,
          competitor_names: ['A'],
          asins: [],
          missing_words: ['camping'],
        },
      ],
    },
  ],
  listings: { own: 1, competitor: 6 },
  reader_ready: true,
  sort_note: { zh: '没有搜索量，按竞品里出现的次数排', en: 'No search volume yet' },
}

const row = (over: Partial<AmazonKeywordRow>): AmazonKeywordRow => ({
  id: 'US:x',
  term: 'x',
  norm: 'x',
  marketplace: 'US',
  language: 'en',
  sources: ['autocomplete'],
  seen: [],
  first_seen_at: at,
  last_seen_at: at,
  marks: [],
  competitors: 0,
  in_own_text: false,
  gap: false,
  ...over,
})

const listed: unknown[] = []
const marked: unknown[] = []
let empty = false
vi.mock('@/lib/amazon-keywords-api', async () => ({
  ...(await vi.importActual<object>('@/lib/amazon-keywords-api')),
  getAmazonKeywords: vi.fn(async () =>
    empty ? { ...VIEW, total: 0, gap_terms: 0, gaps: [], updated_at: undefined } : VIEW,
  ),
  refreshAmazonKeywords: vi.fn(async () => ({ refresh: {}, view: VIEW })),
  listAmazonKeywords: vi.fn(async (q: unknown): Promise<AmazonKeywordPage> => {
    listed.push(q)
    return {
      total: 2,
      sort_note: VIEW.sort_note,
      items: [
        row({
          id: 'US:solar generator',
          term: 'solar generator',
          sources: ['competitor_listing'],
          competitors: 3,
          gap: true,
        }),
        row({
          id: 'US:jackery power station',
          term: 'jackery power station',
          other_brand: 'Jackery',
          competitors: 0,
          in_own_text: false,
        }),
      ],
    }
  }),
  markAmazonKeyword: vi.fn(async (p: unknown) => {
    marked.push(p)
    return {}
  }),
}))

const { KeywordBankBlock } = await import('@/components/amazon/keyword-bank-block')
const { KeywordGapLine } = await import('@/components/amazon/keyword-gap-line')
const { AmazonKeywordsPanel } = await import('@/components/rail/panels/amazon-keywords-panel')

describe('WP398 岗位页「词库」块', () => {
  it('多少个词、几个差距词、更新时间；每个自家 ASIN 一行差距，点开看清单与「没有搜索量」那句', async () => {
    renderWithProviders(<KeywordBankBlock assignment="asg_amz" />)
    expect((await screen.findByTestId('amzkw-summary')).textContent).toBe('42 个词 · 7 个差距词')
    expect(screen.getByTestId('amzkw-updated').textContent).toMatch(/^更新于 /)
    const line = screen.getByTestId('amzkw-gap-toggle')
    expect(line.textContent).toContain('有 2 个竞品常用词你没写进标题 / 五点')
    fireEvent.click(line)
    const terms = screen.getAllByTestId('amzkw-gap-term').map((x) => x.textContent)
    expect(terms[0]).toBe('solar generator3 家竞品在用')
    expect(screen.getByTestId('amzkw-sort-note').textContent).toBe(
      '没有搜索量，按竞品里出现的次数排',
    )
  })

  it('还没有词库：同一个空块 + 「现在更新」小钮（只有图标）', async () => {
    empty = true
    renderWithProviders(<KeywordBankBlock assignment="asg_amz" />)
    const btn = await screen.findByTestId('amzkw-refresh')
    expect(btn.textContent).toBe('')
    expect(btn.getAttribute('aria-label')).toBe('现在更新')
    expect(screen.getByTestId('amzops-empty-keywords').textContent).toBe('还没有词库')
    empty = false
  })
})

describe('WP398 体检卡那一行', () => {
  it('给自家 ASIN 就出那一行；词库里没有这个 ASIN 就不出', async () => {
    const first = renderWithProviders(<KeywordGapLine asin="b0own00001" />)
    expect((await screen.findByTestId('amzkw-gap-line')).getAttribute('data-asin')).toBe(
      'B0OWN00001',
    )
    first.unmount()
    renderWithProviders(<KeywordGapLine asin="B0OTHER001" />)
    await waitFor(() => expect(screen.queryByTestId('amzkw-gap-line')).toBeNull())
  })
})

describe('WP398 第三栏词表', () => {
  it('可筛来源 / 差距 / 他牌名；他牌名那行标「不能填进后台关键词」；顶上照实写没有搜索量', async () => {
    renderWithProviders(
      <AmazonKeywordsPanel tier="role" pathname="/" address="agentsws://amazon-keywords/asg_amz" />,
    )
    await screen.findAllByTestId('amzkw-row')
    const filters = screen.getAllByTestId('amzkw-filter').map((f) => f.getAttribute('data-filter'))
    expect(filters).toEqual([
      'all',
      'gap',
      'other_brand',
      'autocomplete',
      'competitor_listing',
      'own_listing',
      'user',
    ])
    expect(screen.getByTestId('amzkw-panel-note').textContent).toBe(
      '共 2 个 · 没有搜索量，按竞品里出现的次数排',
    )
    expect(screen.getByTestId('amzkw-other-brand').textContent).toBe(
      'Jackery · 含别家品牌名，不能填进后台关键词',
    )
    fireEvent.click(screen.getByText('差距词', { selector: '[data-testid="amzkw-filter"]' }))
    await waitFor(() => expect(listed).toContainEqual({ gap: true }))
    fireEvent.click(screen.getByText('竞品 Listing'))
    await waitFor(() => expect(listed).toContainEqual({ source: 'competitor_listing' }))
  })

  it('标记：核心 / 不要 / 已埋进 Listing（只动本机词库）', async () => {
    renderWithProviders(
      <AmazonKeywordsPanel tier="role" pathname="/" address="agentsws://amazon-keywords/asg_amz" />,
    )
    const [first] = await screen.findAllByTestId('amzkw-row')
    const core = first?.querySelector('[data-mark="core"]') as HTMLElement
    fireEvent.click(core)
    await waitFor(() => expect(marked).toContainEqual({ id: 'US:solar generator', add: ['core'] }))
  })
})
