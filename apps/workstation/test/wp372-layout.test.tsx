/**
 * WP372（决策 1001–1005 / 1019，Luoye 10-17）布局重排：
 *
 * - 左栏两层（岗位 500 字重 / 职责挂细竖线、13px、次要色），当前岗位默认展开、其余收着，对话不挂左栏；
 * - 右上角一排：六张卡各一个图标（对话 / 报表 / 产出 / 计划 / 连接 / 设定），「⋮」= 全部卡片 + 浏览器 / 变更审阅 / 教程；
 * - 右侧面板：默认只展开「对话」，收起的卡标题行一句摘要；点图标开到那张卡；展开最多 4 条 +「显示更多」；
 *   状态点（红 = 连接没连上，黄 = 对话等你看）卡上与图标上一起亮；顺序按人记住；
 * - 连接卡（决策 690）按地址开 = 展开「连接」卡、那一条在最上面；
 * - 对话列表按「今天 / 本周 / 更早」分组、岗位层按职责分组；「+ 新对话」一句话交给这条职责；
 * - 报表卡：摘要是最新一份的名字与日期，点一份在面板里看；面板能加宽、宽度记住；
 * - 顶栏没有「交给某个岗位一件事」搜索框。
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import type { WorkRail } from '@/lib/work-archive'
import { openRailCard, renderWithProviders } from './helpers'

const NOW = new Date()
const iso = (daysAgo: number): string =>
  new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: unknown[] }[],
  connected: false,
}))

const INSTANCES: PositionInstanceData[] = [
  {
    position_id: 'reddit-ops',
    workspace_id: 'ws_1',
    name: { zh: 'Reddit 运营', en: 'Reddit Ops' },
    template_version: '1.0.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'social.reddit',
        role_name: '官方版块',
        default: true,
        assignment_ids: ['asg_own'],
        my_assignment_id: 'asg_own',
      },
      {
        role_id: 'pr.reddit',
        role_name: '外部版块',
        default: true,
        assignment_ids: ['asg_ext'],
        my_assignment_id: 'asg_ext',
      },
    ],
    open_matters: 3,
    pending_cards: 0,
    memory_summary: '',
  },
  {
    position_id: 'support',
    workspace_id: 'ws_1',
    name: { zh: '客服', en: 'Support' },
    template_version: '1.0.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'dtc.support',
        role_name: '售后',
        default: true,
        assignment_ids: ['asg_sup'],
        my_assignment_id: 'asg_sup',
      },
    ],
    open_matters: 0,
    pending_cards: 0,
    memory_summary: '',
  },
]

const matter = (id: string, title: string, state: string, daysAgo: number) => ({
  id,
  title,
  state,
  last_activity: iso(daysAgo),
  cards: 0,
})

const RAIL = (): WorkRail =>
  ({
    idle_days: 3,
    positions: [
      {
        position_id: 'reddit-ops',
        awaiting: 1,
        duties: [
          {
            role_id: 'social.reddit',
            matters: [
              matter('m_1', '今天的新帖', 'running', 0),
              matter('m_2', '置顶帖草稿', 'awaiting', 0),
              matter('m_3', '上周的版规', 'idle', 9),
              matter('m_4', '第四件', 'idle', 20),
              matter('m_5', '第五件', 'idle', 30),
            ],
            more: 0,
            archived: 2,
          },
          {
            role_id: 'pr.reddit',
            matters: [matter('m_9', '外面那条帖', 'idle', 1)],
            more: 0,
            archived: 0,
          },
        ],
      },
    ],
  }) as WorkRail

vi.mock('@/lib/work-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/work-archive')>('@/lib/work-archive')
  return { ...actual, getWorkRail: async () => RAIL() }
})

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    getFreeChatModels: async () => ({
      choices: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', official: true, vision: 'no' }],
      default: 'deepseek-v4-pro',
      web_search: { available: false, max_searches: 0 },
      knowledge: { available: false },
    }),
  }
})

vi.mock('@/lib/outbound-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbound-api')>('@/lib/outbound-api')
  return { ...actual, listSinks: async () => [] }
})

const REPORT_CARD = {
  id: 'apr_report_1',
  kind: 'weekly_review',
  title: '周报',
  summary: '10-06 – 10-12',
  detail: {
    payload: {
      kind: 'report',
      series: '周报',
      title: '周报',
      period: '10-06 – 10-12',
      markdown: '## 本周\n\n- 新帖 12 条\n',
      published_at: '2026-10-12T09:00:00.000Z',
      version: 1,
    },
    created_at: '2026-10-12T09:00:00.000Z',
  },
}

/** WP438：看板「报表」卡的一行（AI 做的那份，固定在这条职责上）。 */
const REDDIT_REPORT = {
  id: 'rpt_1',
  title: 'Reddit 运营报表',
  position: 'reddit-ops',
  origin: 'ai',
  refresh: 'weekly',
  headline_label: '近 30 天品牌被提到',
  headline: {
    key: 'mentions',
    label: '品牌被提到',
    format: 'count',
    source: 'pr',
    status: 'ok',
    value: 138,
    previous: 105,
    delta: 31.4,
    delta_unit: 'pct',
  },
  spark: [1, 3, 2, 5],
}

