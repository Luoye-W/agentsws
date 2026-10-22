/**
 * WP438（WP434 设计 §2，决策 1332 / 1333）：首页四块——问候 + 一行概况 / 要你定（最多 3 条）/
 * 关键数字（一句话 + 4 个数，点了在第三栏开报表）/ 岗位卡。去掉复盘四格、去连接卡堆、按职责重复的数字、
 * 空的时间轴 / 到期、目标网格。唯一的输入框是 WP437 的简易对话框（悬浮在页面底部居中）。
 *
 * 三种模式（决策 222）：「正在进行」「待认领」在同事互联 / 公司集体时照旧接在最下面。
 */

import type { ReportMetricValue } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import type { ReportsOverview } from '@/lib/reports-api'
import { draftCard, homeData } from './fixtures'
import { renderWithProviders } from './helpers'
import { inboxView } from './inbox-fixtures'
import { COMPANY_ORG, companyWordsIn, SOLO_ORG } from './mode-words'

const instance = (
  id: string,
  name: string,
  role_id: string,
  assignment: string,
  counts: { open_matters?: number; pending_cards?: number } = {},
): PositionInstanceData => ({
  position_id: id,
  workspace_id: 'ws_1',
  name: { zh: name, en: name },
  template_version: '1.0.0',
  holders: [],
  roles: [
    {
      role_id,
      role_name: name,
      default: true,
      assignment_ids: [assignment],
      my_assignment_id: assignment,
    },
  ],
  open_matters: counts.open_matters ?? 0,
  pending_cards: counts.pending_cards ?? 0,
  memory_summary: '',
})

const metric = (over: Partial<ReportMetricValue>): ReportMetricValue => ({
  key: 'sales',
  label: '销售额',
  format: 'currency',
  currency: 'USD',
  source: 'shop',
  status: 'ok',
  value: 1684,
  previous: 1500,
  delta: 12.3,
  delta_unit: 'pct',
  ...over,
})

const overview = (range: string): ReportsOverview => ({
  range: range as ReportsOverview['range'],
  key: [
    {
      position: 'web-ops',
      report_id: 'web-ops.business',
      metric: metric({}),
      spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    },
    {
      position: 'customer-care',
      report_id: 'customer-care.service',
      metric: {
        key: 'pending_replies',
        label: '待回复',
        format: 'count',
        source: 'approvals',
        status: 'ok',
        value: 4,
      },
    },
  ],
  sentence: {
    text: '昨天销售额 **$1,684**，比前一天 **+12.3%**；单子最多来自自然搜索。',
    report_id: 'web-ops.business',
    title: '网站经营数据报表',
  },
  missing: { label: '广告后台', source: 'ads', unlocks: '广告回报 ROAS' },
  positions: [
    {
      position: 'web-ops',
      report_id: 'web-ops.business',
      title: '网站经营数据报表',
      headline_label: '近 30 天销售额',
      headline: metric({ value: 48210 }),
      spark: [1, 2, 3],
    },
  ],
})

/** WP466：接口里照旧带着系统卡（原首页告警区）——首页不该把它们画出来。 */
const homeAlerts: { cards: ReturnType<typeof draftCard>[] } = { cards: [] }
const getHome = vi.fn(async () =>
  homeData({
    queue: [
      draftCard({ id: 'a', title: '第一件' }),
      draftCard({ id: 'b', title: '第二件', priority_band: 'P0' }),
      draftCard({ id: 'c', title: '第三件' }),
      draftCard({ id: 'd', title: '第四件' }),
    ],
    alerts: homeAlerts.cards,
  }),
)
const getReportsOverview = vi.fn(async (range: string) => overview(range))
const openRightPane = vi.fn()

const getPositions = vi.fn(async () => ({
  positions: [{ position_id: 'asg_owner', role_id: 'common.owner' }],
  instances: [
    instance('web-ops', '网站运营', 'dtc.store', 'asg_2', { pending_cards: 3 }),
    instance('customer-care', '客服', 'dtc.support', 'asg_1', { open_matters: 1 }),
    instance('design', '设计', 'design.dtc', 'asg_3'),
  ],
  tile_library: [],
  max_tiles: 4,
}))

