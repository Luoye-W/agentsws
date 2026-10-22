/**
 * WP207 左栏：三级「+」（新建岗位 / 加职责 / 职责下开新事）、职责下的对话 / 任务（状态小点、
 * 更多、已归档）、归档列表的恢复、⌘K 搜到归档的与「让 AI 找回」的候选卡（点选才恢复）、
 * 随便聊里的候选卡、设置里的自动归档天数。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { AssistantMessage } from '@/components/free-chat/message'
import { ArchiveSetting } from '@/components/settings/archive-setting'
import type { Me, PositionInstanceData, PositionSummary } from '@/lib/api'
import type { ArchivedWorkCandidate, WorkRail } from '@/lib/work-archive'
import { renderWithProviders } from './helpers'

const h = vi.hoisted(() => {
  const T0 = '2026-09-30T02:00:00.000Z'
  const calls: { fn: string; args: unknown[] }[] = []
  const record =
    <T,>(fn: string, out: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ fn, args })
      return out
    }
  const candidate = {
    matter_id: 'mat_old',
    title: '美国红人样品寄送',
    summary: '样品下周到洛杉矶',
    archived_at: T0,
    last_activity: '2026-09-23T02:00:00.000Z',
    score: 0.9,
    why: ['title:美国红人 样品', 'time:上周'],
  }
  const idle = (id: string, title: string, state = 'idle') => ({
    id,
    title,
    state,
    last_activity: T0,
    cards: state === 'awaiting' ? 1 : 0,
  })
  const RAIL = {
    idle_days: 3,
    positions: [
      {
        position_id: 'kol',
        awaiting: 4,
        duties: [
          {
            role_id: 'kol.youtube',
            matters: [
              idle('mat_1', '在跑的那件', 'running'),
              idle('mat_2', '等你批的', 'awaiting'),
              idle('mat_3', '做完待看', 'ready'),
              idle('mat_4', '第四件'),
              idle('mat_5', '第五件'),
              idle('mat_6', '第六件'),
            ],
            more: 0,
            archived: 2,
          },
        ],
      },
    ],
  }
  return { T0, calls, record, candidate, RAIL, days: { value: 3 as number | null } }
})
const { T0, calls } = h
const candidate = h.candidate as ArchivedWorkCandidate

vi.mock('@/lib/work-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/work-archive')>('@/lib/work-archive')
  return {
    ...actual,
    getWorkRail: async () => h.RAIL as WorkRail,
    listArchivedWork: h.record('listArchivedWork', [
      {
        id: 'mat_old',
        title: '美国红人样品寄送',
        summary: '',
        status: 'open',
        last_activity: h.T0,
        archived_at: h.T0,
        position_template_id: 'kol',
        role_id: 'kol.youtube',
      },
    ]),
    searchWork: h.record('searchWork', [
      {
        id: 'mat_old',
        title: '美国红人样品寄送',
        summary: '',
        status: 'open',
        last_activity: h.T0,
        archived_at: h.T0,
      },
      { id: 'mat_1', title: '红人样品第二批', summary: '', status: 'open', last_activity: h.T0 },
    ]),
    findArchivedWork: h.record('findArchivedWork', { candidates: [h.candidate], semantic: false }),
    unarchiveMatter: h.record('unarchiveMatter', { matter: { id: 'mat_old' } }),
    archiveMatter: h.record('archiveMatter', { matter: { id: 'mat_4' } }),
    getWorkArchiveSettings: async () => ({ idle_days: h.days.value }),
    setWorkArchiveSettings: async (idle_days: number | null) => {
      h.calls.push({ fn: 'setWorkArchiveSettings', args: [idle_days] })
      h.days.value = idle_days
      return { idle_days }
    },
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: async () => ({ accounts: [] }),
    // WP372：右侧面板「对话」按职责分组时要职责名（与外壳同一份）
    getPositions: async () => ({
      positions: [],
      instances: INSTANCES,
      tile_library: [],
      max_tiles: 6,
    }),
    listRoleDefinitions: async () => [
      { id: 'kol.youtube', name: 'YouTube 红人', name_en: 'YouTube', superseded_by: undefined },
      { id: 'kol.tiktok', name: 'TikTok 红人', name_en: 'TikTok' },
      { id: 'common.owner', name: '公司设置与授权', name_en: 'Owner' },
      { id: 'social.meta', name: 'Meta 社媒运营', name_en: 'Meta', superseded_by: ['x'] },
    ],
    listOrgPositions: async () => [
      {
        id: 'kol',
        name: '红人营销',
        name_en: 'Influencer',
        version: '1.0.0',
        source: 'custom',
        roles: [{ role_id: 'kol.youtube', name: 'YouTube 红人', default: true, loaded: true }],
        holders: [{ person_id: 'per_li', name: '李默', ranges: [{ kind: 'store', id: 's1' }] }],
      },
    ],
    createOrgPosition: h.record('createOrgPosition', { id: 'pos-new' }),
    updateOrgPosition: h.record('updateOrgPosition', { id: 'kol' }),
    createAssignments: h.record('createAssignments', []),
    openMatterAtPosition: h.record('openMatterAtPosition', {
      matter: { id: 'mat_new', title: 'x' },
      candidates: [],
      ambiguous: false,
      reason: '',
    }),
  }
})

const INSTANCES: PositionInstanceData[] = [
  {
    position_id: 'kol',
    workspace_id: 'ws_1',
    name: { zh: '红人营销', en: 'Influencer' },
    template_version: '1.0.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'kol.youtube',
        role_name: 'YouTube 红人',
        default: true,
        assignment_ids: ['asg_yt'],
        my_assignment_id: 'asg_yt',
      },
    ],
    open_matters: 6,
    pending_cards: 1,
    memory_summary: '',
  },
]
const POSITIONS: PositionSummary[] = []

const me = (owner: boolean): Me => ({
  person: { id: 'per_li', email: 'li@example.com', name: '李默' },
  workspace: { id: 'ws_1', name: '玻璃碗' },
  assignments: owner
    ? ([{ id: 'asg_owner', role_id: 'common.owner' }] as unknown as Me['assignments'])
    : [],
})

// WP431：右侧面板（卡片堆）只在岗位 / 职责 / 事项页上有——默认在岗位页上测
function renderShell(owner = true, route = '/positions/asg_yt'): void {
  renderWithProviders(
    <AppShell
      positions={POSITIONS}
      instances={INSTANCES}
      cards={[]}
      tileLibrary={[]}
      me={me(owner)}
      onAddTile={() => {}}
    >
      <div>主区</div>
    </AppShell>,
    route,
    'asg_yt',
  )
}

function stubStorage(): void {
  const box = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      box.set(k, v)
    },
    removeItem: (k: string) => {
      box.delete(k)
    },
  })
}

beforeEach(() => {
  calls.length = 0
  h.days.value = 3
  stubStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const called = (fn: string) => calls.filter((c) => c.fn === fn)

describe('WP207 左栏三级「+」', () => {
  it('所有者：标题旁常显「+」，岗位 / 职责行各有一个（都有 tooltip 那句话，键盘可达）', async () => {
    renderShell(true)
    const header = screen.getByTestId('rail-new-position-plus')
    expect(header.getAttribute('aria-label')).toBe('新建岗位')
    expect(header.className).not.toContain('opacity-0')
    const addDuty = screen.getByTestId('rail-add-duty-plus')
    expect(addDuty.getAttribute('aria-label')).toBe('给「红人营销」加职责')
    // 悬停才出现：平时透明，但仍是一个能 Tab 到的按钮
    expect(addDuty.className).toContain('opacity-0')
    expect(addDuty.className).toContain('focus-visible:opacity-100')
    // WP456-T3（§3.2）：职责行右边不再挂「+」（开新对话走职责页看板「对话」卡头的「+」）
    expect(screen.queryByTestId('rail-new-matter')).toBeNull()
  })

  it('不是所有者：看不到新建岗位与加职责的「+」（WP456-T3 起职责行也不挂「+」）', () => {
    renderShell(false)
    expect(screen.queryByTestId('rail-new-position-plus')).toBeNull()
    expect(screen.queryByTestId('rail-add-duty-plus')).toBeNull()
    expect(screen.queryByTestId('rail-new-matter')).toBeNull()
  })

  it('新建岗位：就地填名字、勾职责（拆过的老职责不列），建完分给自己', async () => {
    const user = userEvent.setup()
    renderShell(true)
    await user.click(screen.getByTestId('rail-new-position-plus'))
    const form = await screen.findByTestId('rail-new-position')
    await user.type(within(form).getByTestId('rail-new-position-name'), '红人营销二组')
    const roles = await within(form).findAllByTestId('rail-new-position-role')
    expect(roles.map((r) => r.getAttribute('data-role'))).toEqual(['kol.youtube', 'kol.tiktok'])
    await user.click(roles[1] as HTMLElement)
    await user.click(within(form).getByTestId('rail-new-position-save'))
    await waitFor(() => {
      expect(called('createAssignments')).toHaveLength(1)
    })
    expect(called('createOrgPosition')[0]?.args).toEqual([
      { name: '红人营销二组', roles: [{ role_id: 'kol.tiktok', default: true }] },
      'asg_owner',
    ])
    expect(called('createAssignments')[0]?.args).toEqual([
      { person_id: 'per_li', position_id: 'pos-new', ranges: [] },
      'asg_owner',
    ])
    await waitFor(() => {
      expect(screen.queryByTestId('rail-new-position')).toBeNull()
    })
  })

  it('加职责：只列这个岗位还没有的；存的时候原有职责带上，新职责分给自己（范围沿用）', async () => {
    const user = userEvent.setup()
    renderShell(true)
    fireEvent.click(screen.getByTestId('rail-add-duty-plus'))
    const box = await screen.findByTestId('rail-add-duty')
    const roles = await within(box).findAllByTestId('rail-add-duty-role')
    expect(roles.map((r) => r.getAttribute('data-role'))).toEqual(['kol.tiktok'])
    await user.click(roles[0] as HTMLElement)
    await user.click(within(box).getByTestId('rail-add-duty-save'))
    await waitFor(() => {
      expect(called('createAssignments')).toHaveLength(1)
    })
    expect(called('updateOrgPosition')[0]?.args).toEqual([
      'kol',
      {
        name: '红人营销',
        roles: [
          { role_id: 'kol.youtube', default: true },
          { role_id: 'kol.tiktok', default: true },
        ],
      },
      'asg_owner',
    ])
    expect(called('createAssignments')[0]?.args).toEqual([
      { person_id: 'per_li', role_id: 'kol.tiktok', ranges: [{ kind: 'store', id: 's1' }] },
      'asg_owner',
    ])
  })

  it('职责页看板「对话」卡头「+」（WP456-T3，原左栏职责行「+」）：开好新对话那一格，写一句回车 = 交给这条职责', async () => {
    const user = userEvent.setup()
    renderShell(true, '/positions/asg_yt/duties/kol.youtube')
    fireEvent.click(await screen.findByTestId('rail-card-action-conversations'))
    const input = await screen.findByTestId('conv-compose-input')
    await user.type(input, '联系 Jake 要新视频的数据{Enter}')
    await waitFor(() => {
      expect(called('openMatterAtPosition')).toHaveLength(1)
    })
    expect(called('openMatterAtPosition')[0]?.args).toEqual([
      'asg_yt',
      { title: '联系 Jake 要新视频的数据', role_id: 'kol.youtube' },
    ])
  })
})

describe('WP259 一句话交给职责：长文本照收（WP372 起在右侧面板「新对话」那一格）', () => {
  it('一大段：标题取第一句…，完整原文作描述（原来截到 200 字）', async () => {
    renderShell(true, '/positions/asg_yt/duties/kol.youtube')
    fireEvent.click(await screen.findByTestId('rail-card-action-conversations'))
    const input = await screen.findByTestId('conv-compose-input')
    const text = `联系 Jake 要新视频的数据。${'顺便问他下个月能不能再排一条合作视频，'.repeat(8)}`
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(screen.getByTestId('conv-compose'))
    await waitFor(() => {
      expect(called('openMatterAtPosition')).toHaveLength(1)
    })
    expect(called('openMatterAtPosition')[0]?.args).toEqual([
      'asg_yt',
      { title: '联系 Jake 要新视频的数据…', summary: text, role_id: 'kol.youtube' },
    ])
  })
})

/** WP372：对话不挂左栏了——在右侧面板「对话」卡里，卡底「显示更多」是完整列表。WP433：面板一直在，没有开关。 */
async function openConversations(more = false): Promise<HTMLElement> {
  const card = await screen.findByTestId('conv-card')
  if (!more) return card
  fireEvent.click(await screen.findByTestId('rail-card-more-conversations'))
  return screen.findByTestId('conv-panel')
}

