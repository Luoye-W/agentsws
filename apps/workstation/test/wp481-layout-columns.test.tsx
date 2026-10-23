/**
 * WP481（决策 1632 / 1634，Luoye 10-23）：右栏不挤中栏、左栏收窄。
 *
 * - 浏览器里（没有桌面壳的 `sidePane`）：第三栏一律从右侧滑出盖在中栏右侧，中栏（核心区 + 看板）不重排；点外面 / Esc 收；
 * - 桌面壳：开第三栏时请壳把窗口向右加宽它那么宽（壳回 `widened` → 并排，中栏宽度和开之前一样）；
 *   最大化 / 全屏 / 右边没地方（壳回 `overlay`）→ 浮层；关掉请壳缩回；
 * - 左栏展开宽 208（原 240），名字悬停看全名。
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
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
const { resetRightPane } = await import('@/components/rail/right-pane')
const { ShellSizeContext, columnsLayout } = await import('@/components/rail/board-fit')
const { CLOSE_SETTLE_MS, WIDTH_SETTLE_MS, resetSidePaneMode } = await import(
  '@/lib/side-pane-window'
)

type Answer = 'widened' | 'overlay' | 'none'
let calls: (number | null)[] = []
/** 假装是桌面壳：`answer` 决定能不能加宽（最大化 / 全屏 / 右边没地方时壳回 overlay）。 */
function desktopShell(answer: (w: number) => Answer): void {
  ;(window as unknown as { agentsws?: unknown }).agentsws = {
    sidePane: {
      sync: async (w: number | null): Promise<Answer> => {
        calls.push(w)
        return w === null ? 'none' : answer(w)
      },
    },
  }
}

let box = new Map<string, string>()
beforeEach(() => {
  resetRightPane()
  resetSidePaneMode()
  calls = []
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
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  ;(window as unknown as { agentsws?: unknown }).agentsws = undefined
})

let setSize: (size: { body: number; viewport: number }) => void = () => undefined

function Probe(): ReactNode {
  const rail = useRailState()
  const navigate = useNavigate()
  return (
    <>
      <button
        type="button"
        data-testid="go-duty"
        onClick={() => navigate('/positions/asg_sup/duties/dtc.support')}
      >
        duty
      </button>
      <button
        type="button"
        data-testid="go-position"
        onClick={() => navigate('/positions/asg_sup')}
      >
        position
      </button>
      <button type="button" data-testid="outside">
        outside
      </button>
      <button
        type="button"
        data-testid="open-browser"
        onClick={() => rail.openRightPane({ kind: 'browser' })}
      >
        browser
      </button>
      <button
        type="button"
        data-testid="open-report"
        onClick={() => rail.openRightPane({ kind: 'report', id: 'rep_1' })}
      >
        report
      </button>
      <button type="button" data-testid="close-pane" onClick={() => rail.closeRightPane()}>
        close
      </button>
    </>
  )
}

/** 外壳宽度可以改（桌面壳加宽窗口后外壳量出来的宽度跟着变）。 */
function Sized({
  start,
  children,
}: {
  start: { body: number; viewport: number }
  children: ReactNode
}) {
  const [size, set] = useState(start)
  setSize = set
  return <ShellSizeContext.Provider value={size}>{children}</ShellSizeContext.Provider>
}

function renderAt(size: { body: number; viewport: number }, route = '/positions/asg_sup'): void {
  renderWithProviders(
    <Sized start={size}>
      <RailStateProvider>
        <RightRail instances={[INSTANCE]} />
        <Probe />
      </RailStateProvider>
    </Sized>,
    route,
    'asg_sup',
  )
}

