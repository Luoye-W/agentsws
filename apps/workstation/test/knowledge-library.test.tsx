/**
 * WP209：知识库页「先分类、再展开」。
 *
 * 钉住五件：
 * 1. 按类型分组、每组带计数、空组不显示；上传的文件进「上传的文档」那一组；
 * 2. 每条标状态与来源；
 * 3. 按状态筛（带计数）；
 * 4. 按品牌（适用范围）筛：选一个品牌 = 它的 + 通用的；没有带范围的卡时不出这个下拉；
 * 5. 搜索；什么都对不上时说人话。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeCardRow, KnowledgeSource } from '@/lib/api'
import { renderWithProviders } from './helpers'

const card = (id: string, extra: Partial<KnowledgeCardRow> = {}): KnowledgeCardRow => ({
  id,
  layer: 'fact',
  subject: { type: 'knowledge', key: id },
  statement: `${id} 的口径`,
  status: 'active',
  updated_at: '2026-09-30T00:00:00.000Z',
  ...extra,
})

const state = {
  cards: [] as KnowledgeCardRow[],
  sources: [] as KnowledgeSource[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listKnowledgeCards: async () => state.cards,
    listKnowledgeRechecks: async () => [],
    listKnowledgeGaps: async () => [],
    listKnowledgeBoundaries: async () => [],
    listKnowledgeSources: async () => state.sources,
    listRangeGroups: async () => [
      {
        id: 'rg_north',
        name: '北美店铺组',
        members: [],
        created_at: '',
        updated_at: '',
        holders: 0,
      },
    ],
  }
})

const { KnowledgePage } = await import('@/pages/knowledge')

const CARDS: KnowledgeCardRow[] = [
  card('b2b:pricing_moq', {
    statement: 'MOQ 1000 个 / 款',
    created_by: { kind: 'person', id: 'p' },
  }),
  card('b2b:certifications', {
    statement: '认证清单待核',
    status: 'proposed',
    created_by: { kind: 'agent', id: 'onboarding' },
  }),
  card('returns.window.de', {
    statement: '德国站退货窗口 14 天',
    provenance: [{ source: 'document', ref: 'knowledge/fact-returns-de.md' }],
  }),
  card('warranty.window', { statement: '保修 24 个月', verification_state: 'stale' }),
  card('tone.aftersales', {
    layer: 'phrasing',
    statement: '先确认订单号再说能做什么',
    scope: [{ kind: 'store', id: 'rg_north' }],
  }),
  card('shipping.cutoff', {
    statement: '下午 3 点前的单当天发',
    conflicts: [{ with: 'x', note: '另一条说 4 点' }],
  }),
]

const groupEl = (id: string): HTMLElement | undefined =>
  screen.queryAllByTestId('library-group').find((g) => g.dataset.group === id)

const rowsIn = (id: string): string[] =>
  within(groupEl(id) as HTMLElement)
    .queryAllByTestId('knowledge-row')
    .map((r) => r.dataset.card ?? '')

describe('WP209 知识库按类型分组', () => {
  it('按类型分组、带计数、空组不显示；上传的文件单独一组', async () => {
    state.cards = CARDS
    state.sources = [
      {
        id: 'src_1',
        workspace_id: 'ws',
        kind: 'upload',
        ref: 'blob://k/1.xlsx',
        parser: 'anydoc',
        acl_inherit: false,
        chunks: 1,
        filename: '报价单.xlsx',
      },
    ]
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findAllByTestId('knowledge-row')
    await waitFor(() => {
      expect(groupEl('uploads')).toBeDefined()
    })
    const order = screen.getAllByTestId('library-group').map((g) => g.dataset.group)
    expect(order).toEqual(['policy', 'logistics', 'b2b', 'brand_voice', 'uploads'])
    expect(rowsIn('b2b')).toEqual(['b2b:pricing_moq', 'b2b:certifications'])
    expect(
      within(groupEl('b2b') as HTMLElement).getByTestId('library-group-count').textContent,
    ).toBe('2')
    // 产品事实 / 其它这两组没有卡：不显示
    expect(groupEl('product')).toBeUndefined()
    expect(groupEl('other')).toBeUndefined()
    expect(screen.getByTestId('knowledge-source-src_1').textContent).toContain('报价单.xlsx')
  })

  it('每条标状态与来源', async () => {
    state.cards = CARDS
    state.sources = []
    renderWithProviders(<KnowledgePage />, '/knowledge')
    const rows = await screen.findAllByTestId('knowledge-row')
    const by = (id: string): HTMLElement => rows.find((r) => r.dataset.card === id) as HTMLElement
    expect(by('b2b:certifications').dataset.status).toBe('pending')
    expect(by('b2b:certifications').dataset.origin).toBe('agent')
    expect(by('returns.window.de').dataset.origin).toBe('upload')
    expect(by('warranty.window').dataset.status).toBe('expired')
    expect(by('shipping.cutoff').dataset.status).toBe('conflict')
    expect(by('b2b:pricing_moq').textContent).toContain('已生效')
    expect(by('b2b:pricing_moq').textContent).toContain('手填')
    expect(by('b2b:pricing_moq').textContent).toContain('价格与 MOQ')
    expect(by('returns.window.de').textContent).toContain('退换')
  })

  it('按状态筛：芯片上带数，点一下只剩那一档', async () => {
    state.cards = CARDS
    state.sources = []
    const user = userEvent.setup()
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findAllByTestId('knowledge-row')
    expect(screen.getByTestId('knowledge-status-pending').textContent).toContain('1')
    await user.click(screen.getByTestId('knowledge-status-expired'))
    expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual([
      'warranty.window',
    ])
    await user.click(screen.getByTestId('knowledge-status-all'))
    expect(screen.getAllByTestId('knowledge-row')).toHaveLength(CARDS.length)
  })

  it('按品牌 / 范围筛：选一个 = 它的 + 通用的；范围名字从范围组来', async () => {
    state.cards = CARDS
    state.sources = []
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findAllByTestId('knowledge-row')
    const select = (await screen.findByTestId('knowledge-scope')) as HTMLSelectElement
    await waitFor(() => {
      expect(select.textContent).toContain('北美店铺组')
    })
    fireEvent.change(select, { target: { value: 'store:rg_north' } })
    expect(screen.getAllByTestId('knowledge-row')).toHaveLength(CARDS.length)
    fireEvent.change(select, { target: { value: '' } })
    expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).not.toContain(
      'tone.aftersales',
    )
  })

  it('没有带范围的卡时不出品牌下拉；搜索；对不上时说人话', async () => {
    state.cards = CARDS.filter((c) => c.scope === undefined)
    state.sources = []
    const user = userEvent.setup()
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findAllByTestId('knowledge-row')
    expect(screen.queryByTestId('knowledge-scope')).toBeNull()
    await user.type(screen.getByTestId('knowledge-search'), 'MOQ')
    expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual([
      'b2b:pricing_moq',
    ])
    await user.type(screen.getByTestId('knowledge-search'), '没有这个词')
    expect(screen.getByTestId('knowledge-no-match')).toBeDefined()
  })
})