describe('WP207 职责下的对话 / 任务（WP372 起在右侧面板「对话」）', () => {
  it('卡上最多 5 条（WP433）、等你看的排最上；完整列表每条都在、按职责分组，「已归档 n」在组底下；左栏不挂', async () => {
    renderShell(true)
    expect(screen.queryByTestId('rail-matter')).toBeNull()
    const card = await openConversations()
    const rows = await within(card).findAllByTestId('conv-link')
    expect(rows.map((r) => r.querySelector('.flex-1')?.textContent)).toEqual([
      '等你批的',
      '做完待看',
      '在跑的那件',
      '第四件',
      '第五件',
    ])
    const marks = within(card).getAllByTestId('conv-marker')
    expect(marks.map((d) => d.getAttribute('aria-label'))).toEqual(['等你看', '等你看', '正在做'])
    expect(rows[2]?.getAttribute('href')).toBe('/matters/mat_1')
    // WP351（决策 906）：岗位行不挂数字
    expect(screen.queryByTestId('nav-position-pending')).toBeNull()
    fireEvent.click(await screen.findByTestId('rail-card-more-conversations'))
    const panel = await screen.findByTestId('conv-panel')
    await waitFor(() => {
      expect(within(panel).getAllByTestId('conv-link')).toHaveLength(6)
    })
    expect(within(panel).getByTestId('conv-archived').textContent).toBe('已归档 2')
  })

  it('已归档列表：筛好这条职责，点「恢复」一次一件（by=user）', async () => {
    const user = userEvent.setup()
    renderShell(true)
    const panel = await openConversations(true)
    await user.click(await within(panel).findByTestId('conv-archived'))
    const dialog = await screen.findByTestId('archived-dialog')
    await within(dialog).findByText('美国红人样品寄送')
    expect(called('listArchivedWork')[0]?.args[0]).toEqual({
      position_id: 'kol',
      role_id: 'kol.youtube',
    })
    await user.click(within(dialog).getByTestId('archived-restore'))
    await waitFor(() => {
      expect(called('unarchiveMatter')).toHaveLength(1)
    })
    expect(called('unarchiveMatter')[0]?.args).toEqual(['mat_old', 'user'])
  })
})