const modeState: { orgs: (typeof SOLO_ORG)[]; pool: unknown[] } = { orgs: [], pool: [] }
const inboxState = { view: inboxView() }
/** WP469：首页「今天 N 件待办」那一行读的待办 */
const todoState: { todos: unknown[] } = { todos: [] }

function LocationProbe(): React.ReactNode {
  const loc = useLocation()
  return <span data-testid="probe">{loc.search}</span>
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    getPositions: (...args: unknown[]) => getPositions(...(args as [])),
    ensureSession: async () => ({ person: { id: 'p_1', name: '林夏', email: '' } }),
    listInProgress: async () => ({ items: [], scope: 'position' }),
    listOrganizations: async () => modeState.orgs,
    listClaimPool: async () => ({ pool: modeState.pool }),
    getInbox: async () => inboxState.view,
    listTodos: async (q = '') => ({ todos: q.includes('done') ? [] : todoState.todos }),
  }
})

vi.mock('@/lib/reports-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reports-api')>('@/lib/reports-api')
  return { ...actual, getReportsOverview: (r: string) => getReportsOverview(r) }
})

vi.mock('@/components/reports/right-pane', async () => {
  const actual = await vi.importActual<typeof import('@/components/reports/right-pane')>(
    '@/components/reports/right-pane',
  )
  return { ...actual, openRightPane: (p: unknown) => openRightPane(p) }
})

const { HomePage } = await import('@/pages/home')

