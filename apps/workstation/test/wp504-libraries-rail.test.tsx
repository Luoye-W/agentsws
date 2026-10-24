/**
 * WP504（决策 1765「资料在右、决策在中」、1775–1779，设计稿 F1–F6）。
 *
 * 通用机制（各岗位共用，不许写特例）：
 * 1. 卡片列的库卡只在用它的岗位出（`available`），默认展开；库面板自己声明最窄多宽（`minWidth`）；旧 id 是别名；
 * 2. 地址栏 `?panel=` 一组 → 开那一格、带上「开到哪 / 叠开谁」，然后从地址栏收掉；
 * 3. 叠一层：库一直挂着（搜的字、勾选都在），← 回来；
 * 4. 多选 + 吸顶批量条：要确认的（发开发信）出中栏卡、提示带「去看」、库里标「等你确认」；当场生效的（加标签、淘汰）带「撤销」；
 * 5. ✦ 问 AI：卡变成输入框里的引用小卡（结构化摘要）+ 建议问题；`@` 搜得到库里的人；发出去时引用随话交给服务端；
 * 6. 知识库：公共 / 售前 / 售后，「要复核」只是筛选，B2B 默认按本岗位筛，批量移格可撤销；
 * 7. 旧整页跳转：`/knowledge` 去当前岗位（不用知识的去客服）。
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeCardRow,
  KolCreatorRowData,
  PositionInstanceData,
  PositionsData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const { NOW, row, ROWS, POSITIONS, api } = vi.hoisted(() => {
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
    followers: 164_000,
    category: '数码',
    observed_at: NOW,
    score: 83,
    has_contact: true,
    ...extra,
  })
  const ROWS: KolCreatorRowData[] = [
    row('cre_desk', 'Desk Fixture', { tags: ['德国'] }),
    row('cre_mira', 'Mira Builds', { score: 78, tags: ['桌搭'] }),
    row('cre_lab', 'Setup Lab DE', { score: 74 }),
  ]

  const POSITIONS: PositionsData = {
    positions: [
      { position_id: 'asg_yt', role_id: 'kol.youtube', role_name: 'YouTube 红人' } as never,
      { position_id: 'asg_cs', role_id: 'cs.site', role_name: '网站客服' } as never,
    ],
    instances: [
      {
        position_id: 'kol-marketing',
        name: { zh: '红人营销', en: 'Creator Marketing' },
        roles: [{ role_id: 'kol.youtube', role_name: 'YouTube 红人', my_assignment_id: 'asg_yt' }],
      } as unknown as PositionInstanceData,
      {
        position_id: 'customer-care',
        name: { zh: '客服', en: 'Customer Care' },
        roles: [{ role_id: 'cs.site', role_name: '网站客服', my_assignment_id: 'asg_cs' }],
      } as unknown as PositionInstanceData,
    ],
    tile_library: [],
    max_tiles: 0,
  }

  const api = {
    getPositions: vi.fn(async () => POSITIONS),
    getKolCreators: vi.fn(async (_f: unknown, _a?: string) => ({
      rows: ROWS,
      tags: ['德国', '桌搭'],
    })),
    getKolCollaborations: vi.fn(async () => ({ rows: [] })),
    batchKolOutreach: vi.fn(async (input: { creator_ids: string[] }) => ({
      ok: true,
      approval_item_id: 'apv_batch',
      batch_id: 'obt_1',
      sending: input.creator_ids.map((creator_id) => ({ creator_id, display_name: creator_id })),
      skipped: [],
    })),
    setKolCreatorTags: vi.fn(async () => ({})),
    reviewKolCreator: vi.fn(async () => ({})),
    getKolCreator: vi.fn(async () => ({
      creator: { id: 'cre_desk', display_name: 'Desk Fixture', merged_from: [] },
      accounts: [],
      contacts: [],
      collaborations: [],
      deliverables: [],
      tracked_links: [],
    })),
    getKolMergeSuggestions: vi.fn(async () => ({ rows: [] })),
    listKnowledgeCards: vi.fn(async (): Promise<KnowledgeCardRow[]> => []),
    listKnowledgeRechecks: vi.fn(async () => []),
    listKnowledgeGaps: vi.fn(async () => []),
    listKnowledgeSources: vi.fn(async () => []),
    listRangeGroups: vi.fn(async () => []),
    setKnowledgeCardStage: vi.fn(async () => ({})),
  }

  return { NOW, row, ROWS, POSITIONS, api }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, ...api }
})

const registry = await import('@/components/rail/registry')
const { ensureBuiltinPanels } = await import('@/components/rail/builtin-panels')
const { paneWidth, bindRightPaneHost, resetRightPane } = await import(
  '@/components/rail/right-pane'
)
const intents = await import('@/components/library/library-intent')
const askStore = await import('@/components/ask-ai/ask-ai-store')
const { arcFrames } = await import('@/components/ask-ai/ask-ai')
const { mentionAt, useComposerRefs } = await import('@/components/ask-ai/composer-refs')
const { searchRefs, resetRefSources } = await import('@/components/ask-ai/ref-sources')
const { KolLibraryPanel, creatorRef, kolSummary, creatorsCsv } = await import(
  '@/components/kol/kol-library-panel'
)
const { hasKolRole } = await import('@/components/kol/kol-library-status')
const { KnowledgeLibraryPanel } = await import('@/components/knowledge/knowledge-library-panel')
const { usesKnowledge } = await import('@/components/knowledge/knowledge-library-status')
const { knowledgeTarget } = await import('@/pages/knowledge')
const { MatterComposer } = await import('@/components/matter/matter-composer')
const { translate } = await import('@/lib/i18n')

const t = (k: string, v?: Record<string, string | number>): string => translate('zh', k, v)

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  askStore.resetAskAi()
  intents.resetLibraryIntents()
  resetRefSources()
  resetRightPane()
})
afterEach(() => {
  askStore.resetAskAi()
})

const kolScope = {
  tier: 'position' as const,
  scope_id: 'kol-marketing',
  name: '红人营销',
  roles: [{ role_id: 'kol.youtube', assignment: 'asg_yt' }],
}

describe('通用机制：注册表与开法', () => {
  it('库卡只在用它的岗位出、默认展开；库面板自己说最窄多宽；旧 id 落到库面板', () => {
    registry.resetPanelRegistry()
    ensureBuiltinPanels()
    const kol = registry.railCard('kol-library')
    expect(kol?.panel).toBe('kol-library')
    expect(kol?.defaultOpen).toBe(true)
    expect(kol?.available?.({ scope: kolScope, tier: 'position', pathname: '/' })).toBe(true)
    expect(
      kol?.available?.({
        scope: {
          ...kolScope,
          scope_id: 'customer-care',
          roles: [{ role_id: 'cs.site', assignment: 'asg_cs' }],
        },
        tier: 'position',
        pathname: '/',
      }),
    ).toBe(false)
    expect(
      registry.railCard('knowledge-library')?.available?.({
        scope: { tier: 'position', scope_id: 'b2b', name: 'B2B' },
        tier: 'position',
        pathname: '/',
      }),
    ).toBe(true)
    expect(
      registry.railCard('brand-assets-library')?.available?.({
        scope: { tier: 'position', scope_id: 'design', name: '设计' },
        tier: 'position',
        pathname: '/',
      }),
    ).toBe(true)
    // 库面板在「本岗位」那一组；最窄多宽是面板自己声明的
    expect(registry.panelType('kol-library')?.group).toBe('layer')
    expect(paneWidth('kol-library', 420, registry.panelType('kol-library')?.minWidth)).toBe(680)
    expect(paneWidth('kol-library', 900, registry.panelType('kol-library')?.minWidth)).toBe(900)
    expect(paneWidth('report', 300)).toBe(560)
    expect(registry.resolvePanelId('kol-creator')).toEqual({ id: 'kol-library' })
    expect(registry.resolvePanelId('knowledge')).toEqual({ id: 'knowledge-library' })
    // 职责层：看它所属的岗位
    expect(
      usesKnowledge({
        scope: {
          tier: 'role',
          scope_id: 'b2b.sales',
          name: '业务',
          parent: { tier: 'position', scope_id: 'b2b', name: 'B2B' },
        },
      }),
    ).toBe(true)
    expect(hasKolRole({ scope: kolScope })).toBe(true)
  })

  it('地址栏 ?panel= 一组：panel / tab / item 单独认，其余原样当参数；没有 panel 不认', () => {
    expect(intents.intentFromSearch(new URLSearchParams('x=1'))).toBeUndefined()
    expect(
      intents.intentFromSearch(
        new URLSearchParams(
          'panel=kol-library&tab=campaign&creator=@desk&batch=bt_1&channel=tiktok',
        ),
      ),
    ).toEqual({
      panel: 'kol-library',
      intent: { tab: 'campaign', params: { creator: '@desk', batch: 'bt_1', channel: 'tiktok' } },
    })
  })

  it('openLibrary：记下开到哪，按面板 id 开第三栏那一格；用掉之后就没了（同一个 nonce 只用一次）', () => {
    const opened: unknown[] = []
    const off = bindRightPaneHost({
      open: (r) => {
        opened.push(r)
        return true
      },
      close: () => {},
    })
    expect(intents.openLibrary('kol-library', { item: 'cre_desk' })).toBe(true)
    expect(opened).toEqual([{ panel: 'kol-library' }])
    off()
  })
})

describe('✦ 问 AI（1775 A / 1776 A）', () => {
  it('一个红人 → 引用小卡：结构化摘要（分数、粉丝、互动、阶段、审核、标签、联系方式）+ 3 个建议问题', () => {
    const ref = creatorRef(
      row('cre_desk', 'Desk Fixture', {
        engagement_judgement: { key: 'healthy', level: 'good', value: '3.1', median: '2.4' },
        tags: ['德国', '键盘'],
      }),
      t,
    )
    expect(ref).toMatchObject({
      kind: 'creator',
      id: 'cre_desk',
      label: 'Desk Fixture',
      sub: '红人 · 83 分',
    })
    const facts = Object.fromEntries(ref.facts.map((f) => [f.k, f.v]))
    expect(facts['匹配度']).toBe('83')
    expect(facts['粉丝']).toBe('164k')
    expect(facts['互动率']).toBe('3.1%（同量级中位 2.4%）')
    expect(facts['标签']).toBe('德国、键盘')
    expect(facts['审核']).toBe('待审')
    expect(ref.suggestions).toEqual([
      '为什么是 83 分？',
      '帮我起草开发信',
      '和库里同类的比，谁更合适？',
    ])
  })

  it('放进输入框：同一张只放一次、最多 10 张；几张一起时建议 = 第一张的两个 + 比一比；发出去的形状截到上限', () => {
    const a = creatorRef(ROWS[0] as KolCreatorRowData, t)
    const b = creatorRef(ROWS[1] as KolCreatorRowData, t)
    askStore.addRefs([a])
    askStore.addRefs([a, b])
    expect(askStore.currentRefs().map(askStore.refKey)).toEqual([
      'creator:cre_desk',
      'creator:cre_mira',
    ])
    expect(askStore.suggestionsOf(askStore.currentRefs(), '比一比')).toEqual([
      '为什么是 83 分？',
      '帮我起草开发信',
      '比一比',
    ])
    const payload = askStore.refsPayload([
      {
        ...a,
        facts: [
          { k: 'x', v: 'y'.repeat(900) },
          { k: '空', v: ' ' },
        ],
      },
    ])
    expect(payload[0]?.facts).toEqual([{ k: 'x', v: 'y'.repeat(500) }])
    askStore.addRefs(Array.from({ length: 12 }, (_, i) => ({ ...a, id: `c${i}` })))
    expect(askStore.currentRefs()).toHaveLength(askStore.MAX_REFS)
  })

  it('飞的那条弧：起点 → 中点往上抬 → 终点（缩成小卡）；@ 只认行首或空格后的 @词', () => {
    const f = arcFrames({ x: 0, y: 0 }, { x: -400, y: 300 })
    expect(f[0]).toEqual({ x: 0, y: 0, scale: 1 })
    expect(f[2]).toEqual({ x: -400, y: 300, scale: 0.7 })
    expect(f[1]?.y).toBeLessThan(150)
    expect(mentionAt('和 @mira', 7)).toEqual({ start: 2, q: 'mira' })
    expect(mentionAt('a@b.com', 7)).toBeUndefined()
    expect(mentionAt('@', 1)).toEqual({ start: 0, q: '' })
  })

  it('输入框：引用小卡 + 建议问题；拖一张卡进来 = 点 ✦；× 拿掉；发出去带着结构化摘要', async () => {
    const sent: unknown[] = []
    function Harness(): React.ReactNode {
      const [text, setText] = useState('')
      const area = useRef<HTMLTextAreaElement>(null)
      const asked = useComposerRefs({ area, onChange: setText })
      return (
        <>
          <p data-testid="sugg">{asked.suggestions.join('|')}</p>
          <MatterComposer
            value={text}
            onChange={asked.onChange}
            onSend={() => {
              sent.push({ text, context: asked.payload() })
              asked.clear()
            }}
            onStop={() => {}}
            running={false}
            closed={false}
            sending={false}
            askTarget
            areaRef={area}
            chips={asked.chips}
            overlay={asked.overlay}
            onKeyDownFirst={asked.onKeyDownFirst}
            onRefDrop={asked.onRefDrop}
          />
        </>
      )
    }
    const { container } = renderWithProviders(<Harness />)
    expect(container.querySelector('[data-ask-ai-target]')).not.toBeNull()
    act(() => {
      askStore.addRefs([creatorRef(ROWS[0] as KolCreatorRowData, t)])
    })
    expect(await screen.findByTestId('ask-ai-chip')).toBeDefined()
    expect(screen.getByTestId('sugg').textContent).toContain('为什么是 83 分？')
    // 拖一张进来
    const form = screen.getByTestId('matter-say')
    const ref = creatorRef(ROWS[1] as KolCreatorRowData, t)
    fireEvent.drop(form, {
      dataTransfer: {
        types: [askStore.REF_MIME],
        getData: (k: string) => (k === askStore.REF_MIME ? JSON.stringify([ref]) : ''),
        files: [],
      },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('ask-ai-chip')).toHaveLength(2)
    })
    fireEvent.click(
      within(screen.getAllByTestId('ask-ai-chip')[1] as HTMLElement).getByTestId(
        'ask-ai-chip-remove',
      ),
    )
    expect(screen.getAllByTestId('ask-ai-chip')).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '值得找吗' } })
    fireEvent.click(screen.getByTestId('matter-send'))
    expect(sent).toHaveLength(1)
    const first = sent[0] as {
      text: string
      context: { kind: string; id: string; facts: unknown[] }[]
    }
    expect(first.text).toBe('值得找吗')
    expect(first.context.map((c) => `${c.kind}:${c.id}`)).toEqual(['creator:cre_desk'])
    expect(first.context[0]?.facts.length).toBeGreaterThan(5)
    expect(screen.queryByTestId('ask-ai-chip')).toBeNull()
  })
})

describe('红人库（F1 / F2 / F3）', () => {
  const renderKol = (): void => {
    renderWithProviders(
      <KolLibraryPanel scope={kolScope} tier="position" pathname="/positions/asg_yt" />,
    )
  }

  it('卡片列那张卡的三个数：在谈 / 待审 / 本周新收；导出是 CSV', () => {
    const sum = kolSummary([
      row('a', 'A', {
        collab: { id: 'c', stage: 'negotiating', with_sample: false, stalled: false, segments: [] },
      }),
      row('b', 'B', { review: { decision: 'approved', decided_at: NOW } }),
      row('c', 'C', { observed_at: '2020-01-01T00:00:00.000Z' }),
    ])
    expect(sum).toEqual({ total: 3, talking: 1, pending: 2, fresh: 2 })
    expect(
      creatorsCsv([row('a', 'A, "B"')])
        .split('\n')[1]
        ?.startsWith('"A, ""B"""'),
    ).toBe(true)
  })

  it('三格 + 搜索 + 筛选；点一个人详情叠在库上（头上「← 红人库 / 名字」），回来搜的字还在', async () => {
    renderKol()
    expect(await screen.findAllByTestId('kol-creator-card')).toHaveLength(3)
    expect(screen.getByTestId('kol-library-tab-creators').textContent).toContain('3')
    fireEvent.change(screen.getByTestId('kol-library-search'), { target: { value: 'desk' } })
    fireEvent.click(
      within(screen.getAllByTestId('library-item')[0] as HTMLElement).getByTestId(
        'kol-library-row',
      ),
    )
    expect(await screen.findByTestId('library-layer')).toBeDefined()
    expect(screen.getByTestId('library-layer-title').textContent).toBe('Desk Fixture')
    expect(screen.getByTestId('library-base').hidden).toBe(true)
    // 详情里的按钮也分两类（1777 A）
    expect(screen.getByTestId('kol-detail-draft').dataset.kind).toBe('confirm')
    expect(screen.getByTestId('kol-detail-campaign').dataset.kind).toBe('instant')
    fireEvent.click(screen.getByTestId('library-back'))
    expect(screen.queryByTestId('library-layer')).toBeNull()
    expect((screen.getByTestId('kol-library-search') as HTMLInputElement).value).toBe('desk')
  })

  it('多选 → 吸顶批量条；发开发信 = 出中栏确认卡（提示带「去看」）；加标签当场生效、撤销就回去', async () => {
    renderKol()
    await screen.findAllByTestId('kol-creator-card')
    expect(screen.queryAllByTestId('library-item-check')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('library-multi'))
    const checks = screen.getAllByTestId('library-item-check')
    fireEvent.click(checks[0] as HTMLElement)
    fireEvent.click(checks[1] as HTMLElement)
    const bar = screen.getByTestId('library-batch-bar')
    expect(bar.dataset.count).toBe('2')
    expect(screen.getByTestId('library-batch-outreach').dataset.kind).toBe('confirm')
    fireEvent.click(screen.getByTestId('library-batch-outreach'))
    await waitFor(() => {
      expect(api.batchKolOutreach).toHaveBeenCalledWith(
        { channel: 'youtube', creator_ids: ['cre_desk', 'cre_mira'] },
        'asg_yt',
      )
    })
    const toast = await screen.findByTestId('library-toast')
    expect(toast.textContent).toContain('等你在中栏确认')
    expect(within(toast).getByTestId('library-toast-goto')).toBeDefined()
    // 加标签：先要一句话，回车才跑；撤销 = 各回原来那一组
    fireEvent.click(screen.getByTestId('library-batch-tag'))
    fireEvent.change(screen.getByTestId('library-batch-ask-field'), { target: { value: '键盘' } })
    fireEvent.click(screen.getByTestId('library-batch-ask-go'))
    await waitFor(() => {
      expect(api.setKolCreatorTags).toHaveBeenCalledWith('cre_desk', ['德国', '键盘'], 'asg_yt')
    })
    expect(api.setKolCreatorTags).toHaveBeenCalledWith('cre_mira', ['桌搭', '键盘'], 'asg_yt')
    const undo = await screen.findByTestId('library-toast-undo')
    api.setKolCreatorTags.mockClear()
    fireEvent.click(undo)
    await waitFor(() => {
      expect(api.setKolCreatorTags).toHaveBeenCalledWith('cre_desk', ['德国'], 'asg_yt')
    })
  })

  it('卡角 ✦：放进引用、被问的卡亮一圈；@ 搜得到库里的人', async () => {
    renderKol()
    await screen.findAllByTestId('kol-creator-card')
    fireEvent.click(
      within(screen.getAllByTestId('library-item')[0] as HTMLElement).getByTestId(
        'library-item-ask',
      ),
    )
    expect(askStore.currentRefs().map((r) => r.id)).toEqual(['cre_desk'])
    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')[0]?.dataset.asked).toBe('true')
    })
    const hits = await searchRefs('', 'zh')
    expect(hits.map((h) => `${h.type}:${h.ref.label}`)).toContain('红人:Mira Builds')
  })

  it('深链：开到「活动」、叠开 handle 认出来的那个人', async () => {
    intents.setLibraryIntent('kol-library', { params: { creator: '@setuplabde' } })
    renderKol()
    expect(await screen.findByTestId('library-layer')).toBeDefined()
    expect(screen.getByTestId('library-layer-title').textContent).toBe('Setup Lab DE')
    expect(intents.useLibraryIntent).toBeDefined()
  })
})

describe('知识库（F6）', () => {
  const cards: KnowledgeCardRow[] = [
    {
      id: 'k_ship',
      layer: 'fact',
      subject: { type: 'logistics', key: 'eu_delivery_time' },
      statement: '欧盟配送 5–8 个工作日',
      status: 'active',
      stage: 'presales',
      updated_at: NOW,
      verification_state: 'stale',
    },
    {
      id: 'k_b2b',
      layer: 'fact',
      subject: { type: 'b2b_fact', key: 'b2b:pricing_moq' },
      statement: 'MOQ 1000 个 / 款',
      status: 'active',
      updated_at: NOW,
    },
    {
      id: 'k_voice',
      layer: 'phrasing',
      subject: { type: 'knowledge', key: 'brand_voice' },
      statement: '报价先问用途和桌宽',
      status: 'active',
      updated_at: NOW,
    },
  ]

  it('三格带数；「要复核」只是筛选签；B2B 进来默认只看本岗位用的（签可去掉）', async () => {
    api.listKnowledgeCards.mockResolvedValue(cards)
    api.listKnowledgeRechecks.mockResolvedValue([
      {
        id: 'r1',
        card_id: 'k_ship',
        source_id: 's',
        status: 'open',
        before: [],
        after: [],
        categories: [],
        created_at: NOW,
      },
    ] as never)
    renderWithProviders(
      <KnowledgeLibraryPanel
        scope={{ tier: 'position', scope_id: 'b2b', name: 'B2B' }}
        tier="position"
        pathname="/"
      />,
    )
    await screen.findByTestId('knowledge-stage-tabs')
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-stage-presales').textContent).toContain('1')
    })
    // B2B：品牌话术不在它那几类里
    await waitFor(() => {
      expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual(['k_b2b'])
    })
    fireEvent.click(screen.getByTestId('knowledge-position-filter'))
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId('knowledge-row')
          .map((r) => r.dataset.card)
          .sort(),
      ).toEqual(['k_b2b', 'k_voice'])
    })
    // 要复核：只是筛选（复核本身在中栏）
    fireEvent.click(screen.getByTestId('knowledge-stage-presales'))
    fireEvent.click(await screen.findByTestId('knowledge-recheck-filter'))
    expect(screen.getAllByTestId('knowledge-row').map((r) => r.dataset.card)).toEqual(['k_ship'])
    expect(screen.getByTestId('knowledge-recheck-mark')).toBeDefined()
  })

  it('批量移格当场生效，撤销各回原来那一格', async () => {
    api.listKnowledgeCards.mockResolvedValue(cards)
    renderWithProviders(<KnowledgeLibraryPanel tier="position" pathname="/" />)
    await screen.findAllByTestId('knowledge-row')
    fireEvent.click(screen.getByTestId('library-multi'))
    fireEvent.click(screen.getAllByTestId('library-item-check')[0] as HTMLElement)
    fireEvent.click(screen.getByTestId('library-batch-stage-postsales'))
    await waitFor(() => {
      expect(api.setKnowledgeCardStage).toHaveBeenCalledTimes(1)
    })
    const [id, stage] = api.setKnowledgeCardStage.mock.calls[0] as unknown as [string, string]
    expect(stage).toBe('postsales')
    api.setKnowledgeCardStage.mockClear()
    fireEvent.click(await screen.findByTestId('library-toast-undo'))
    await waitFor(() => {
      expect(api.setKnowledgeCardStage).toHaveBeenCalledWith(id, 'both')
    })
  })

  it('/knowledge 跳到：当前岗位用知识就开在当前岗位；不用的去客服；一个都没有去首页', () => {
    const inst = POSITIONS.instances ?? []
    expect(knowledgeTarget(inst, 'asg_cs', new URLSearchParams())).toBe(
      '/positions/asg_cs?panel=knowledge-library',
    )
    expect(knowledgeTarget(inst, 'asg_yt', new URLSearchParams())).toBe(
      '/positions/asg_cs?panel=knowledge-library',
    )
    expect(knowledgeTarget([], null, new URLSearchParams())).toBe('/?panel=knowledge-library')
  })
})
