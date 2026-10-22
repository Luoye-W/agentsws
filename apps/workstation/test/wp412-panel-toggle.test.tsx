/**
 * WP412（真机 10-18 #8，决策 1035 更正）：右侧面板有自己的开关图标、默认打开。
 *
 * - 右上角：露出来的工具（浏览器、变更审阅）→「⋮」溢出菜单（教程、记忆……，不开关面板）→ 最右专门的面板开关；
 * - 进岗位 / 职责 / 事项页面板默认打开；人手动关了按页面类型记住（别的岗位页也关着，职责页另记）；
 * - 别处自动弹开（`openCard`）只开这一次，不改记住的那一份；窗口窄于 900 时没记过的先收着。
 *
 * WP433（Luoye 10-20 问题 5）：面板开关去掉，岗位 / 职责 / 事项页上面板一直在（窄于 900 时挪到主区下面）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import type { WorkRail } from '@/lib/work-archive'
import { renderWithProviders } from './helpers'

const INSTANCE: PositionInstanceData = {
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
  open_matters: 1,
  pending_cards: 0,
  memory_summary: '',
}

vi.mock('@/lib/work-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/work-archive')>('@/lib/work-archive')
  return {
    ...actual,
    getWorkRail: async () => ({ idle_days: 3, positions: [] }) as unknown as WorkRail,
  }
})

vi.mock('@/lib/outbound-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbound-api')>('@/lib/outbound-api')
  return { ...actual, listSinks: async () => [] }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [],
      instances: [INSTANCE],
      tile_library: [],
      max_tiles: 6,
    }),
    getPositionCards: async () => ({
      position: {},
      cards: [],
      counts: { total: 0, customer_waiting: 0, nobody_waiting: 0, matched: 0 },
      pinned_p0: [],
      filters: {},
      reports: [],
    }),
    getPositionConnections: async () => ({
      position_id: 'support',
      position_name: '客服',
      ready: true,
      missing_required: [],
      items: [],
    }),
    getMySchedules: async () => [],
    getPositionRecords: async () => ({ status: 'ok', payload: { rows: [] } }),
  }
})

const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider, useRailState } = await import('@/components/rail/rail-state')
const { ShellSizeContext } = await import('@/components/rail/board-fit')
const { RIGHT_RAIL_PAGE_OPEN_KEY } = await import('@/lib/ui-state')

let box = new Map<string, string>()
function stubStorage(): void {
  box = new Map<string, string>()
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

/** 测试里换页用（同一个 Provider 里走一段路）。 */
function Go({ to }: { to: string }): ReactNode {
  const navigate = useNavigate()
  return (
    <button type="button" data-testid={`go:${to}`} onClick={() => navigate(to)}>
      go
    </button>
  )
}

/** 测试里「别处自动弹开」用（连接卡那种）。 */
function AutoOpen(): ReactNode {
  const rail = useRailState()
  return (
    <button type="button" data-testid="auto-open" onClick={() => rail.openCard('connections')}>
      auto
    </button>
  )
}

const PAGES = ['/positions/asg_sup', '/positions/asg_sup/duties/dtc.support', '/matters/mat_1', '/']

function renderRail(route: string): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
      {PAGES.map((p) => (
        <Go key={p} to={p} />
      ))}
      <AutoOpen />
    </RailStateProvider>,
    route,
    'asg_sup',
  )
}

const panelOpen = (): boolean => screen.queryByTestId('rail-panel-frame') !== null

