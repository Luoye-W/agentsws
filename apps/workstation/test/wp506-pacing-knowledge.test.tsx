/**
 * WP506：
 * - 1788 B 批量开发信分时发：卡上「节奏」一格能改（没批时）；批了之后卡上 / 红人库顶上看进度、
 *   为什么还没发下一封、暂停 / 继续、取消剩下的；红人卡上「排队中 / 已发」；
 * - 1789 B 知识库多选「停用 / 启用」：就地生效 + 撤销；停用的「全部」里看不见、只在「已停用」筛选里；
 * - int/1038：红人库默认不带「评分 ≥ 80」筛选（低分 / 已淘汰的也在），默认按评分高到低。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeCardRow,
  KolCreatorRowData,
  KolOutreachBatchProgress,
  PositionInstanceData,
  PositionsData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const { NOW, ROWS, api, progress } = vi.hoisted(() => {
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
    row('cre_low', 'Low Score', { score: 41 }),
    row('cre_out', 'Rejected One', {
      score: 66,
      review: { decision: 'rejected', reason: '不对口', decided_at: NOW },
    }),
    row('cre_top', 'Top Pick', { score: 91, outreach_queue: 'queued' }),
    row('cre_sent', 'Already Sent', { score: 72, outreach_queue: 'sent' }),
  ]
  const progress = (extra: Partial<KolOutreachBatchProgress> = {}): KolOutreachBatchProgress => ({
    batch_id: 'kob_1',
    approval_item_id: 'apr_batch',
    channel: 'youtube',
    state: 'sending',
    per_hour: 10,
    total: 3,
    sent: 1,
    queued: 2,
    skipped: 0,
    cancelled: 0,
    waiting: 'gap',
    next_at: NOW,
    created_at: NOW,
    rows: [
      { creator_id: 'a', display_name: 'A', state: 'sent', at: NOW },
      { creator_id: 'b', display_name: 'B', state: 'queued' },
      { creator_id: 'c', display_name: 'C', state: 'queued' },
    ],
    ...extra,
  })
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
    getKolCollaborations: vi.fn(async () => ({ rows: [] })),
    getKolMergeSuggestions: vi.fn(async () => ({ rows: [] })),
    getKolOutreachBatches: vi.fn(
      async (_f?: unknown, _a?: string): Promise<KolOutreachBatchProgress[]> => [],
    ),
    controlKolOutreachBatch: vi.fn(
      async (_id: string, input: { action?: string; per_hour?: number }) =>
        progress({
          ...(input.per_hour === undefined ? {} : { per_hour: input.per_hour }),
          ...(input.action === 'pause' ? { state: 'paused' as const } : {}),
        }),
    ),
    listKnowledgeCards: vi.fn(async (): Promise<KnowledgeCardRow[]> => []),
    listKnowledgeRechecks: vi.fn(async () => []),
    listKnowledgeGaps: vi.fn(async () => []),
    listKnowledgeSources: vi.fn(async () => []),
    listRangeGroups: vi.fn(async () => []),
    setKnowledgeCardStage: vi.fn(async () => ({})),
    setKnowledgeCardsDisabled: vi.fn(
      async (ids: readonly string[], disabled: boolean, _a?: string) => ({
        updated: ids.map((id) => ({ id, ...(disabled ? { disabled_at: NOW } : {}) })),
        missing: [],
      }),
    ),
  }
  return { NOW, ROWS, api, progress }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, ...api }
})

const { KolOutreachBatchBody } = await import('@/components/kol/kol-card-bodies')
const { KnowledgeToggleBody } = await import('@/components/deck/knowledge-toggle-body')
const { deckActionLabel } = await import('@/components/deck/deck-action-bar')
const { translate } = await import('@/lib/i18n')
const { KolLibraryPanel } = await import('@/components/kol/kol-library-panel')
const { KnowledgeLibraryPanel } = await import('@/components/knowledge/knowledge-library-panel')
const { clockOf } = await import('@/components/kol/kol-batch-progress')
const intents = await import('@/components/library/library-intent')

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  api.getKolOutreachBatches.mockResolvedValue([])
  intents.resetLibraryIntents()
})

const payload = {
  form: 'kol_outreach_batch' as const,
  count: 3,
  creators: [
    { creator_id: 'a', display_name: 'A', initial: 'A' },
    { creator_id: 'b', display_name: 'B', initial: 'B' },
    { creator_id: 'c', display_name: 'C', initial: 'C' },
  ],
  skipped: [],
  letter: '首封合作邀请',
  cadence: '每小时最多 10 封，一封一封发；今天这条职责还能发 28 封，超了明天接着发',
  per_hour: 5,
  pace_basis: 'new' as const,
  pace_why: '同步到的已发信最早只到 12 天前（不到 90 天）',
  quota_remaining: 28,
  mailbox: 'connected' as const,
  heads_up: [],
}
const card = (actions: string[] = ['approve', 'reject']) =>
  ({
    id: 'apr_batch',
    position_id: 'asg_yt',
    available_actions: actions,
  }) as unknown as Pick<DeckCard, 'id' | 'position_id' | 'available_actions'>

describe('1788 B 批量开发信卡：节奏与进度', () => {
  it('没批：「新邮箱，每小时最多 [5] 封 · 今天还能发 28 封」，改成 8 存到这一批上（回车 / 失焦才存）', async () => {
    api.getKolOutreachBatches.mockResolvedValue([
      progress({ state: 'pending', sent: 0, queued: 3, per_hour: 5, pace_basis: 'new' }),
    ])
    renderWithProviders(<KolOutreachBatchBody payload={payload} card={card()} />)
    const input = (await screen.findByTestId('kol-batch-pace-input')) as HTMLInputElement
    expect(input.value).toBe('5')
    // 1795 C：缺省节奏的依据——「新邮箱，」写在前面，为什么在悬停里
    const basis = screen.getByTestId('kol-batch-pace-basis')
    expect(basis.textContent).toBe('新邮箱，')
    expect(basis.getAttribute('title')).toContain('不到 90 天')
    const facts = screen.getByTestId('kol-batch-facts').textContent ?? ''
    expect(facts).toContain('每小时最多')
    expect(facts).toContain('今天还能发 28 封，超了明天接着发')
    fireEvent.change(input, { target: { value: '8' } })
    expect(api.controlKolOutreachBatch).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(api.controlKolOutreachBatch).toHaveBeenCalledWith(
        'apr_batch',
        { per_hour: 8 },
        'asg_yt',
      )
    })
    // 超出范围的不发请求、退回原值
    api.controlKolOutreachBatch.mockClear()
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(api.controlKolOutreachBatch).not.toHaveBeenCalled()
    expect(screen.queryByTestId('kol-batch-progress')).toBeNull()
  })

  it('批了之后：已发 1 / 3、下一封约几点；暂停 / 取消剩下的走同一个口子', async () => {
    api.getKolOutreachBatches.mockResolvedValue([progress()])
    renderWithProviders(<KolOutreachBatchBody payload={payload} card={card([])} />)
    const box = await screen.findByTestId('kol-batch-progress')
    expect(box.dataset.state).toBe('sending')
    expect(screen.getByTestId('kol-batch-progress-sent').textContent).toBe('已发 1 / 3')
    expect(screen.getByTestId('kol-batch-progress-wait').textContent).toBe(
      `下一封约 ${clockOf(NOW)}`,
    )
    // 卡定了之后「节奏」那一行不再出（在进度那一块里改）
    expect(screen.getByTestId('kol-batch-facts').querySelector('[data-row="cadence"]')).toBeNull()
    fireEvent.click(screen.getByTestId('kol-batch-pause'))
    await waitFor(() => {
      expect(api.controlKolOutreachBatch).toHaveBeenCalledWith(
        'apr_batch',
        { action: 'pause' },
        'asg_yt',
      )
    })
    fireEvent.click(screen.getByTestId('kol-batch-cancel'))
    await waitFor(() => {
      expect(api.controlKolOutreachBatch).toHaveBeenCalledWith(
        'apr_batch',
        { action: 'cancel' },
        'asg_yt',
      )
    })
  })

  it('等的原因照实说：这一小时满了 / 今天额度满了 / 没连邮箱；暂停了出「继续」', async () => {
    const at = '2026-10-25T09:00:00.000Z'
    api.getKolOutreachBatches.mockResolvedValue([progress({ waiting: 'quota', next_at: at })])
    const { unmount } = renderWithProviders(
      <KolOutreachBatchBody payload={payload} card={card([])} />,
    )
    expect((await screen.findByTestId('kol-batch-progress-wait')).textContent).toBe(
      `今天的额度满了，约 ${clockOf(at)} 接着发`,
    )
    unmount()
    api.getKolOutreachBatches.mockResolvedValue([progress({ waiting: 'mailbox' })])
    const second = renderWithProviders(<KolOutreachBatchBody payload={payload} card={card([])} />)
    expect((await screen.findByTestId('kol-batch-progress-wait')).textContent).toBe(
      '还没连发信邮箱，连好就接着发',
    )
    second.unmount()
    api.getKolOutreachBatches.mockResolvedValue([progress({ state: 'paused' })])
    renderWithProviders(<KolOutreachBatchBody payload={payload} card={card([])} />)
    expect((await screen.findByTestId('kol-batch-progress-state')).textContent).toBe('暂停了')
    fireEvent.click(screen.getByTestId('kol-batch-resume'))
    await waitFor(() => {
      expect(api.controlKolOutreachBatch).toHaveBeenCalledWith(
        'apr_batch',
        { action: 'resume' },
        'asg_yt',
      )
    })
  })
})

describe('红人库：在发的批次、排队中 / 已发、默认不带评分筛选', () => {
  const kolScope = {
    tier: 'position' as const,
    scope_id: 'kol-marketing',
    name: '红人营销',
    roles: [{ role_id: 'kol.youtube', assignment: 'asg_yt' }],
  }

  it('默认不带「评分 ≥ 80」：低分、已淘汰的都在，按评分高到低；签手加上才筛', async () => {
    renderWithProviders(
      <KolLibraryPanel scope={kolScope} tier="position" pathname="/positions/asg_yt" />,
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('kol-creator-card')).toHaveLength(4)
    })
    const chip = screen.getByTestId('kol-library-top')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.textContent).toBe('+ 评分 ≥ 80')
    const names = (): string[] =>
      screen.getAllByTestId('kol-creator-card').map((c) => {
        const id = ROWS.find((r) => (c.textContent ?? '').includes(r.display_name))
        return id?.creator_id ?? '?'
      })
    expect(names()).toEqual(['cre_top', 'cre_sent', 'cre_out', 'cre_low'])
    fireEvent.click(chip)
    await waitFor(() => {
      expect(names()).toEqual(['cre_top'])
    })
    expect(screen.getByTestId('kol-library-top').textContent).toBe('评分 ≥ 80 ×')
  })

  it('卡上「排队中 / 已发」；顶上是在发的那一批（进度 + 暂停 / 取消）', async () => {
    api.getKolOutreachBatches.mockResolvedValue([
      progress(),
      progress({ batch_id: 'kob_old', approval_item_id: 'apr_old', state: 'done' }),
    ])
    renderWithProviders(
      <KolLibraryPanel scope={kolScope} tier="position" pathname="/positions/asg_yt" />,
    )
    const strip = await screen.findByTestId('kol-live-batches')
    // 发完了的那一批不在顶上
    expect(within(strip).getAllByTestId('kol-batch-progress')).toHaveLength(1)
    expect(api.getKolOutreachBatches).toHaveBeenCalledWith({ channel: 'youtube' }, 'asg_yt')
    const tags = await screen.findAllByTestId('kol-card-queue')
    expect(tags.map((x) => `${x.dataset.state}:${x.textContent}`).sort()).toEqual([
      'queued:排队中',
      'sent:已发',
    ])
  })
})

describe('1789 B 知识库：停用 / 启用', () => {
  const cards: KnowledgeCardRow[] = [
    {
      id: 'k_ship',
      layer: 'fact',
      subject: { type: 'logistics', key: 'eu_delivery_time' },
      statement: '欧盟配送 5–8 个工作日',
      status: 'active',
      updated_at: NOW,
    },
    {
      id: 'k_old',
      layer: 'fact',
      subject: { type: 'logistics', key: 'old_carrier' },
      statement: '旧快递商 3 天达',
      status: 'active',
      updated_at: NOW,
      disabled_at: NOW,
    },
  ]

  it('停用的「全部」里看不见，只在「已停用」里；多选停用当场生效、撤销 = 启用回来', async () => {
    api.listKnowledgeCards.mockResolvedValue(cards)
    renderWithProviders(<KnowledgeLibraryPanel tier="position" pathname="/" />)
    await waitFor(() => {
      expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual(['k_ship'])
    })
    // 三格的数只数在用的
    expect(screen.getByTestId('knowledge-stage-both').textContent).toContain('1')
    const chip = screen.getByTestId('knowledge-status-disabled')
    expect(chip.textContent).toContain('已停用')
    expect(chip.textContent).toContain('1')

    fireEvent.click(screen.getByTestId('library-multi'))
    fireEvent.click(screen.getAllByTestId('library-item-check')[0] as HTMLElement)
    expect(screen.queryByTestId('library-batch-enable')).toBeNull()
    fireEvent.click(screen.getByTestId('library-batch-disable'))
    await waitFor(() => {
      expect(api.setKnowledgeCardsDisabled).toHaveBeenCalledWith(['k_ship'], true)
    })
    expect((await screen.findByTestId('library-toast')).textContent).toContain('1 条已停用')
    fireEvent.click(await screen.findByTestId('library-toast-undo'))
    await waitFor(() => {
      expect(api.setKnowledgeCardsDisabled).toHaveBeenCalledWith(['k_ship'], false)
    })
  })

  it('「已停用」里：只露停用的、行上标「已停用」，批量条上是「启用」', async () => {
    api.listKnowledgeCards.mockResolvedValue(cards)
    renderWithProviders(<KnowledgeLibraryPanel tier="position" pathname="/" />)
    fireEvent.click(await screen.findByTestId('knowledge-status-disabled'))
    await waitFor(() => {
      expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual(['k_old'])
    })
    expect(screen.getByTestId('knowledge-row').textContent).toContain('已停用')
    fireEvent.click(screen.getByTestId('library-multi'))
    fireEvent.click(screen.getAllByTestId('library-item-check')[0] as HTMLElement)
    expect(screen.queryByTestId('library-batch-disable')).toBeNull()
    fireEvent.click(screen.getByTestId('library-batch-enable'))
    await waitFor(() => {
      expect(api.setKnowledgeCardsDisabled).toHaveBeenCalledWith(['k_old'], false)
    })
  })

  it('一条都没停用时不出「已停用」签', async () => {
    api.listKnowledgeCards.mockResolvedValue([cards[0] as KnowledgeCardRow])
    renderWithProviders(<KnowledgeLibraryPanel tier="position" pathname="/" />)
    await screen.findAllByTestId('knowledge-row')
    expect(screen.queryByTestId('knowledge-status-disabled')).toBeNull()
  })
})

describe('1795 C：老邮箱 / 人改过节奏', () => {
  it('老邮箱写「老邮箱，」；人改过节奏就不再说依据', async () => {
    api.getKolOutreachBatches.mockResolvedValue([
      progress({ state: 'pending', per_hour: 15, pace_basis: 'established' }),
    ])
    const first = renderWithProviders(<KolOutreachBatchBody payload={payload} card={card()} />)
    await waitFor(() => {
      expect(screen.getByTestId('kol-batch-pace-basis').textContent).toBe('老邮箱，')
    })
    expect((screen.getByTestId('kol-batch-pace-input') as HTMLInputElement).value).toBe('15')
    first.unmount()
    api.getKolOutreachBatches.mockResolvedValue([
      progress({ state: 'pending', per_hour: 8, pace_basis: 'new', pace_edited: true }),
    ])
    renderWithProviders(<KolOutreachBatchBody payload={payload} card={card()} />)
    await waitFor(() => {
      expect((screen.getByTestId('kol-batch-pace-input') as HTMLInputElement).value).toBe('8')
    })
    expect(screen.queryByTestId('kol-batch-pace-basis')).toBeNull()
  })
})

describe('1796 C：AI 提议停用知识的卡', () => {
  const toggle = {
    form: 'knowledge_toggle' as const,
    action: 'disable' as const,
    reason: '运费政策 10 月改了',
    items: [
      { id: 'k1', statement: '运费统一 9.9 美元（旧口径）' },
      { id: 'k2', statement: '旧口径：发货走 4PX' },
    ],
    before: null,
    after: '停用 2 条知识',
  }

  it('列出哪几条与 AI 的理由；主按钮「停用 2 条」、次按钮「不用」；没批时没有撤销', () => {
    renderWithProviders(
      <KnowledgeToggleBody
        card={{ status: 'pending', position_id: 'asg_cs' } as never}
        payload={toggle}
      />,
    )
    expect(screen.getAllByTestId('knowledge-toggle-item').map((x) => x.textContent)).toEqual([
      '运费统一 9.9 美元（旧口径）',
      '旧口径：发货走 4PX',
    ])
    expect(screen.getByTestId('knowledge-toggle-reason').textContent).toBe(
      'AI 的理由：运费政策 10 月改了',
    )
    expect(screen.queryByTestId('knowledge-toggle-undo')).toBeNull()
    const deck = {
      kind: 'knowledge_update',
      layout: 'change',
      available_actions: ['approve', 'reject'],
      detail: { payload: toggle },
    } as unknown as DeckCard
    const zh = (k: string): string => translate('zh', k)
    expect(deckActionLabel(deck, 'approve', zh)).toBe('停用 2 条')
    expect(deckActionLabel(deck, 'reject', zh)).toBe('不用')
  })

  it('批了：「已停用 2 条 · 撤销」——撤销 = 人点启用回来', async () => {
    renderWithProviders(
      <KnowledgeToggleBody
        card={{ status: 'approved', position_id: 'asg_cs' } as never}
        payload={toggle}
      />,
    )
    expect(screen.getByTestId('knowledge-toggle-done').textContent).toContain('已停用 2 条')
    fireEvent.click(screen.getByTestId('knowledge-toggle-undo'))
    await waitFor(() => {
      expect(api.setKnowledgeCardsDisabled).toHaveBeenCalledWith(['k1', 'k2'], false, 'asg_cs')
    })
    expect(await screen.findByText('已撤销')).toBeDefined()
  })
})
