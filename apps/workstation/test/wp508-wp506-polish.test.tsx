/**
 * WP508：WP506 实拍（int/1039）后的三处修整。
 * 1. 在一批没发完的开发信里（排队中 / 在发 / 暂停）的红人：卡上主按钮「看进度」（滚到库顶那一批），
 *    详情里起草退成次要、点了只提示「已在一批开发信里」、不再起草第二封；已提上去、阶段没推进的主按钮「看看」；
 *    阶段推进了照阶段规则。
 * 2. 只有确认含义的卡（停用 / 启用知识……）没有通用的「修改」。
 * 3. 库顶「在发的批次」：标题、进度条、「已发 x / n」、等的原因挤成紧凑一行（进度条的槽看得见）。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KolCreatorDetailData,
  KolCreatorRowData,
  KolOutreachBatchProgress,
  PositionInstanceData,
  PositionsData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const { NOW, ROWS, api, progress, detail } = vi.hoisted(() => {
  const NOW = new Date().toISOString()
  const row = (
    id: string,
    name: string,
    extra: Partial<KolCreatorRowData> = {},
  ): KolCreatorRowData => ({
    creator_id: id,
    display_name: name,
    channel: 'youtube',
    handle: `@${name.toLowerCase().replace(/\s+/g, '')}`,
    url: `https://www.youtube.com/@${id}`,
    followers: 50_000,
    category: '数码',
    observed_at: NOW,
    score: 83,
    has_contact: true,
    ...extra,
  })
  const ROWS: KolCreatorRowData[] = [
    row('cre_q', 'Queued One', { score: 91, outreach_queue: 'queued' }),
    row('cre_s', 'Sent One', { score: 90, outreach_queue: 'sent' }),
    row('cre_fresh', 'Fresh One', { score: 80 }),
  ]
  const progress = (extra: Partial<KolOutreachBatchProgress> = {}): KolOutreachBatchProgress => ({
    batch_id: 'kob_1',
    approval_item_id: 'apr_batch',
    channel: 'youtube',
    state: 'sending',
    per_hour: 5,
    total: 3,
    sent: 1,
    queued: 2,
    skipped: 0,
    cancelled: 0,
    waiting: 'gap',
    next_at: NOW,
    created_at: NOW,
    rows: [
      { creator_id: 'cre_s', display_name: 'Sent One', state: 'sent', at: NOW },
      { creator_id: 'cre_q', display_name: 'Queued One', state: 'queued' },
    ],
    ...extra,
  })
  const detail = (id: string, extra: Partial<KolCreatorDetailData> = {}): KolCreatorDetailData =>
    ({
      creator: { id, display_name: id, merged_from: [] },
      accounts: [],
      contacts: [],
      collaborations: [],
      deliverables: [],
      tracked_links: [],
      ...extra,
    }) as unknown as KolCreatorDetailData
  const POSITIONS: PositionsData = {
    positions: [
      { position_id: 'asg_yt', role_id: 'kol.youtube', role_name: 'YouTube 红人' } as never,
    ],
    instances: [
      {
        position_id: 'kol-marketing',
        name: { zh: '红人营销', en: 'Creator Marketing' },
        roles: [{ role_id: 'kol.youtube', role_name: 'YouTube 红人', my_assignment_id: 'asg_yt' }],
      } as unknown as PositionInstanceData,
    ],
    tile_library: [],
    max_tiles: 0,
  }
  const api = {
    getPositions: vi.fn(async () => POSITIONS),
    getKolCreators: vi.fn(async () => ({ rows: ROWS, tags: [] })),
    getKolCreator: vi.fn(async (id: string) =>
      detail(id, id === 'cre_q' ? { outreach_queue: 'queued' } : {}),
    ),
    getKolCollaborations: vi.fn(async () => ({ rows: [] })),
    getKolMergeSuggestions: vi.fn(async () => ({ rows: [] })),
    getKolOutreachBatches: vi.fn(
      async (_f?: unknown, _a?: string): Promise<KolOutreachBatchProgress[]> => [],
    ),
    getKolOutreachDefaults: vi.fn(async () => ({
      brand_pitch: 'We make desk gear',
      product: 'Desk Mat',
      source: 'saved',
      mailbox_connected: true,
    })),
    draftKolOutreach: vi.fn(async () => ({ staged: true, approval_item_id: 'apr_x' })),
    listKnowledgeCards: vi.fn(async () => []),
    listKnowledgeRechecks: vi.fn(async () => []),
    listKnowledgeGaps: vi.fn(async () => []),
    listKnowledgeSources: vi.fn(async () => []),
    listRangeGroups: vi.fn(async () => []),
  }
  return { NOW, ROWS, api, progress, detail }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, ...api }
})

const { nextStepOf, outreachBatchOf } = await import('@/components/kol/creator-card')
const { KolLibraryPanel } = await import('@/components/kol/kol-library-panel')
const { CreatorDetailView } = await import('@/components/kol/creator-pane')
const { quickActions } = await import('@/components/deck/deck-action-bar')
const { deckKeyHints } = await import('@/components/deck/deck-keys')
const { translate } = await import('@/lib/i18n')
const intents = await import('@/components/library/library-intent')

const zh = (k: string): string => translate('zh', k)

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  api.getKolOutreachBatches.mockResolvedValue([])
  intents.resetLibraryIntents()
})

const kolScope = {
  tier: 'position' as const,
  scope_id: 'kol-marketing',
  name: '红人营销',
  roles: [{ role_id: 'kol.youtube', assignment: 'asg_yt' }],
}
const renderKol = () =>
  renderWithProviders(
    <KolLibraryPanel scope={kolScope} tier="position" pathname="/positions/asg_yt" />,
  )
const cardOf = (id: string): HTMLElement =>
  screen.getAllByTestId('kol-creator-card').find((c) => c.dataset.creator === id) as HTMLElement

describe('1. 批量开发信里的红人：主按钮不再是「起草开发信」', () => {
  const collab = (stage: string) =>
    ({ id: 'col_1', stage }) as unknown as NonNullable<KolCreatorRowData['collab']>

  it('排队中 → 看进度；已提上去、阶段没推进 → 看看；阶段推进了照阶段规则', () => {
    expect(nextStepOf({ outreach_queue: 'queued' })).toBe('progress')
    expect(nextStepOf({ outreach_queue: 'queued', collab: collab('sourced') })).toBe('progress')
    expect(nextStepOf({ outreach_queue: 'sent' })).toBe('view')
    expect(nextStepOf({ outreach_queue: 'sent', collab: collab('sourced') })).toBe('view')
    // 已联系以后：按阶段走，不再看批次
    expect(nextStepOf({ outreach_queue: 'sent', collab: collab('contacted') })).toBe('thread')
    expect(nextStepOf({ outreach_queue: 'queued', collab: collab('replied') })).toBe('negotiate')
    expect(outreachBatchOf({ outreach_queue: 'queued', collab: collab('contacted') })).toBe(
      undefined,
    )
    // 不在批次里的照旧
    expect(nextStepOf({})).toBe('draft')
  })

  it('库里：排队中的卡「看进度」→ 滚到库顶那一批亮一下；已发的「看看」；没在批次里的照旧「起草开发信」', async () => {
    api.getKolOutreachBatches.mockResolvedValue([progress()])
    renderKol()
    await screen.findByTestId('kol-live-batches')
    await waitFor(() => {
      expect(screen.getAllByTestId('kol-creator-card')).toHaveLength(3)
    })
    const queued = within(cardOf('cre_q')).getByTestId('kol-card-next')
    expect(queued.dataset.next).toBe('progress')
    expect(queued.textContent).toBe('看进度')
    const sent = within(cardOf('cre_s')).getByTestId('kol-card-next')
    expect(sent.dataset.next).toBe('view')
    expect(sent.textContent).toBe('看看')
    expect(within(cardOf('cre_fresh')).getByTestId('kol-card-next').textContent).toBe('起草开发信')

    const anchor = screen.getByTestId('kol-live-batches-anchor')
    const scrolled = vi.fn()
    anchor.scrollIntoView = scrolled
    fireEvent.click(queued)
    // 不叠详情，留在库里、滚到那一批
    expect(screen.queryByTestId('library-layer')).toBeNull()
    await waitFor(() => {
      expect(anchor.dataset.flash).toBe('true')
    })
    expect(scrolled).toHaveBeenCalled()
  })

  it('详情头上：排队中的主按钮「看进度」，起草退成次要、点了只提示「已在一批开发信里」，不起草', async () => {
    api.getKolOutreachBatches.mockResolvedValue([progress()])
    renderKol()
    await waitFor(() => {
      expect(screen.getAllByTestId('kol-creator-card')).toHaveLength(3)
    })
    fireEvent.click(within(cardOf('cre_q')).getByTestId('kol-library-row'))
    expect(await screen.findByTestId('library-layer')).toBeDefined()
    const go = screen.getByTestId('kol-detail-progress')
    expect(go.dataset.primary).toBe('true')
    expect(go.textContent).toBe('看进度')
    const draft = screen.getByTestId('kol-detail-draft')
    expect(draft.dataset.primary).toBe('false')
    expect(draft.dataset.inBatch).toBe('queued')
    fireEvent.click(draft)
    const toast = await screen.findByTestId('library-toast')
    expect(toast.textContent).toContain('已在一批开发信里')
    expect(api.draftKolOutreach).not.toHaveBeenCalled()
    // 提示上的「去看」= 收起详情、回到库顶那一批
    fireEvent.click(within(toast).getByText('去看'))
    await waitFor(() => {
      expect(screen.queryByTestId('library-layer')).toBeNull()
    })
    await waitFor(() => {
      expect(screen.getByTestId('kol-live-batches-anchor').dataset.flash).toBe('true')
    })
  })

  it('详情头上：已提上去的起草退成次要，但照常能起草；没在批次里的起草仍是主按钮', async () => {
    renderKol()
    await waitFor(() => {
      expect(screen.getAllByTestId('kol-creator-card')).toHaveLength(3)
    })
    fireEvent.click(within(cardOf('cre_s')).getByTestId('kol-library-row'))
    await screen.findByTestId('library-layer')
    expect(screen.queryByTestId('kol-detail-progress')).toBeNull()
    expect(screen.getByTestId('kol-detail-draft').dataset.primary).toBe('false')
    fireEvent.click(screen.getByTestId('library-back'))
    fireEvent.click(within(cardOf('cre_fresh')).getByTestId('kol-library-row'))
    await screen.findByTestId('library-layer')
    expect(screen.getByTestId('kol-detail-draft').dataset.primary).toBe('true')
  })

  it('详情里「开发信」那一段：排队中的起草按钮次要，点了只说一句、不起草', async () => {
    renderWithProviders(<CreatorDetailView assignment="asg_yt" channel="youtube" id="cre_q" />)
    const go = await screen.findByTestId('kol-outreach-go')
    expect(go.dataset.inBatch).toBe('queued')
    await waitFor(() => {
      expect((go as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(go)
    expect((await screen.findByTestId('kol-detail-receipt')).textContent).toContain(
      '已在一批开发信里',
    )
    expect(api.draftKolOutreach).not.toHaveBeenCalled()
  })

  it('详情里「开发信」那一段：已联系过（阶段推进了）就不算在批次里', async () => {
    api.getKolCreator.mockResolvedValueOnce(
      detail('cre_q', {
        outreach_queue: 'sent',
        collaborations: [
          { id: 'col_1', creator_id: 'cre_q', channel: 'youtube', stage: 'contacted' },
        ] as never,
      }),
    )
    renderWithProviders(<CreatorDetailView assignment="asg_yt" channel="youtube" id="cre_q" />)
    const go = await screen.findByTestId('kol-outreach-go')
    expect(go.dataset.inBatch).toBeUndefined()
  })
})

describe('2. 只有确认含义的卡：没有「修改」', () => {
  const card = (payload: Record<string, unknown>) =>
    ({
      id: 'apr_k',
      kind: 'knowledge_update',
      layout: 'change',
      status: 'pending',
      // 老服务端给的全套（含 instruct）：前端也兜一层
      available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
      detail: { payload },
    }) as unknown as DeckCard

  it('停用知识卡：停用 2 条 / 不用 / 稍后，键盘提示里也没有「修改」', () => {
    const toggle = card({
      form: 'knowledge_toggle',
      action: 'disable',
      reason: '旧口径',
      items: [
        { id: 'k1', statement: 'a' },
        { id: 'k2', statement: 'b' },
      ],
    })
    expect(quickActions(toggle)).toEqual(['approve', 'reject', 'snooze'])
    expect(deckKeyHints(toggle, zh).join(' · ')).toBe('→ 停用 2 条 · ← 不用 · ↑ 稍后')
  })

  it('FAQ 整批卡同理；普通的知识卡照旧有「修改」', () => {
    expect(quickActions(card({ form: 'faq_batch' }))).not.toContain('instruct')
    expect(quickActions(card({}))).toContain('instruct')
  })
})

describe('3. 库顶「在发的批次」：紧凑一行', () => {
  it('标题、进度条、已发 1 / 3、下一封约几点在同一行；进度条的槽用线色（在灰底上看得见）', async () => {
    api.getKolOutreachBatches.mockResolvedValue([progress()])
    renderKol()
    const strip = await screen.findByTestId('kol-live-batches')
    const head = within(strip).getByTestId('kol-batch-progress-head')
    expect(within(head).getByTestId('kol-batch-progress-title').textContent).toBe('批量开发信')
    expect(within(head).getByTestId('kol-batch-progress-sent').textContent).toBe('已发 1 / 3')
    expect(within(head).getByTestId('kol-batch-progress-wait').textContent).toContain('下一封约')
    expect(within(head).getByTestId('kol-batch-progress-bar').className).toContain('bg-ws-line')
    // 暂停 / 取消剩下的照旧在下面那一行
    expect(within(strip).getByTestId('kol-batch-pause')).toBeDefined()
    expect(within(strip).getByTestId('kol-batch-cancel')).toBeDefined()
    expect(NOW).toBeTruthy()
    expect(ROWS).toHaveLength(3)
  })
})