describe('WP438 首页四块（决策 1332）', () => {
  beforeEach(() => {
    getReportsOverview.mockClear()
    openRightPane.mockClear()
    modeState.orgs = [SOLO_ORG]
    modeState.pool = []
  })

  it('从上到下：问候 → 收件箱那一行 → 关键数字 → 岗位', async () => {
    renderWithProviders(<HomePage />)
    await screen.findAllByTestId('home-key-card')
    await screen.findByTestId('position-cards')
    await screen.findByTestId('home-inbox-line')
    const order = ['home-header', 'home-inbox-line', 'home-key', 'position-cards'].map((id) =>
      screen.getByTestId(id),
    )
    for (let i = 1; i < order.length; i += 1)
      expect(
        (order[i - 1] as HTMLElement).compareDocumentPosition(order[i] as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId('home-header').textContent).toContain('林夏')
    })
    // 一行概况：AI 今天处理了几件（自主 12 + 自动发 3）、几件等你定
    expect(screen.getByTestId('home-line').textContent).toContain('处理了 15 件')
    // WP459：和收件箱同一个数
    await waitFor(() => {
      expect(screen.getByTestId('home-line').textContent).toContain('6 件等你定')
    })
  })

  it('去掉的那些都不在：复盘四格、按职责的数据条、时间轴 / 到期、目标网格、一页纸', async () => {
    renderWithProviders(<HomePage />)
    await screen.findAllByTestId('home-key-card')
    for (const id of [
      'battle-report',
      'tile-bar',
      'today',
      'today-timeline',
      'goals-line',
      'digest',
      'review',
      'queue',
    ])
      expect(screen.queryByTestId(id), id).toBeNull()
  })

  it('WP466（决策 1311）：首页没有单独的告警区——系统卡在右上铃铛里', async () => {
    homeAlerts.cards = [
      draftCard({
        id: 'al_store',
        kind: 'system_alert',
        layout: 'aftermath',
        priority_band: 'P2',
        title: '昨天销售额比前一天掉了 90%',
      }),
    ]
    try {
      renderWithProviders(<HomePage />)
      await screen.findByTestId('home-inbox-line')
      await screen.findAllByTestId('home-key-card')
      expect(screen.queryByTestId('alerts')).toBeNull()
      expect(screen.queryByTestId('alert-block')).toBeNull()
      expect(document.body.textContent).not.toContain('掉了 90%')
    } finally {
      homeAlerts.cards = []
    }
  })

  it('WP459（决策 1497）：首页不再列决策卡，只留一行「收件箱里 N 件等你 →」（带要紧件数、最急的一件）', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/inbox" element={<div data-testid="inbox-landed" />} />
      </Routes>,
    )
    const line = await screen.findByTestId('home-inbox-line')
    expect(line.getAttribute('href')).toBe('/inbox')
    expect(screen.getByTestId('home-inbox-count').textContent).toBe('收件箱里 6 件等你')
    expect(screen.getByTestId('home-inbox-urgent').textContent).toContain('2 件要紧')
    expect(line.textContent).toContain('最急：回信 · Tom Becker')
    // 原来「要你定」那一块与指到待办的「全部 →」都没了
    expect(screen.queryByTestId('home-decide')).toBeNull()
    expect(screen.queryByTestId('home-decide-all')).toBeNull()
    fireEvent.click(line)
    await screen.findByTestId('inbox-landed')
  })

  it('WP469：收件箱那一行下面是「今天 N 件待办 · 下一件 … · 还有 N 件没排期」，点了去日历与待办', async () => {
    const later = new Date()
    later.setHours(23, 0, 0, 0)
    const base = {
      schema_version: 1,
      workspace_id: 'ws_1',
      owner: 'p_1',
      source: 'manual',
      status: 'open',
      cards: [],
      runs: [],
      created_at: later.toISOString(),
      updated_at: later.toISOString(),
    }
    todoState.todos = [
      {
        ...base,
        id: 't1',
        title: '回复 Leo 的合作邮件',
        horizon: 'today',
        scheduled: {
          start: later.toISOString(),
          end: new Date(later.getTime() + 3_600_000).toISOString(),
        },
      },
      { ...base, id: 't2', title: '给 Maya 回报价', horizon: 'today', due: later.toISOString() },
      { ...base, id: 't3', title: '写新品页文案', horizon: 'week' },
    ]
    try {
      renderWithProviders(<HomePage />)
      const line = await screen.findByTestId('home-todo-line')
      expect(line.getAttribute('href')).toBe('/planner')
      expect(screen.getByTestId('home-todo-count').textContent).toBe('今天 2 件待办')
      expect(line.textContent).toContain('下一件 23:00 回复 Leo 的合作邮件')
      expect(line.textContent).toContain('还有 1 件没排期')
    } finally {
      todoState.todos = []
    }
  })

  it('WP459：收件箱清空了，那一行照实说', async () => {
    inboxState.view = inboxView([])
    try {
      renderWithProviders(<HomePage />)
      expect((await screen.findByTestId('home-inbox-count')).textContent).toBe('收件箱清空了')
      expect(screen.queryByTestId('home-inbox-urgent')).toBeNull()
    } finally {
      inboxState.view = inboxView()
    }
  })

  it('WP459：岗位卡上「等你 N 件」点了去收件箱、筛好那个岗位', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/inbox" element={<LocationProbe />} />
      </Routes>,
    )
    fireEvent.click(await screen.findByTestId('position-card-waiting'))
    expect((await screen.findByTestId('probe')).textContent).toBe('?position=web-ops')
  })

  it('关键数字：一句话（粗体照写）+ 每岗位最多 1 个；点一个在第三栏开那份报表', async () => {
    renderWithProviders(<HomePage />)
    const cards = await screen.findAllByTestId('home-key-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('$1,684')
    expect(cards[0]?.textContent).toContain('↑12.3%')
    const sentence = screen.getByTestId('home-key-sentence')
    expect(sentence.querySelector('b')?.textContent).toBe('$1,684')
    fireEvent.click(cards[1] as HTMLElement)
    expect(openRightPane).toHaveBeenCalledWith({
      kind: 'report',
      id: 'customer-care.service',
      position: 'customer-care',
    })
    fireEvent.click(screen.getByTestId('home-key-go'))
    expect(openRightPane).toHaveBeenLastCalledWith({ kind: 'report', id: 'web-ops.business' })
  })

  it('缺连接只写一行；时间段切到近 7 天重新取数（数在服务端算）', async () => {
    renderWithProviders(<HomePage />)
    const line = await screen.findByTestId('home-key-missing')
    expect(line.textContent).toContain('广告后台还没连')
    expect(line.textContent).toContain('广告回报 ROAS')
    expect(getReportsOverview).toHaveBeenCalledWith('1d')
    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }))
    await waitFor(() => {
      expect(getReportsOverview).toHaveBeenCalledWith('7d')
    })
  })

  it('岗位卡：代表数取第一份固定报表的头条数；没数没事的照实说「还没开工」', async () => {
    renderWithProviders(<HomePage />)
    await screen.findAllByTestId('home-key-card')
    const web = await waitFor(() => {
      const el = document.querySelector('[data-testid="position-card"][data-position="web-ops"]')
      expect(el?.textContent).toContain('$48.2k')
      return el as HTMLElement
    })
    expect(web.textContent).toContain('等你 3 件')
    const design = document.querySelector(
      '[data-testid="position-card"][data-position="design"]',
    ) as HTMLElement
    expect(design.getAttribute('data-state')).toBe('idle')
    expect(design.textContent).toContain('还没开工')
  })

  it('WP437（Luoye 10-21）：首页只有底部那个简易对话框（半透明悬浮），顶上那颗「有什么要我做的？」没了', async () => {
    const { container } = renderWithProviders(<HomePage />)
    await screen.findAllByTestId('home-key-card')
    expect(screen.queryByTestId('home-free-chat')).toBeNull()
    // 页面上唯一一个能打字的地方就是它
    const inputs = [
      ...container.querySelectorAll('input[type="text"], input:not([type]), textarea'),
    ].filter((el) => !(el as HTMLInputElement).disabled)
    expect(inputs).toHaveLength(1)
    const dock = screen.getByTestId('home-composer')
    expect(dock.getAttribute('data-variant')).toBe('simple')
    expect(dock.className).toContain('sticky')
    expect(dock.className).toContain('bottom-0')
    // 在页面内容最后（悬浮在底部，内容不被挡）
    expect(screen.getByTestId('home').lastElementChild).toBe(dock)
    const form = within(dock).getByTestId('simple-composer')
    expect(form.className).toContain('ws-composer-glass')
    expect(within(dock).getByTestId('simple-composer-attach')).toBeDefined()
    expect(within(dock).getByTestId('simple-composer-input').getAttribute('placeholder')).toBe(
      '有什么要我做的？',
    )
    // 没有模型 / 思考档 / 快捷按钮（那些在完整对话框里）
    expect(dock.querySelector('[data-testid^="model-pick"]')).toBeNull()
    expect(within(dock).queryByTestId('landing-actions')).toBeNull()
  })

  it('WP437：简易对话框回车 = 交给「我的助理」（带着这句话跳过去，助理页接着问）', async () => {
    const { takePendingAsk } = await import('@/components/free-chat/pending-ask')
    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/assistant" element={<p data-testid="assistant-page">assistant</p>} />
      </Routes>,
    )
    await screen.findAllByTestId('home-key-card')
    const input = screen.getByTestId('simple-composer-input')
    expect(screen.getByTestId('simple-composer-send').hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: '昨天的退款有几单？' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByTestId('assistant-page')).toBeDefined()
    expect(takePendingAsk()).toEqual({ text: '昨天的退款有几单？', files: [] })
    // 取一次就没了
    expect(takePendingAsk()).toBeUndefined()
  })
})

