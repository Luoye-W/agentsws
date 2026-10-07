/**
 * WP241 岗位页 v2（设计稿 docs/design/position，docs/54 §7）。
 *
 * 钉住：
 * - 页头一行状态（N 张等你定 · N 件在办 · 今天 N 个待办）、真缺必需连接的一行横幅；
 * - 三个页签：工作（默认）/ 记录 / 设置；老地址 `?tab=cards|view|memory` 落到新位置；
 * - 工作默认列表、按状态分组、已完成折叠；行尾「N 张卡等你」点了卡片流翻到那张；
 * - 看板只有待办能拖（拖到「已完成」= 改待办状态）；视图记在这个岗位上（localStorage）；
 * - 设置 · 连接里可选收成一行（#72）；空岗位「交给它」放大当主角。
 * - `lib/position-work.ts` 的偏好读写、筛选、分组、快捷视图顺序（#74）。
 */
import type { PositionWorkItem, PositionWorkView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import {
  DEFAULT_PREFS,
  filterItems,
  groupItems,
  loadWorkPrefs,
  NO_FILTERS,
  quickViewsOf,
  saveWorkPrefs,
  whenText,
} from '@/lib/position-work'
import { PositionPage } from '@/pages/position'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-06T08:00:00.000Z'

const item = (over: Partial<PositionWorkItem>): PositionWorkItem => ({
  id: 'matter:m_1',
  kind: 'matter',
  ref_id: 'm_1',
  title: '近视求助帖的回帖',
  role_id: 'pr.reddit',
  role_name: 'Reddit 营销',
  assignment_id: 'asg_pr',
  group: 'doing',
  status: 'open',
  cards: 0,
  card_ids: [],
  source: 'you',
  updated_at: NOW,
  matter_id: 'm_1',
  movable: false,
  ...over,
})

const state: {
  work: PositionWorkView
  instance: PositionInstanceData
  missing: string[]
  setTodoStatus: ReturnType<typeof vi.fn>
  view: unknown
} = {
  view: undefined,
  work: undefined as unknown as PositionWorkView,
  instance: undefined as unknown as PositionInstanceData,
  missing: [],
  setTodoStatus: vi.fn(async () => ({ todo: {} })),
}

const fullWork = (): PositionWorkView => ({
  position_id: 'pos-reddit',
  generated_at: NOW,
  items: [
    item({ id: 'matter:m_1', cards: 1, card_ids: ['ap_reddit'], progress: '草稿写好了' }),
    item({
      id: 'todo:t_1',
      kind: 'todo',
      ref_id: 't_1',
      title: '私信版主问 flair',
      role_id: 'social.reddit',
      role_name: '自家版运营',
      assignment_id: 'asg_social',
      due_at: '2026-10-06T10:00:00.000Z',
      movable: true,
    }),
    item({
      id: 'schedule:s_1',
      kind: 'schedule',
      ref_id: 's_1',
      title: 'r/INMO 入群审核',
      group: 'queued',
      status: 'active',
      source: 'schedule',
      due_at: '2026-10-06T16:00:00.000Z',
    }),
    item({
      id: 'matter:m_9',
      ref_id: 'm_9',
      title: '找 5 个适合的版',
      group: 'done',
      status: 'closed',
    }),
  ],
  counts: { doing: 2, queued: 1, waiting: 0, done: 1, cards: 1, todos_today: 1 },
  duties: [
    { role_id: 'pr.reddit', role_name: 'Reddit 营销', assignment_id: 'asg_pr' },
    { role_id: 'social.reddit', role_name: '自家版运营', assignment_id: 'asg_social' },
  ],
  done_window_days: 14,
})

const instance = (over: Partial<PositionInstanceData> = {}): PositionInstanceData => ({
  position_id: 'pos-reddit',
  workspace_id: 'ws_1',
  name: { zh: 'Reddit 运营', en: 'Reddit Ops' },
  template_version: '1.0.0',
  holders: ['p_1'],
  roles: [
    {
      role_id: 'pr.reddit',
      role_name: 'Reddit 营销',
      default: true,
      assignment_ids: ['asg_pr'],
      my_assignment_id: 'asg_pr',
    },
    {
      role_id: 'social.reddit',
      role_name: '自家版运营',
      default: true,
      assignment_ids: ['asg_social'],
      my_assignment_id: 'asg_social',
    },
  ],
  open_matters: 2,
  pending_cards: 2,
  memory_summary: '',
  ...over,
})

const summary = (position_id: string, role_id: string, role_name: string) => ({
  position_id,
  role_id,
  role_name,
  ranges: [{ kind: 'brand', id: 'ws_1' }],
  ready: true,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday' as const,
  show_tiles: false,
})

vi.mock('@/components/social/social-calendar', async () => {
  const actual = await vi.importActual<typeof import('@/components/social/social-calendar')>(
    '@/components/social/social-calendar',
  )
  return {
    ...actual,
    SocialCalendar: ({ channel }: { channel: string }) => (
      <div data-testid="social-calendar-stub">{channel}</div>
    ),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [
        summary('asg_pr', 'pr.reddit', 'Reddit 营销'),
        summary('asg_social', 'social.reddit', '自家版运营'),
      ],
      instances: [state.instance],
      tile_library: [],
      max_tiles: 6,
    }),
    getPosition: async () => state.instance,
    getPositionWork: async () => state.work,
    getPositionCards: async (id: string) => ({
      position: summary(id, 'pr.reddit', 'Reddit 营销'),
      cards:
        id === 'asg_pr'
          ? [
              draftCard({ id: 'ap_other', title: '另一张卡：版规更新' }),
              draftCard({ id: 'ap_reddit', title: '回帖 r/SmartGlasses：近视能戴吗' }),
            ]
          : [],
      counts: {
        total: id === 'asg_pr' ? 2 : 0,
        customer_waiting: 0,
        nobody_waiting: 0,
        matched: 0,
      },
      pinned_p0: [],
    }),
    getPositionView: async () => state.view,
    getBlockData: async (id: string) => ({
      block: { id, component: 'stat_tile', title: '总销售额', source: 'shop' },
      status: 'ok',
      payload: { value: 22.5, previous: 20, delta_pct: 12.5, spark: [], currency: 'USD' },
    }),
    getPositionRecords: async () => ({ payload: { rows: [] } }),
    getPositionConnections: async () => ({
      position_id: 'pos-reddit',
      position_name: 'Reddit 运营',
      ready: state.missing.length === 0,
      missing_required: state.missing,
      items: [
        {
          kind: 'reddit_brand',
          name: { zh: '品牌 Reddit 号', en: 'Brand Reddit account' },
          required: true,
          connected: false,
          needed_by: ['自家版运营'],
          status: 'available',
          connect_service: 'reddit',
        },
        {
          kind: 'apify',
          name: { zh: 'Apify', en: 'Apify' },
          required: false,
          connected: false,
          needed_by: ['Reddit 营销'],
          status: 'available',
          connect_service: 'apify',
        },
        {
          kind: 'browser',
          name: { zh: '浏览器只读', en: 'Browser' },
          required: false,
          connected: true,
          needed_by: ['Reddit 营销'],
          status: 'available',
        },
      ],
    }),
    getSchedules: async () => [],
    getRoleDefinition: async (id: string) => ({
      id,
      name: id,
      name_en: id,
      description: '我们自己的 **subreddit**',
      domain: 'social',
      version: '1.0.0',
      source: 'bundled',
      editable: false,
      holders: 1,
      home_blocks: [],
      actions: [],
      automation: [],
      connectors: [],
      scopes: [],
      skills: [],
    }),
    setTodoStatus: (...args: unknown[]) =>
      (state.setTodoStatus as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  }
})