describe('WP207 ⌘K：搜到归档的、让 AI 找回', () => {
  it('打字就搜对话与任务，归档的标「已归档」；「让 AI 找回」给候选卡，点一张才恢复（by=ai_suggested）', async () => {
    const user = userEvent.setup()
    renderShell(true)
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    const input = await screen.findByPlaceholderText('搜索事项、对话、岗位、设置…')
    await user.type(input, '红人样品')
    const works = await screen.findAllByTestId('command-work')
    // 顺序交给 cmdk 按匹配度排；这里只认「哪条标了已归档」
    const flags = Object.fromEntries(
      works.map((w) => [
        // WP431：每行右边是时间 / 「已归档」，标题是第一个 span
        w.querySelector('span')?.textContent ?? '',
        w.getAttribute('data-archived'),
      ]),
    )
    expect(flags).toEqual({ 美国红人样品寄送: 'true', 红人样品第二批: null })
    expect(works.find((w) => w.getAttribute('data-archived') === 'true')?.textContent).toContain(
      '已归档',
    )
    expect(called('searchWork')[0]?.args).toEqual(['红人样品', 8])
    // 找回：只给候选，不恢复
    fireEvent.click(screen.getByTestId('command-recall-item'))
    const cards = await screen.findAllByTestId('recall-card')
    expect(called('findArchivedWork')[0]?.args).toEqual(['红人样品'])
    expect(called('unarchiveMatter')).toHaveLength(0)
    expect(cards[0]?.textContent).toContain('美国红人样品寄送')
    expect(cards[0]?.textContent).toContain('标题里有「美国红人 样品」')
    fireEvent.click(cards[0] as HTMLElement)
    await waitFor(() => {
      expect(called('unarchiveMatter')).toHaveLength(1)
    })
    expect(called('unarchiveMatter')[0]?.args).toEqual(['mat_old', 'ai_suggested'])
  })
})