vi.mock('@/lib/reports-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reports-api')>('@/lib/reports-api')
  return {
    ...actual,
    listReports: async (input: { position: string; duty?: string }) => ({
      reports: input.duty === 'social.reddit' ? [REDDIT_REPORT] : [],
      limit: 5,
      examples: [],
    }),
    getReport: async () => ({
      id: 'rpt_1',
      title: 'Reddit 运营报表',
      position: 'reddit-ops',
      origin: 'ai',
      refresh: 'weekly',
      range: '30d',
      period: { from: '2026-09-21', to: '2026-10-20', compare_from: '', compare_to: '' },
      computed_at: '2026-10-21T01:00:00.000Z',
      blocks: [],
    }),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: async () => ({ accounts: [] }),
    getPositions: async () => ({
      positions: [],
      instances: INSTANCES,
      tile_library: [],
      max_tiles: 6,
    }),
    getPositionCards: async (id: string) => ({
      position: {},
      cards: [],
      counts: { total: 0, customer_waiting: 0, nobody_waiting: 0, matched: 0 },
      pinned_p0: [],
      filters: {},
      reports: id === 'asg_own' ? [REPORT_CARD] : [],
    }),
    getPositionConnections: async () => ({
      position_id: 'reddit-ops',
      position_name: 'Reddit 运营',
      ready: h.connected,
      missing_required: h.connected ? [] : ['reddit'],
      items: [
        {
          kind: 'reddit',
          name: { zh: 'Reddit', en: 'Reddit' },
          required: true,
          connected: h.connected,
          needed_by: ['官方版块', '外部版块'],
          status: 'available',
          connect_service: 'reddit',
        },
      ],
    }),
    getMySchedules: async () => [],
    getPositionRecords: async () => ({ status: 'ok', payload: { rows: [] } }),
    openMatterAtPosition: async (...args: unknown[]) => {
      h.calls.push({ fn: 'openMatterAtPosition', args })
      return { matter: { id: 'mat_new', title: 'x' }, candidates: [], ambiguous: false, reason: '' }
    },
  }
})

const { AppShell } = await import('@/components/app-shell')
const { useRailState } = await import('@/components/rail/rail-state')
const { connectAddress } = await import('@/components/setup/use-open-connect')
const { groupByTime } = await import('@/components/conversations/conversation-data')
const { listRailCards, resetPanelRegistry } = await import('@/components/rail/registry')
const { ensureBuiltinPanels } = await import('@/components/rail/builtin-panels')

function stubStorage(): Map<string, string> {
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
  return box
}

/** 主区里放一个能按地址开右侧面板的按钮（模拟「去连接」）。 */
function ConnectButton(): React.ReactNode {
  const rail = useRailState()
  return (
    <button
      type="button"
      data-testid="go-connect"
      onClick={() => {
        rail.openAddress(connectAddress(['reddit']))
      }}
    >
      去连接
    </button>
  )
}

function renderShell(
  route = '/positions/asg_own/duties/social.reddit',
  position = 'asg_own',
): void {
  renderWithProviders(
    <AppShell positions={[]} instances={INSTANCES} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
      <ConnectButton />
    </AppShell>,
    route,
    position,
  )
}

beforeEach(() => {
  h.calls.length = 0
  h.connected = false
  stubStorage()
})