/** Node 25 自带那个全局 localStorage 是残的（同 `calendar-layers.test.ts`），换一份内存的。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k)
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  state.work = fullWork()
  state.instance = instance()
  state.missing = []
  state.setTodoStatus = vi.fn(async () => ({ todo: {} }))
  state.view = {
    position_id: 'asg_pr',
    range: 'yesterday',
    sections: [
      { source: 'social_reddit', label: 'Reddit', connected: false, via: 'workshop', blocks: [] },
    ],
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const openAt = (path = '/positions/asg_pr') =>
  renderWithProviders(
    <Routes>
      <Route path="/positions/:id" element={<PositionPage />} />
    </Routes>,
    path,
    'asg_pr',
  )

describe('页头与页签', () => {
  it('一行状态：N 张等你定 · N 件在办 · 今天 N 个待办；三个页签，默认工作', async () => {
    openAt()
    expect((await screen.findByTestId('status-cards')).textContent).toContain('2 张等你定')
    expect(screen.getByTestId('status-doing').textContent).toContain('2 件在办')
    expect(screen.getByTestId('status-today').textContent).toContain('今天 1 个待办')
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs.slice(0, 3)).toEqual(['工作', '记录', '设置'])
    expect(screen.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    // 不缺必需连接：没有横幅、也没有老的「连上这 N 个」大卡
    expect(screen.queryByTestId('position-missing-banner')).toBeNull()
    expect(screen.queryByTestId('position-connections')).toBeNull()
  })

  it('真缺必需连接：页头下一行横幅，去连接落到那张卡', async () => {
    state.missing = ['reddit_brand']
    openAt()
    const banner = await screen.findByTestId('position-missing-banner')
    expect(banner.textContent).toContain('品牌 Reddit 号')
    expect(within(banner).getByTestId('position-missing-go').getAttribute('href')).toBe(
      '/connections?service=reddit',
    )
  })

  it('老地址：?tab=memory → 设置（记忆在里面）；?tab=cards → 工作', async () => {
    openAt('/positions/asg_pr?tab=memory')
    expect(await screen.findByTestId('position-settings')).toBeTruthy()
    expect(screen.getByTestId('position-memory')).toBeTruthy()
  })

  it('?tab=cards 落到工作页签，卡片流在', async () => {
    openAt('/positions/asg_pr?tab=cards')
    expect(await screen.findByTestId('deck-section')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('工作', () => {
  it('默认列表、按状态分组；已完成折叠；每行带职责', async () => {
    openAt()
    await screen.findByTestId('work-list')
    expect(screen.getByTestId('work-section').getAttribute('data-view')).toBe('list')
    const groups = screen.getAllByTestId('work-group').map((g) => g.getAttribute('data-group'))
    expect(groups).toEqual(['doing', 'queued', 'done'])
    const rows = screen.getAllByTestId('work-row')
    // 默认按截止排：有截止的在前
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([
      'todo:t_1',
      'matter:m_1',
      'schedule:s_1',
    ])
    expect(
      within(rows[0] as HTMLElement)
        .getByTestId('work-who')
        .getAttribute('data-who'),
    ).toBe('you')
    // 没有决定按钮
    expect(within(screen.getByTestId('work-section')).queryByText('批准')).toBeNull()
  })

  it('「1 张卡等你」点了 → 卡片流翻到那张', async () => {
    openAt()
    await screen.findByTestId('deck-card')
    expect(screen.getByTestId('deck-card').textContent).toContain('另一张卡')
    fireEvent.click(await screen.findByTestId('work-cards-badge'))
    await waitFor(() => {
      expect(screen.getByTestId('deck-card').textContent).toContain('近视能戴吗')
    })
  })

  it('看板：只有待办能拖；拖到「已完成」= 把待办改成 done；视图记在这个岗位上', async () => {
    openAt()
    await screen.findAllByTestId('work-row')
    fireEvent.click(screen.getByTestId('work-view-board'))
    const cards = await screen.findAllByTestId('work-board-card')
    const todo = cards.find((c) => c.getAttribute('data-id') === 'todo:t_1') as HTMLElement
    const matter = cards.find((c) => c.getAttribute('data-id') === 'matter:m_1') as HTMLElement
    expect(todo.getAttribute('draggable')).toBe('true')
    expect(matter.getAttribute('draggable')).toBe('false')
    const done = screen
      .getAllByTestId('work-board-column')
      .find((c) => c.getAttribute('data-group') === 'done') as HTMLElement
    const data = { setData: () => {}, effectAllowed: '' }
    fireEvent.dragStart(todo, { dataTransfer: data })
    expect(done.getAttribute('data-accepts')).toBe('true')
    const queued = screen
      .getAllByTestId('work-board-column')
      .find((c) => c.getAttribute('data-group') === 'queued') as HTMLElement
    expect(queued.getAttribute('data-accepts')).toBe('false')
    fireEvent.dragOver(done, { dataTransfer: data })
    fireEvent.drop(done, { dataTransfer: data })
    await waitFor(() => {
      expect(state.setTodoStatus).toHaveBeenCalledWith('t_1', 'done')
    })
    expect(loadWorkPrefs('pos-reddit').view).toBe('board')
  })

  it('表格：列可选；日历：只看这个岗位', async () => {
    openAt()
    await screen.findAllByTestId('work-row')
    fireEvent.click(screen.getByTestId('work-view-table'))
    expect(screen.getAllByTestId('work-table-row')).toHaveLength(4)
    fireEvent.click(screen.getByTestId('work-columns'))
    fireEvent.click(screen.getByTestId('work-column-progress'))
    expect(
      screen.getAllByTestId('work-table-col').map((c) => c.getAttribute('data-col')),
    ).toContain('progress')
    fireEvent.click(screen.getByTestId('work-view-calendar'))
    expect(await screen.findByTestId('work-calendar')).toBeTruthy()
    expect(screen.getByText('只看这个岗位')).toBeTruthy()
  })

  it('筛选：只看等别人 → 一件都没有时说一句', async () => {
    openAt()
    fireEvent.click(await screen.findByTestId('work-filter'))
    fireEvent.click(screen.getByTestId('work-filter-group-waiting'))
    expect(await screen.findByTestId('work-no-match')).toBeTruthy()
    expect(screen.getByTestId('work-filter').textContent).toContain('筛选 · 1')
  })

  it('快捷视图：社媒的「发帖排期」排最前，点开是原来的内容日历', async () => {
    openAt()
    const quick = await screen.findAllByTestId('work-quick')
    expect(quick[0]?.getAttribute('data-quick')).toBe('quick:schedule:social.reddit')
    fireEvent.click(quick[0] as HTMLElement)
    expect((await screen.findByTestId('social-calendar-stub')).textContent).toBe('reddit')
    expect(screen.getByTestId('work-quick-view').textContent).toContain('要你拍板的都出成卡')
  })
})

describe('数据看板', () => {
  it('每条职责一行数 + 涨跌；同一份店铺数字只在第一条职责下摆一次', async () => {
    state.view = {
      position_id: 'asg_pr',
      range: 'yesterday',
      sections: [
        {
          source: 'shop',
          label: '店铺后台',
          connected: true,
          blocks: [
            { id: 'shop.revenue', component: 'stat_tile', title: '总销售额', source: 'shop' },
          ],
        },
      ],
    }
    openAt()
    const rows = await screen.findAllByTestId('data-row')
    await waitFor(() => {
      expect(screen.getAllByTestId('data-tile')).toHaveLength(1)
    })
    const tile = screen.getByTestId('data-tile')
    await waitFor(() => {
      expect(tile.textContent).toContain('22.5')
    })
    expect(within(tile).getByTestId('ws-delta').getAttribute('data-direction')).toBe('up')
    await waitFor(() => {
      expect(screen.getAllByTestId('data-row')[1]?.getAttribute('data-shared')).toBe('true')
    })
    expect(rows).toHaveLength(2)
  })
})

describe('设置', () => {
  it('五节；可选连接收成一行「还有 N 个可选」，点开才展开（#72）', async () => {
    openAt('/positions/asg_pr?tab=settings')
    await screen.findByTestId('position-settings')
    const more = await screen.findByTestId('settings-connections-more')
    expect(more.textContent).toContain('还有 2 个可选')
    expect(
      screen.getAllByTestId('settings-connection').map((r) => r.getAttribute('data-kind')),
    ).toEqual(['reddit_brand'])
    fireEvent.click(more)
    expect(screen.getAllByTestId('settings-connection')).toHaveLength(3)
    // 职责说明不露 markdown 星号
    const duty = (await screen.findAllByTestId('settings-duty'))[0] as HTMLElement
    await waitFor(() => {
      expect(duty.textContent).toContain('我们自己的 subreddit')
    })
    expect(duty.textContent).not.toContain('**')
    // 高级默认折叠
    expect(screen.queryByTestId('settings-advanced-body')).toBeNull()
  })
})

describe('空岗位', () => {
  it('什么都没有：交给它放大当主角，要你处理只留一行，数据看板一行', async () => {
    state.instance = instance({ pending_cards: 0 })
    state.work = {
      ...fullWork(),
      items: [],
      counts: { doing: 0, queued: 0, waiting: 0, done: 0, cards: 0, todos_today: 0 },
    }
    openAt()
    const hero = await screen.findByTestId('position-handoff')
    await waitFor(() => {
      expect(screen.getByTestId('position-handoff').getAttribute('data-hero')).toBe('true')
    })
    expect(hero).toBeTruthy()
    expect(screen.getByTestId('position-deck-empty')).toBeTruthy()
    expect(screen.queryByTestId('deck-section')).toBeNull()
    expect(screen.getByTestId('work-empty')).toBeTruthy()
    expect(screen.getByTestId('data-board').getAttribute('data-empty')).toBe('true')
    expect(screen.getByTestId('position-status').textContent).toContain('刚建好')
  })
})

describe('lib/position-work', () => {
  it('偏好：没存过 / 坏数据 / 存储不让用 → 默认列表（#74）', () => {
    expect(loadWorkPrefs('p_none')).toEqual(DEFAULT_PREFS)
    globalThis.localStorage.setItem('agentsws.position_work.p_bad', '{oops')
    expect(loadWorkPrefs('p_bad').view).toBe('list')
    saveWorkPrefs('p_ok', { ...DEFAULT_PREFS, view: 'table', columns: ['due'] })
    expect(loadWorkPrefs('p_ok')).toMatchObject({ view: 'table', columns: ['due'] })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadWorkPrefs('p_ok').view).toBe('list')
    expect(() => {
      saveWorkPrefs('p_ok', DEFAULT_PREFS)
    }).not.toThrow()
  })

  it('筛选与分组', () => {
    const items = fullWork().items
    const now = new Date(NOW)
    expect(filterItems(items, { ...NO_FILTERS, duty: ['social.reddit'] }, now)).toHaveLength(1)
    expect(filterItems(items, { ...NO_FILTERS, due: 'none' }, now)).toHaveLength(2)
    expect(filterItems(items, { ...NO_FILTERS, source: ['schedule'] }, now)).toHaveLength(1)
    const byDuty = groupItems(items, 'duty', ['pr.reddit', 'social.reddit'])
    expect(byDuty.map((g) => g.id)).toEqual(['pr.reddit', 'social.reddit'])
    // WP244：加了「卡住了」（排在进行中后面；空组界面不画）
    expect(groupItems(items, 'status', []).map((g) => g.id)).toEqual([
      'doing',
      'stuck',
      'queued',
      'waiting',
      'done',
    ])
  })

  it('快捷视图：发帖排期排最前；红人 / B2B / 在线客服各有一个', () => {
    const views = quickViewsOf([
      { role_id: 'kol.youtube', role_name: 'YouTube 红人', assignment_id: 'a1' },
      { role_id: 'social.reddit', role_name: '自家版运营', assignment_id: 'a2' },
      { role_id: 'b2b.outbound', role_name: '主动开发', assignment_id: 'a3' },
      { role_id: 'dtc.live-chat', role_name: '在线客服', assignment_id: 'a4' },
    ])
    // WP249：自家版运营多一个「自家版待处理」，排在它的群发后面
    expect(views.map((v) => v.kind)).toEqual([
      'schedule',
      'kol',
      'broadcast',
      'modqueue',
      'outbound',
      'chat',
    ])
  })

  it('时间说法：今天 18:00 / 明天 / MM-DD', () => {
    const now = new Date(2026, 9, 6, 9, 0)
    const t = (k: string): string =>
      ({ 'pos2.when.today': '今天', 'pos2.when.tomorrow': '明天', 'pos2.when.yesterday': '昨天' })[
        k
      ] ?? k
    expect(whenText(new Date(2026, 9, 6, 18, 0).toISOString(), now, t)).toBe('今天 18:00')
    expect(whenText(new Date(2026, 9, 7, 9, 0).toISOString(), now, t)).toBe('明天')
    expect(whenText(new Date(2026, 9, 9, 0, 0).toISOString(), now, t)).toBe('10-09')
  })
})

describe('WP244 工作：答完了的进已完成（待你看结果），交不出来的进卡住了', () => {
  const realWork = (): PositionWorkView => ({
    ...fullWork(),
    items: [
      item({ id: 'matter:m_run', ref_id: 'm_run', title: '整理本周热帖', progress: '在查' }),
      item({
        id: 'matter:m_stuck',
        ref_id: 'm_stuck',
        title: '回版主私信',
        group: 'stuck',
        progress: '这份活现在交不出来——不是没人干，是没接上。',
        stuck_reason: '缺品牌 Reddit 号连接',
      }),
      item({
        id: 'matter:m_done',
        ref_id: 'm_done',
        title: '查近视求助帖',
        group: 'done',
        progress: '查完了。',
        result_ready: true,
      }),
    ],
    counts: { doing: 1, stuck: 1, queued: 0, waiting: 0, done: 1, cards: 0, todos_today: 0 },
  })

  it('列表：卡住了一组、说缺什么；已完成里有「待你看结果」就展开；页头说 1 件卡住了', async () => {
    state.work = realWork()
    openAt()
    await screen.findByTestId('work-list')
    const groups = screen.getAllByTestId('work-group').map((g) => g.getAttribute('data-group'))
    expect(groups).toEqual(['doing', 'stuck', 'done'])
    const rows = new Map(
      screen.getAllByTestId('work-row').map((r) => [r.getAttribute('data-id'), r as HTMLElement]),
    )
    // 卡住了：行上是缺什么，不是 AI 那句原话；谁在做说「AI 卡住了」
    const stuck = rows.get('matter:m_stuck') as HTMLElement
    expect(within(stuck).getByTestId('work-stuck-reason').textContent).toBe('缺品牌 Reddit 号连接')
    expect(stuck.getAttribute('data-group')).toBe('stuck')
    // 已完成默认折叠——但有「待你看结果」的就展开着
    const done = rows.get('matter:m_done') as HTMLElement
    expect(done).toBeDefined()
    expect(within(done).getByTestId('work-result-ready').textContent).toBe('待你看结果')
    expect(done.textContent).toContain('查完了。')
    // 页头：N 件在办只数真在做的；卡住了单独一格，点了筛到那一组
    expect(screen.getByTestId('status-doing').textContent).toContain('1 件在办')
    const chip = screen.getByTestId('status-stuck')
    expect(chip.textContent).toContain('1 件卡住了')
    fireEvent.click(chip)
    await waitFor(() => {
      expect(screen.getAllByTestId('work-row').map((r) => r.getAttribute('data-id'))).toEqual([
        'matter:m_stuck',
      ])
    })
  })

  it('看板：「卡住了」那列有东西才出', async () => {
    state.work = realWork()
    openAt()
    await screen.findAllByTestId('work-row')
    fireEvent.click(screen.getByTestId('work-view-board'))
    await screen.findAllByTestId('work-board-card')
    expect(
      screen.getAllByTestId('work-board-column').map((c) => c.getAttribute('data-group')),
    ).toEqual(['doing', 'stuck', 'queued', 'waiting', 'done'])
  })

  it('看板：没有卡住的 → 还是四列', async () => {
    openAt()
    await screen.findAllByTestId('work-row')
    fireEvent.click(screen.getByTestId('work-view-board'))
    await screen.findAllByTestId('work-board-card')
    expect(
      screen.getAllByTestId('work-board-column').map((c) => c.getAttribute('data-group')),
    ).toEqual(['doing', 'queued', 'waiting', 'done'])
  })
})