describe('WP207 随便聊里的候选卡与设置', () => {
  it('回复带着候选时画成卡片，点一张才恢复', async () => {
    renderWithProviders(
      <AssistantMessage
        message={{
          id: 'fmsg_1',
          session_id: 'fchat_1',
          role: 'assistant',
          text: '找到这几个，点一下就放回左栏。',
          at: T0,
          archived_candidates: [candidate, { ...candidate, matter_id: 'mat_b', title: '红人报价' }],
        }}
        last
        onRegenerate={() => {}}
      />,
    )
    const box = screen.getByTestId('free-chat-recall')
    const cards = within(box).getAllByTestId('recall-card')
    expect(cards).toHaveLength(2)
    expect(called('unarchiveMatter')).toHaveLength(0)
    fireEvent.click(cards[1] as HTMLElement)
    await waitFor(() => {
      expect(called('unarchiveMatter')[0]?.args).toEqual(['mat_b', 'ai_suggested'])
    })
  })

  it('设置 → 通用：自动归档 1–30 天或不自动归档', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ArchiveSetting />)
    const select = (await screen.findByTestId('settings-archive-days')) as HTMLSelectElement
    expect(select.value).toBe('3')
    expect(select.options).toHaveLength(31)
    await user.selectOptions(select, 'never')
    await waitFor(() => {
      expect(called('setWorkArchiveSettings')[0]?.args).toEqual([null])
    })
  })
})

