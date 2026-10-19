/**
 * WP412（真机 10-18 #8，决策 1035 更正）：右侧面板有自己的开关图标、默认打开。
 *
 * - 右上角：露出来的工具（浏览器、变更审阅）→「⋮」溢出菜单（教程、记忆……，不开关面板）→ 最右专门的面板开关；
 * - 进岗位 / 职责 / 事项页面板默认打开；人手动关了按页面类型记住（别的岗位页也关着，职责页另记）；
 * - 别处自动弹开（`openCard`）只开这一次，不改记住的那一份；窗口窄于 900 时没记过的先收着。
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

  it('面板开关有自己的图标与读屏说法，开 / 关跟着变', async () => {
    // WP431：面板开关只在岗位 / 职责 / 事项页上有；岗位页默认开着
    renderRail(PAGES[0] as string)
    const toggle = screen.getByTestId('rail-toggle')
    expect(toggle.querySelector('svg')?.getAttribute('class')).toContain('panel-right')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('收起右侧面板')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(screen.getByTestId('rail-toggle').getAttribute('aria-label')).toBe('打开右侧面板')
    })
    fireEvent.click(screen.getByTestId('rail-toggle'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
  })
})

describe('岗位 / 职责 / 事项页面板默认打开（决策 1035 更正）', () => {
  it.each(PAGES.slice(0, 3))('进 %s：面板开着，开成卡片（默认展开对话、计划）', async (route) => {
    renderRail(route)
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.getByTestId('rail-toggle').getAttribute('aria-pressed')).toBe('true')
  })

  it('别的页（首页）照旧收着；从首页进岗位页就打开', async () => {
    renderRail('/')
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('go:/positions/asg_sup'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
  })

  it('手动关了按页面类型记住：职责页关了，别的职责页也关着；岗位页另记、照旧打开', async () => {
    renderRail('/positions/asg_sup/duties/dtc.support')
    await screen.findByTestId('rail-cards')
    fireEvent.click(screen.getByTestId('rail-toggle'))
    expect(panelOpen()).toBe(false)
    expect(JSON.parse(box.get(RIGHT_RAIL_PAGE_OPEN_KEY) ?? '{}')).toEqual({ role: false })
    fireEvent.click(screen.getByTestId('go:/positions/asg_sup'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    fireEvent.click(screen.getByTestId('go:/positions/asg_sup/duties/dtc.support'))
    await waitFor(() => {
      expect(panelOpen()).toBe(false)
    })
  })

  it('关过再手动打开：这一类页又回到默认打开', async () => {
    box.set(RIGHT_RAIL_PAGE_OPEN_KEY, JSON.stringify({ position: false }))
    renderRail('/positions/asg_sup')
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('rail-toggle'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(JSON.parse(box.get(RIGHT_RAIL_PAGE_OPEN_KEY) ?? '{}')).toEqual({ position: true })
  })

  it('WP431：面板没有自己的 ×（照 Claude）；顶栏面板开关收起也算手动关', async () => {
    renderRail('/matters/mat_1')
    await screen.findByTestId('rail-cards')
    expect(screen.queryByTestId('rail-panel-close')).toBeNull()
    fireEvent.click(screen.getByTestId('rail-toggle'))
    expect(panelOpen()).toBe(false)
    expect(JSON.parse(box.get(RIGHT_RAIL_PAGE_OPEN_KEY) ?? '{}')).toEqual({ matter: false })
  })

  it('别处自动弹开（连接卡）只开这一次，不改记住的「关着」', async () => {
    box.set(RIGHT_RAIL_PAGE_OPEN_KEY, JSON.stringify({ role: false }))
    renderRail('/positions/asg_sup/duties/dtc.support')
    expect(panelOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('auto-open'))
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(JSON.parse(box.get(RIGHT_RAIL_PAGE_OPEN_KEY) ?? '{}')).toEqual({ role: false })
  })

  it('窗口 900–1199：面板默认开着、并排占一栏，不盖在对话上（Luoye 10-19）', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('1199px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    renderRail('/positions/asg_sup')
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.queryByTestId('rail-scrim')).toBeNull()
    const frame = screen.getByTestId('rail-panel-frame')
    expect(frame.className).toContain('sticky')
    expect(frame.className).not.toContain('fixed')
  })

  it('窗口窄于 900：没记过的先收着，露出来的工具也收进「⋮」', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('899px') || q.includes('1199px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    renderRail('/positions/asg_sup')
    expect(panelOpen()).toBe(false)
    expect(screen.queryByTestId('rail-icon-browser')).toBeNull()
    fireEvent.click(screen.getByTestId('rail-overflow'))
    const menu = await screen.findByTestId('rail-menu')
    expect(within(menu).getByTestId('rail-menu-browser')).toBeDefined()
    expect(within(menu).getByTestId('rail-menu-changes')).toBeDefined()
  })
})