describe('WP271 三种模式：首页', () => {
  const POOL_ITEM = {
    todo_id: 'td_1',
    title: '会议里冒出来的：给供应商回电话',
    source: 'meeting',
    recycled: 0,
    similar_to: [],
  }

  beforeEach(() => {
    modeState.orgs = []
    modeState.pool = []
  })

  it('① 个人：「正在进行」收起，「待认领」空着就收起；一个公司概念词都不出', async () => {
    modeState.orgs = [SOLO_ORG]
    renderWithProviders(<HomePage />)
    await screen.findAllByTestId('home-key-card')
    await waitFor(() => {
      expect(screen.queryByTestId('home-inprogress')).toBeNull()
    })
    expect(screen.queryByTestId('home-claim-pool')).toBeNull()
    expect(companyWordsIn(document.body)).toEqual([])
  })

  it('① 个人：待认领里真有活就照样出', async () => {
    modeState.orgs = [SOLO_ORG]
    modeState.pool = [POOL_ITEM]
    renderWithProviders(<HomePage />)
    expect(await screen.findByTestId('home-claim-pool')).toBeTruthy()
    expect(screen.queryByTestId('home-inprogress')).toBeNull()
  })

  it('③ 公司集体：「正在进行」「待认领」照旧', async () => {
    modeState.orgs = [COMPANY_ORG]
    renderWithProviders(<HomePage />)
    expect(await screen.findByTestId('home-inprogress')).toBeTruthy()
    expect(screen.getByTestId('home-claim-pool')).toBeTruthy()
  })
})