describe('WP207 手动归档（Fable 09-30；WP372 起在右侧面板「对话」里）', () => {
  it('悬停菜单「归档」→ 底部「已归档…· 撤销」；撤销 = 恢复这一件', async () => {
    renderShell(true)
    const rows = await within(await openConversations()).findAllByTestId('conv-link')
    const fourth = rows[3]?.closest('li') as HTMLElement
    fireEvent.click(within(fourth).getByTestId('rail-matter-menu'))
    fireEvent.click(within(fourth).getByTestId('rail-matter-archive'))
    await waitFor(() => {
      expect(called('archiveMatter')[0]?.args).toEqual(['mat_4'])
    })
    const bar = await screen.findByTestId('rail-undo')
    expect(bar.textContent).toContain('已归档「第四件」')
    fireEvent.click(within(bar).getByTestId('rail-undo-button'))
    await waitFor(() => {
      expect(called('unarchiveMatter')[0]?.args).toEqual(['mat_4', 'user'])
    })
  })

  it('在跑的、有卡等你批的：「归档」置灰，问号里说为什么', async () => {
    renderShell(true)
    const rows = await within(await openConversations()).findAllByTestId('conv-link')
    for (const [i, why] of [
      [2, 'AI 还在跑这件事，跑完才能归档'],
      [0, '这件事还有卡等你批，批完才能归档'],
    ] as const) {
      const li = rows[i]?.closest('li') as HTMLElement
      fireEvent.click(within(li).getByTestId('rail-matter-menu'))
      expect((within(li).getByTestId('rail-matter-archive') as HTMLButtonElement).disabled).toBe(
        true,
      )
      expect(within(li).getByTestId('rail-matter-archive-why').getAttribute('aria-label')).toBe(why)
    }
    expect(called('archiveMatter')).toHaveLength(0)
  })

  it('左栏新建岗位 / 加职责不列底座职责（common.*）', async () => {
    renderShell(true)
    fireEvent.click(screen.getByTestId('rail-new-position-plus'))
    const roles = await screen.findAllByTestId('rail-new-position-role')
    expect(roles.map((r) => r.getAttribute('data-role'))).not.toContain('common.owner')
  })
})