describe('浏览器里：第三栏一律浮层，不挤中栏', () => {
  it('开浏览器：从右侧滑出盖在中栏右侧（带阴影），看板不让位、宽度不变；点外面收', async () => {
    renderAt({ body: 1200, viewport: 1440 })
    const board = await screen.findByTestId('rail-board')
    expect(board.style.width).toBe('374px')
    fireEvent.click(screen.getByTestId('open-browser'))
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-layout')).toBe('overlay')
    expect(frame.className).toContain('fixed')
    expect(frame.className).toContain('shadow-2xl')
    expect(frame.className).toContain('slide-in-from-right')
    expect(frame.getAttribute('data-board')).toBe('shown')
    // 中栏不重排：看板还在、还是那么宽，也没出「看一眼」
    expect(screen.getByTestId('rail-board').style.width).toBe('374px')
    expect(screen.queryByTestId('board-peek')).toBeNull()
    // 浮层也能拖宽
    expect(screen.getByTestId('rail-resize')).toBeDefined()
    // 点外面（透明的接点击的底，不压暗中栏）收起
    const scrim = screen.getByTestId('rail-scrim')
    expect(scrim.className).toContain('bg-transparent')
    fireEvent.click(scrim)
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
  })

  it('Esc 收起；浮层里开着菜单时 Esc 先归菜单', async () => {
    renderAt({ body: 1200, viewport: 1440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    await screen.findByTestId('rail-panel-frame')
    // 有个菜单开着（比如「⋮」）：Esc 不收右栏
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('rail-panel-frame')).toBeDefined()
    menu.remove()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
  })

  it('很宽的窗口也是浮层（浏览器里没法加宽窗口）', async () => {
    renderAt({ body: 2200, viewport: 2440 })
    fireEvent.click(await screen.findByTestId('open-report'))
    expect((await screen.findByTestId('rail-panel-frame')).getAttribute('data-layout')).toBe(
      'overlay',
    )
  })
})

describe('桌面壳：窗口向右加宽，中栏宽度不变', () => {
  it('开：请壳加宽右栏那么宽（380），壳加宽了 → 并排；中栏（核心区 + 看板）和开之前一样宽', async () => {
    desktopShell(() => 'widened')
    renderAt({ body: 1200, viewport: 1440 })
    const before = columnsLayout({
      size: { body: 1200, viewport: 1440 },
      third: null,
      narrow: false,
    })
    expect((await screen.findByTestId('rail-board')).style.width).toBe('374px')
    fireEvent.click(screen.getByTestId('open-browser'))
    await waitFor(() => {
      expect(calls).toContain(380)
    })
    // 窗口变宽了 380：外壳量出来的宽度跟着变
    act(() => {
      setSize({ body: 1580, viewport: 1820 })
    })
    const frame = await screen.findByTestId('rail-panel-frame')
    await waitFor(() => {
      expect(frame.getAttribute('data-layout')).toBe('docked')
    })
    expect(frame.style.width).toBe('380px')
    // 看板还在、宽度没变（按「窗口 − 第三栏」定宽）
    expect(screen.getByTestId('rail-board').style.width).toBe('374px')
    const after = columnsLayout({
      size: { body: 1580, viewport: 1820 },
      third: 380,
      narrow: false,
      docking: 'widened',
    })
    expect(after.core).toBe(before.core)
    expect(after.boardWidth).toBe(before.boardWidth)
  })

  it('关：请壳缩回（停一下再缩，换一格时窗口不来回弹）', async () => {
    desktopShell(() => 'widened')
    renderAt({ body: 1200, viewport: 1440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    await screen.findByTestId('rail-panel-frame')
    calls = []
    fireEvent.click(screen.getByTestId('close-pane'))
    expect(calls).toEqual([])
    await waitFor(
      () => {
        expect(calls).toEqual([null])
      },
      { timeout: CLOSE_SETTLE_MS + 1000 },
    )
  })

  it('换一格（浏览器 380 → 报表 560）：请壳按新宽度重新加宽', async () => {
    desktopShell(() => 'widened')
    renderAt({ body: 1200, viewport: 1440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    await screen.findByTestId('rail-panel-frame')
    fireEvent.click(screen.getByTestId('open-report'))
    await waitFor(
      () => {
        expect(calls.at(-1)).toBe(560)
      },
      { timeout: WIDTH_SETTLE_MS + 1000 },
    )
  })

  it('最大化 / 全屏 / 右边没地方：壳回 overlay → 浮层，中栏不重排', async () => {
    desktopShell(() => 'overlay')
    renderAt({ body: 2200, viewport: 2440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    const frame = await screen.findByTestId('rail-panel-frame')
    await waitFor(() => {
      expect(frame.getAttribute('data-layout')).toBe('overlay')
    })
    expect(screen.getByTestId('rail-scrim')).toBeDefined()
    expect(screen.getByTestId('rail-board')).toBeDefined()
  })

  it('等壳回话的那一下先不画（不先挤一下中栏）', async () => {
    let release: (a: Answer) => void = () => undefined
    ;(window as unknown as { agentsws?: unknown }).agentsws = {
      sidePane: {
        sync: (w: number | null) =>
          w === null
            ? Promise.resolve('none')
            : new Promise<Answer>((resolve) => {
                release = resolve
              }),
      },
    }
    renderAt({ body: 1200, viewport: 1440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    act(() => {
      release('widened')
    })
    expect(await screen.findByTestId('rail-panel-frame')).toBeDefined()
  })
})

describe('换页时第三栏跟着人走（窗口不来回弹）', () => {
  it('开着浏览器从岗位页进职责页：还开着；在职责页收起再回岗位页：照旧收着（不按岗位页上次记的弹出来）', async () => {
    renderAt({ body: 1200, viewport: 1440 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    expect((await screen.findByTestId('rail-panel-frame')).getAttribute('data-panel')).toBe(
      'browser',
    )
    fireEvent.click(screen.getByTestId('go-duty'))
    await waitFor(() => {
      expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('browser')
    })
    fireEvent.click(screen.getByTestId('close-pane'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
    fireEvent.click(screen.getByTestId('go-position'))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })
})