describe('左栏两层（决策 1001）', () => {
  it('当前岗位展开、其余收着；职责挂在细竖线上、13px 次要色；对话不在左栏', () => {
    renderShell()
    const rows = screen.getAllByTestId('nav-position-row')
    expect(rows.map((r) => r.getAttribute('data-position'))).toEqual(['reddit-ops', 'support'])
    const [first, second] = rows as [HTMLElement, HTMLElement]
    const duties = within(first).getByTestId('nav-duties')
    expect(duties.className).toContain('border-l')
    expect(
      within(duties)
        .getAllByTestId('nav-duty')
        .map((d) => d.textContent),
    ).toEqual(['官方版块', '外部版块'])
    const idle = within(duties).getAllByTestId('nav-duty')[1] as HTMLElement
    expect(idle.className).toContain('text-[13px]')
    expect(idle.className).toContain('text-ws-muted-fg')
    expect(within(first).getByTestId('nav-position').className).toContain('font-medium')
    expect(within(second).queryByTestId('nav-duties')).toBeNull()
    // 不显示数字（WP351）；对话不挂左栏
    expect(screen.queryByTestId('rail-threads')).toBeNull()
    expect(screen.queryByTestId('rail-matter')).toBeNull()
  })
})

describe('右上角一排、「⋮」与面板开关（决策 1001 / 1020 → 1035 → WP412）', () => {
  it('WP412：右上角是露出的工具 +「⋮」+ 面板开关（不再重复放卡片图标）；没有搜索框；教程在「⋮」里', async () => {
    renderShell()
    const bar = screen.getByTestId('right-rail')
    const icons = within(bar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'))
    // WP431（照 Claude）：面板开关在最左（岗位 / 职责 / 事项页才有），后面一条细竖线；
    // WP429：通知铃铛在变更审阅之后、「⋮」之前（外壳的 top-bar-bell-slot）
    expect(icons).toEqual(
      screen.queryByTestId('rail-toggle') === null
        ? ['rail-icon-browser', 'rail-icon-changes', 'notify-bell', 'rail-overflow']
        : ['rail-toggle', 'rail-icon-browser', 'rail-icon-changes', 'notify-bell', 'rail-overflow'],
    )
    expect(screen.queryByTestId('top-command')).toBeNull()
    fireEvent.click(screen.getByTestId('rail-overflow'))
    fireEvent.click(await screen.findByTestId('rail-menu-help'))
    expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('help')
  })

  it('连接没连上：「连接」卡标题后亮红点（WP433：顶栏不再有面板开关与汇总点）', async () => {
    renderShell()
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
    const card = await openRailCard('connections')
    expect(within(card).getByTestId('rail-card-dot-connections').getAttribute('data-dot')).toBe(
      'alert',
    )
    // WP456-T3（决策 1448）：「连接」在清单卡里——点那一行在第三栏开连接那一格，要处理的排最上，带「去连接」
    fireEvent.click(screen.getByTestId('rail-list-row-connections'))
    const panel = await screen.findByTestId('connections-panel')
    const row = await within(panel).findByTestId('connection-row', {}, { timeout: 5000 })
    expect(row.getAttribute('data-todo')).toBe('true')
  })
})

describe('右侧面板六张卡（决策 1004 / 1019 / 1035）', () => {
  it('职责页默认开成卡片堆：默认展开对话与计划、其余收起带摘要；报表一行一份（WP438），AI 写的周报在「产出」里', async () => {
    renderShell()
    const stack = await screen.findByTestId('rail-cards')
    expect(stack.getAttribute('data-order')).toBe(
      // WP390：第七张「工坊服务」排在最下面
      // WP456-T3（决策 1448）：有内容的三张在前（可拖），产出 / 连接 / 设定 / 工坊服务在最底下那张清单卡里
      'conversations,reports,plans,outputs,connections,settings,workshop-services',
    )
    for (const id of ['conversations', 'plans'])
      expect(screen.getByTestId(`rail-card-${id}`).getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('rail-card-reports').getAttribute('data-open')).toBe('false')
    const list = screen.getByTestId('rail-list-card')
    for (const id of ['outputs', 'connections', 'settings'])
      expect(within(list).getByTestId(`rail-list-row-${id}`)).toBeTruthy()
    expect((await screen.findByTestId('rail-card-summary-settings')).textContent).toBe(
      'DeepSeek V4 Pro',
    )
    expect((await screen.findByTestId('rail-card-summary-connections')).textContent).toBe(
      '1 个要处理',
    )
    // WP438：报表卡收着时写「几份」；卡头有「+」
    expect((await screen.findByTestId('rail-card-summary-reports')).textContent).toBe('1 份')
    expect(screen.getByTestId('rail-card-action-reports')).toBeTruthy()
    // 展开：一行 = 名字 + AI 标 + 头条数 + 涨跌；点了在第三栏拉出整页
    fireEvent.click(screen.getByTestId('rail-card-toggle-reports'))
    const row = await screen.findByTestId('report-row', {}, { timeout: 5000 })
    expect(row.textContent).toContain('Reddit 运营报表')
    expect(row.textContent).toContain('138')
    expect(row.textContent).toContain('↑31.4%')
    expect(within(row).getByTestId('report-ai-tag')).toBeTruthy()
    fireEvent.click(within(row).getAllByRole('button')[0] as HTMLElement)
    expect(await screen.findByTestId('report-page', {}, { timeout: 5000 })).toBeTruthy()
    // AI 写的周报正文不算报表，归「产出」（WP456-T3：清单卡那一行 → 第三栏「产出 → 记录」最上面）
    fireEvent.click(screen.getByTestId('rail-list-row-outputs'))
    const doc = await screen.findByTestId('output-doc-row', {}, { timeout: 5000 })
    expect(doc.textContent).toContain('周报')
    fireEvent.click(doc)
    const view = await screen.findByTestId('report-view')
    expect(view.textContent).toContain('新帖 12 条')
  })

  it('对话卡：最多 5 条（WP433）、等你看的排最上（黄点）、在做的转圈；「显示更多」= 按今天 / 本周 / 更早分组', async () => {
    renderShell()
    const box = await openRailCard('conversations')
    const card = await within(box).findByTestId('conv-card')
    const rows = await within(card).findAllByTestId('conv-link')
    expect(rows).toHaveLength(5)
    // WP456-T3（§3.9）：每行「图标 + 名字 + 灰色时间」
    expect(rows[0]?.textContent).toContain('置顶帖草稿')
    expect(within(rows[0] as HTMLElement).getByTestId('conv-when')).toBeTruthy()
    expect(
      within(rows[0] as HTMLElement)
        .getByTestId('conv-marker')
        .getAttribute('data-state'),
    ).toBe('awaiting')
    expect(
      within(rows[1] as HTMLElement)
        .getByTestId('conv-marker')
        .getAttribute('data-state'),
    ).toBe('running')
    expect(screen.getByTestId('rail-card-dot-conversations').getAttribute('data-dot')).toBe(
      'attention',
    )
    fireEvent.click(screen.getByTestId('rail-card-more-conversations'))
    const panel = await screen.findByTestId('conv-panel')
    expect(panel.getAttribute('data-tier')).toBe('role')
    const groups = within(panel)
      .getAllByTestId('conv-group')
      .map((g) => g.getAttribute('data-group'))
    expect(groups[0]).toBe('today')
    expect(groups).toContain('earlier')
    // 搜索
    fireEvent.change(within(panel).getByTestId('conv-search'), { target: { value: '版规' } })
    expect(
      within(panel)
        .getAllByTestId('conv-link')
        .map((r) => r.querySelector('.flex-1')?.textContent),
    ).toEqual(['上周的版规'])
  })

  it('岗位总览：对话按职责分组列全部', async () => {
    renderShell('/positions/asg_own')
    await openRailCard('conversations')
    fireEvent.click(await screen.findByTestId('rail-card-more-conversations'))
    const panel = await screen.findByTestId('conv-panel')
    expect(panel.getAttribute('data-tier')).toBe('position')
    await waitFor(() => {
      expect(
        within(panel)
          .getAllByTestId('conv-duty-title')
          .map((x) => x.textContent),
      ).toEqual(['官方版块', '外部版块'])
    })
  })

  it('「+ 新对话」：一句话交给这条职责（岗位入口那条路，带职责）', async () => {
    renderShell()
    await openRailCard('conversations')
    // WP456-T3（§3.9）：「+ 新对话」挪到卡头右边
    fireEvent.click(screen.getByTestId('rail-card-action-conversations'))
    const input = await screen.findByTestId('conv-compose-input')
    fireEvent.change(input, { target: { value: '起草一条置顶' } })
    fireEvent.submit(screen.getByTestId('conv-compose'))
    await waitFor(() => {
      expect(h.calls.filter((c) => c.fn === 'openMatterAtPosition')).toHaveLength(1)
    })
    expect(h.calls[0]?.args).toEqual([
      'asg_own',
      { title: '起草一条置顶', role_id: 'social.reddit' },
    ])
  })

  it('WP456-T3（§3.2）：左栏职责行不再挂「+」；对话卡头「+」开新对话那一格（卡片列属于中栏、第三栏不开）', async () => {
    renderShell()
    expect(screen.queryByTestId('rail-new-matter')).toBeNull()
    fireEvent.click(await screen.findByTestId('rail-card-action-conversations'))
    expect(await screen.findByTestId('conv-compose-input')).toBeTruthy()
    expect(screen.getByTestId('rail-board')).toBeTruthy()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })

  it('连接卡（决策 690）弹出：WP456-T3 起在第三栏开「连接」那一格，连接卡在最上面', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('go-connect'))
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-panel')).toBe('connections')
    expect(await within(frame).findByTestId('connections-live')).toBeTruthy()
    // 卡片列（属于中栏）还在
    expect(screen.getByTestId('rail-cards')).toBeTruthy()
  })

  it('展开态按作用域记住；卡顺序按人记住（全部岗位一份）', async () => {
    const box = stubStorage()
    box.set('agentsws.rightrail.card_order', JSON.stringify(['settings', 'conversations']))
    renderShell()
    await openRailCard('reports')
    const stack = await screen.findByTestId('rail-cards')
    // WP456-T3：清单卡里的那几张（设定……）排在最底下那一张里（照记住的先后），不参与拖动
    expect(stack.getAttribute('data-order')).toBe(
      'conversations,reports,plans,settings,outputs,connections,workshop-services',
    )
    const saved = JSON.parse(box.get('agentsws.rightrail.cards') ?? '{}') as Record<
      string,
      Record<string, boolean>
    >
    expect(saved['role:social.reddit']).toEqual({ reports: true })
    // 每张卡都有拖动手柄（键盘也落得到）
    const handle = screen.getByTestId('rail-card-handle-plans')
    expect(handle.tagName).toBe('BUTTON')
    expect(handle.getAttribute('aria-label')).toContain('拖动「计划」')
  })

  it('WP433：「显示更多」开在卡片列右边的第三栏——右上 × 收起、没有放大钮；宽度靠拖左边缘，键盘也调得动，记住', async () => {
    const box = stubStorage()
    renderShell()
    // WP456-T3：「设定」在清单卡里，点那一行进第三栏那一格
    fireEvent.click(await screen.findByTestId('rail-list-row-settings'))
    await screen.findByTestId('rail-panel-frame')
    expect(screen.queryByTestId('rail-panel-wide')).toBeNull()
    // 卡片列还在（属于中栏），第三栏开在它右边
    expect(screen.getByTestId('rail-cards')).toBeTruthy()
    const handle = screen.getByTestId('rail-resize')
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(screen.getByTestId('rail-panel-frame').style.width).toBe('720px')
    expect(box.get('agentsws.rightrail.layout')).toContain('720')
    fireEvent.click(screen.getByTestId('rail-panel-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
    expect(screen.getByTestId('rail-cards')).toBeTruthy()
  })
})

describe('积木', () => {
  it('分组：今天 / 本周 / 更早（空组不出）', () => {
    const now = new Date(2026, 9, 17, 15, 0) // 周六
    const at = (d: Date) => ({
      id: d.toISOString(),
      title: '',
      state: 'idle' as const,
      last_activity: d.toISOString(),
      cards: 0,
    })
    const groups = groupByTime(
      [at(new Date(2026, 9, 17, 9)), at(new Date(2026, 9, 13, 9)), at(new Date(2026, 9, 1, 9))],
      now,
    )
    expect(groups.map((g) => g.group)).toEqual(['today', 'week', 'earlier'])
  })

  it('卡的顺序：记住的在前、认不出的跳过、新加的按默认接在后面', () => {
    resetPanelRegistry()
    ensureBuiltinPanels()
    expect(listRailCards(['plans', 'nope', 'plans']).map((c) => c.id)).toEqual([
      'plans',
      'conversations',
      'reports',
      'outputs',
      'connections',
      'settings',
      'workshop-services',
    ])
    act(() => undefined)
  })
})