beforeEach(() => {
  stubStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('右上角：专门的面板开关 +「⋮」只放工具', () => {
  it('从左到右：浏览器、变更审阅、通知铃铛（WP429）、「⋮」、面板开关；「⋮」里是设定那几格 + 教程，点「⋮」不开关面板', async () => {
    renderRail('/')
    const bar = screen.getByTestId('right-rail')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-testid')),
      // WP431：首页没有右侧面板，也就没有面板开关（岗位 / 职责 / 事项页上它在最左，见 wp375）
    ).toEqual(['rail-icon-browser', 'rail-icon-changes', 'rail-overflow'])
    expect(panelOpen()).toBe(false)
    const more = screen.getByTestId('rail-overflow')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(more)
    const menu = await screen.findByTestId('rail-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.getAttribute('data-testid')),
    ).toEqual([
      'rail-menu-role',
      'rail-menu-skills',
      'rail-menu-knowledge',
      'rail-menu-memory',
      'rail-menu-caps',
      'rail-menu-help',
    ])
    // 不在职责页：叫「岗位定义」
    expect(screen.getByTestId('rail-menu-role').textContent).toBe('岗位定义')
    // 「⋮」只是菜单：面板没被它打开
    expect(panelOpen()).toBe(false)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    // 菜单里点「记忆」= 开到「设定」的「记忆」标签，菜单收起
    fireEvent.click(screen.getByTestId('rail-menu-memory'))
    expect(screen.queryByTestId('rail-menu')).toBeNull()
    expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('settings')
  })

  it.each([
    ['role', 'role'],
    ['skills', 'skills'],
    ['knowledge', 'knowledge'],
    ['memory', 'memory'],
    ['caps', 'caps'],
  ])('「⋮ → %s」打开面板并直达「设定」的那一格', async (item, tab) => {
    renderRail('/positions/asg_sup/duties/dtc.support')
    await screen.findByTestId('rail-cards')
    fireEvent.click(screen.getByTestId('rail-overflow'))
    fireEvent.click(await screen.findByTestId(`rail-menu-${item}`))
    expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('settings')
    expect((await screen.findByTestId('settings-panel')).getAttribute('data-tab')).toBe(tab)
  })

  it('职责页上第一项叫「职责定义」', async () => {
    renderRail('/positions/asg_sup/duties/dtc.support')
    fireEvent.click(screen.getByTestId('rail-overflow'))
    expect((await screen.findByTestId('rail-menu-role')).textContent).toBe('职责定义')
  })

  it('WP433：顶栏不再有面板开关（面板一直在）', async () => {
    renderRail(PAGES[0] as string)
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
    expect(screen.queryByTestId('top-bar-divider')).toBeNull()
  })
})

describe('WP433：岗位 / 职责 / 事项页卡片列一直在（Luoye 10-20 问题 5、10-21 澄清）', () => {
  it.each(PAGES.slice(0, 3))('进 %s：面板开着，开成卡片（默认展开对话、计划）', async (route) => {
    renderRail(route)
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.getByTestId('rail-card-conversations').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('rail-card-plans').getAttribute('data-open')).toBe('true')
  })

  it('别的页（首页）照旧没有面板；从首页进岗位页就有', async () => {
    renderRail('/')
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('go:/positions/asg_sup'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
  })

  it('以前（WP412）记过「关着」也不管：照样开着；那份本机记录不再写', async () => {
    box.set(RIGHT_RAIL_PAGE_OPEN_KEY, JSON.stringify({ position: false, role: false }))
    renderRail('/positions/asg_sup')
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    fireEvent.click(screen.getByTestId('go:/positions/asg_sup/duties/dtc.support'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(JSON.parse(box.get(RIGHT_RAIL_PAGE_OPEN_KEY) ?? '{}')).toEqual({
      position: false,
      role: false,
    })
  })

  it('卡片列属于中栏、一直在；浏览器这类开在它右边的第三栏，图标 / `]` / × 开关的只是第三栏', async () => {
    renderRail('/matters/mat_1')
    await screen.findByTestId('rail-cards')
    expect(panelOpen()).toBe(false)
    expect(screen.getByTestId('rail-board').className).not.toContain('border-l')
    expect(screen.queryByTestId('rail-board-resize')).toBeNull()
    fireEvent.keyDown(document.body, { key: ']' })
    expect(screen.getByTestId('rail-cards')).toBeDefined()
    fireEvent.click(screen.getByTestId('rail-icon-browser'))
    await waitFor(() => {
      expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('browser')
    })
    expect(screen.getByTestId('rail-cards')).toBeDefined()
    // 再点一次图标：第三栏收起，卡片列不动
    fireEvent.click(screen.getByTestId('rail-icon-browser'))
    await waitFor(() => {
      expect(panelOpen()).toBe(false)
    })
    expect(screen.getByTestId('rail-cards')).toBeDefined()
    // `]` 开回刚才那一格，再按收起
    fireEvent.keyDown(document.body, { key: ']' })
    await waitFor(() => {
      expect(panelOpen()).toBe(true)
    })
    fireEvent.keyDown(document.body, { key: ']' })
    await waitFor(() => {
      expect(panelOpen()).toBe(false)
    })
    // × 也是收起第三栏
    fireEvent.click(screen.getByTestId('rail-icon-browser'))
    fireEvent.click(await screen.findByTestId('rail-panel-close'))
    await waitFor(() => {
      expect(panelOpen()).toBe(false)
    })
    expect(screen.getByTestId('rail-cards')).toBeDefined()
  })

  it('别处自动弹开（连接卡）= WP456-T3 起「连接」在清单卡里，开第三栏「连接」那一格', async () => {
    renderRail('/positions/asg_sup/duties/dtc.support')
    await screen.findByTestId('rail-cards')
    fireEvent.click(screen.getByTestId('auto-open'))
    await waitFor(() => {
      expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('connections')
    })
  })

  it('窗口 1024 以上：卡片列并排在对话右边，不盖在对话上', async () => {
    renderRail('/positions/asg_sup')
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.queryByTestId('rail-scrim')).toBeNull()
    const board = screen.getByTestId('rail-board')
    expect(board.className).toContain('sticky')
    expect(board.className).not.toContain('fixed')
  })

  it('WP433 → WP437：中栏放不下「核心区最小宽度 + 看板」时看板自动隐藏，不盖、不留开关（只多一颗「看一眼」）', async () => {
    renderWithProviders(
      <ShellSizeContext.Provider value={{ body: 760, viewport: 1000 }}>
        <RailStateProvider>
          <RightRail instances={[INSTANCE]} />
        </RailStateProvider>
      </ShellSizeContext.Provider>,
      '/positions/asg_sup',
      'asg_sup',
    )
    await waitFor(() => {
      expect(screen.getByTestId('board-peek')).toBeDefined()
    })
    expect(screen.queryByTestId('rail-board')).toBeNull()
    expect(screen.queryByTestId('rail-scrim')).toBeNull()
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
  })

  it('窗口窄于 900：露出来的工具收进「⋮」', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('899px') || q.includes('1023px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    renderRail('/positions/asg_sup')
    expect(screen.queryByTestId('rail-icon-browser')).toBeNull()
    fireEvent.click(screen.getByTestId('rail-overflow'))
    const menu = await screen.findByTestId('rail-menu')
    expect(within(menu).getByTestId('rail-menu-browser')).toBeDefined()
    expect(within(menu).getByTestId('rail-menu-changes')).toBeDefined()
  })

  it('窗口窄于 900：第三栏（浏览器……）盖在主区上，点遮罩收起', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('899px') || q.includes('1199px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    renderRail('/')
    fireEvent.click(screen.getByTestId('rail-overflow'))
    fireEvent.click(await screen.findByTestId('rail-menu-browser'))
    expect(screen.getByTestId('rail-panel-frame').getAttribute('data-layout')).toBe('overlay')
    fireEvent.click(screen.getByTestId('rail-scrim'))
    expect(panelOpen()).toBe(false)
  })
})
