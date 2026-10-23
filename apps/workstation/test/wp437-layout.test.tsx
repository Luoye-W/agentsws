/**
 * WP437（Luoye 10-21）：三栏口径落地。
 *
 * - 看板（卡片列）属于中栏：中栏可用宽度（窗口 − 左栏 − 并排开着的第三栏）放不下「核心区最小宽度 600 + 看板」时自动隐藏，
 *   放得下了自己回来；隐藏时顶栏一颗「看一眼」，点了看板浮在内容上、点外面收回；
 * - 第三栏宿主统一入口 `openRightPane({ kind, id })`（WP438 的报表视图挂进来）；
 * - 并排之后核心区保不住最小宽度时，第三栏改成盖在中栏上。
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
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
const {
  REPORT_PANE_PREFIX,
  currentPane,
  markPinned,
  openRightPane,
  closeRightPane,
  paneWidth,
  resetRightPane,
  rightPaneRoute,
} = await import('@/components/rail/right-pane')
const { CORE_MIN_WIDTH, ShellSizeContext, boardWidthAt, columnsLayout } = await import(
  '@/components/rail/board-fit'
)
const { REPORT_ADDRESS_PREFIX } = await import('@/components/reports/report-data')
const { resetSidePaneMode } = await import('@/lib/side-pane-window')

/**
 * WP481（决策 1632）：第三栏只有在桌面壳把窗口加宽了才并排（浏览器里一律浮层）。
 * 这里的外壳宽度是写死的，所以「加宽了但宽度没变」= 加宽之后人又把窗口拖窄了——并排挤窄、看板让位那一套照旧。
 */
function widenedShell(): void {
  ;(window as unknown as { agentsws?: unknown }).agentsws = {
    sidePane: { sync: async (w: number | null) => (w === null ? 'none' : 'widened') },
  }
}

let box = new Map<string, string>()
beforeEach(() => {
  resetRightPane()
  resetSidePaneMode()
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
  ;(window as unknown as { agentsws?: unknown }).agentsws = undefined
})

/** 外面点一下 / 开第三栏用。 */
function Probe(): ReactNode {
  const rail = useRailState()
  return (
    <>
      <button type="button" data-testid="outside">
        outside
      </button>
      <button
        type="button"
        data-testid="open-report"
        onClick={() => rail.openRightPane({ kind: 'report', id: 'rep_1' })}
      >
        report
      </button>
      <button
        type="button"
        data-testid="open-browser"
        onClick={() => rail.openRightPane({ kind: 'browser' })}
      >
        browser
      </button>
      <button type="button" data-testid="close-pane" onClick={() => rail.closeRightPane()}>
        close
      </button>
    </>
  )
}

function renderAt(size: { body: number; viewport: number }, route = '/positions/asg_sup'): void {
  renderWithProviders(
    <ShellSizeContext.Provider value={size}>
      <RailStateProvider>
        <RightRail instances={[INSTANCE]} />
        <Probe />
      </RailStateProvider>
    </ShellSizeContext.Provider>,
    route,
    'asg_sup',
  )
}

describe('三栏怎么摆（board-fit 的算法）', () => {
  const SIDEBAR = 240
  const at = (viewport: number, third: number | null = null, sidebar = SIDEBAR) =>
    columnsLayout({ size: { body: viewport - sidebar, viewport }, third, narrow: viewport < 900 })

  it('核心区最小宽度 600；看板 300–400（窗口的 26%）', () => {
    expect(CORE_MIN_WIDTH).toBe(600)
    expect(boardWidthAt(1000)).toBe(300)
    expect(boardWidthAt(1440)).toBe(374)
    expect(boardWidthAt(1920)).toBe(400)
  })

  it('第三栏收着：左栏展开时窗口 ≥ 1140 看板在，窄了自动隐藏；左栏收成图标列时 ≥ 952 就在', () => {
    expect(at(1440).board).toBe(true)
    expect(at(1140).board).toBe(true)
    expect(at(1139).board).toBe(false)
    expect(at(1000).board).toBe(false)
    expect(at(1000, null, 52).board).toBe(true)
    expect(at(951, null, 52).board).toBe(false)
  })

  it('第三栏开着（默认 380 宽）：并排挤窄了看板就隐藏；连核心区都保不住时第三栏盖上去', () => {
    // 宽：三栏 + 看板都放得下
    const wide = at(1920, 380)
    expect(wide).toMatchObject({ board: true, overlay: false, third: 380 })
    // 中：第三栏并排，看板让位
    const medium = at(1440, 380)
    expect(medium).toMatchObject({ board: false, overlay: false, third: 380 })
    expect(medium.core).toBe(1440 - 240 - 380)
    // 窄：并排后核心区不到 600 → 第三栏盖在中栏上，看板照「没有第三栏」算
    const narrow = at(1100, 380)
    expect(narrow).toMatchObject({ board: false, overlay: true, third: 0 })
    // 很窄（< 900）：一律盖上去
    expect(at(880, 320).overlay).toBe(true)
  })

  it('量不到宽度（没有外壳 / 单测）：看板照常、第三栏只在窄于 900 时盖上去', () => {
    expect(
      columnsLayout({ size: { body: 0, viewport: 0 }, third: 380, narrow: false }),
    ).toMatchObject({ board: true, overlay: false })
    expect(
      columnsLayout({ size: { body: 0, viewport: 0 }, third: 380, narrow: true }).overlay,
    ).toBe(true)
  })
})

describe('看板自动隐藏 + 「看一眼」', () => {
  it('够宽：看板在中栏右边，顶栏没有「看一眼」', async () => {
    renderAt({ body: 1200, viewport: 1440 })
    expect(await screen.findByTestId('rail-board')).toBeDefined()
    expect(screen.getByTestId('rail-board').style.width).toBe('374px')
    expect(screen.queryByTestId('board-peek')).toBeNull()
  })

  it('窄：看板隐藏，顶栏出「看一眼」；点了看板浮在内容上，点外面收回；不在本机记任何东西', async () => {
    renderAt({ body: 760, viewport: 1000 })
    const peek = await screen.findByTestId('board-peek')
    expect(screen.queryByTestId('rail-board')).toBeNull()
    expect(peek.getAttribute('aria-pressed')).toBe('false')
    const before = new Map(box)
    fireEvent.click(peek)
    const floating = await screen.findByTestId('rail-board-peek')
    expect(floating.className).toContain('fixed')
    expect(await screen.findByTestId('rail-cards')).toBeDefined()
    expect(screen.getByTestId('board-peek').getAttribute('aria-pressed')).toBe('true')
    // 浮层里面点不收
    fireEvent.mouseDown(floating)
    expect(screen.getByTestId('rail-board-peek')).toBeDefined()
    // 外面点收回
    fireEvent.mouseDown(screen.getByTestId('outside'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-board-peek')).toBeNull()
    })
    // 再点图标又开、再点图标收（图标自己管开关，不被「点外面」抢先收掉再打开）
    fireEvent.mouseDown(screen.getByTestId('board-peek'))
    fireEvent.click(screen.getByTestId('board-peek'))
    expect(await screen.findByTestId('rail-board-peek')).toBeDefined()
    fireEvent.mouseDown(screen.getByTestId('board-peek'))
    fireEvent.click(screen.getByTestId('board-peek'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-board-peek')).toBeNull()
    })
    // Esc 也收
    fireEvent.click(screen.getByTestId('board-peek'))
    await screen.findByTestId('rail-board-peek')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('rail-board-peek')).toBeNull()
    })
    expect(box).toEqual(before)
  })

  it('（桌面壳加宽后人又拖窄了窗口）并排的第三栏把中栏挤窄：看板自动隐藏、出「看一眼」；收起第三栏看板回来', async () => {
    widenedShell()
    renderAt({ body: 1200, viewport: 1440 })
    expect(await screen.findByTestId('rail-board')).toBeDefined()
    fireEvent.click(screen.getByTestId('open-browser'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-board')).toBeNull()
    })
    const frame = screen.getByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-layout')).toBe('docked')
    expect(frame.getAttribute('data-board')).toBe('hidden')
    expect(screen.getByTestId('board-peek')).toBeDefined()
    // 看一眼时浮层贴在第三栏左边
    fireEvent.click(screen.getByTestId('board-peek'))
    expect((await screen.findByTestId('rail-board-peek')).style.right).toBe('380px')
    fireEvent.click(screen.getByTestId('close-pane'))
    expect(await screen.findByTestId('rail-board')).toBeDefined()
    expect(screen.queryByTestId('board-peek')).toBeNull()
    expect(screen.queryByTestId('rail-board-peek')).toBeNull()
  })

  it('并排后核心区保不住：第三栏盖在中栏上（WP485：不再有遮罩挡住中栏），看板按没有第三栏算', async () => {
    renderAt({ body: 860, viewport: 1100 })
    fireEvent.click(await screen.findByTestId('open-browser'))
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-layout')).toBe('overlay')
    expect(screen.queryByTestId('rail-scrim')).toBeNull()
  })

  it('首页没有看板，也就没有「看一眼」', async () => {
    renderAt({ body: 760, viewport: 1000 }, '/')
    await screen.findByTestId('right-rail')
    expect(screen.queryByTestId('board-peek')).toBeNull()
    expect(screen.queryByTestId('rail-board')).toBeNull()
  })
})

describe('第三栏宿主：openRightPane({ kind, id })', () => {
  it('每种目标落到哪儿', () => {
    expect(REPORT_PANE_PREFIX).toBe(REPORT_ADDRESS_PREFIX)
    expect(rightPaneRoute({ kind: 'report', id: 'rep_1' })).toEqual({
      address: 'agentsws://report/rep_1',
    })
    expect(rightPaneRoute({ kind: 'report', id: 'rep_1', position: 'web-ops' })).toEqual({
      address: 'agentsws://report/rep_1',
    })
    expect(rightPaneRoute({ kind: 'report-compose', prompt: '做一份报表：' })).toEqual({
      panel: 'report-compose',
    })
    expect(rightPaneRoute({ kind: 'browser' })).toEqual({ panel: 'browser' })
    expect(rightPaneRoute({ kind: 'changes' })).toEqual({ panel: 'changes' })
    expect(rightPaneRoute({ kind: 'panel', id: 'memory' })).toEqual({ panel: 'memory' })
    expect(rightPaneRoute({ kind: 'address', address: 'agentsws://file/a.pdf' })).toEqual({
      address: 'agentsws://file/a.pdf',
    })
  })

  it('开一份报表：第三栏开「report」那一格（同一时间一格，换成别的就换掉），× / closeRightPane 收起', async () => {
    widenedShell()
    renderAt({ body: 1700, viewport: 1940 })
    fireEvent.click(await screen.findByTestId('open-report'))
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-panel')).toBe('report')
    expect(frame.getAttribute('data-layout')).toBe('docked')
    // 宽屏：看板照旧在（三栏并排）
    expect(screen.getByTestId('rail-board')).toBeDefined()
    fireEvent.click(screen.getByTestId('open-browser'))
    expect(screen.getAllByTestId('rail-panel-frame')).toHaveLength(1)
    expect(screen.getByTestId('rail-panel-frame').getAttribute('data-panel')).toBe('browser')
    fireEvent.click(screen.getByTestId('rail-panel-close'))
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    fireEvent.click(screen.getByTestId('open-report'))
    await screen.findByTestId('rail-panel-frame')
    fireEvent.click(screen.getByTestId('close-pane'))
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })

  it('报表那两格至少 560 宽（人拖得更宽照旧）；别的格子照拖出来的宽度', () => {
    expect(paneWidth('report', 380)).toBe(560)
    expect(paneWidth('report-compose', 380)).toBe(560)
    expect(paneWidth('report', 640)).toBe(640)
    expect(paneWidth('browser', 380)).toBe(380)
    expect(paneWidth(undefined, 380)).toBe(380)
  })

  it('模块级 openRightPane（WP438 用的那个，同名同形）：开进外壳的第三栏、带着参数；× 收起时参数清掉', async () => {
    // 没有宿主时开不出来
    expect(openRightPane({ kind: 'report', id: 'rep_0' })).toBe(false)
    renderAt({ body: 1700, viewport: 1940 })
    await screen.findByTestId('rail-board')
    let ok = false
    act(() => {
      ok = openRightPane({ kind: 'report', id: 'rep_2', position: 'web-ops', duty: 'web.seo' })
    })
    expect(ok).toBe(true)
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-panel')).toBe('report')
    // 报表那一格至少 560 宽
    expect(frame.style.width).toBe('560px')
    expect(currentPane().pane).toEqual({
      kind: 'report',
      id: 'rep_2',
      position: 'web-ops',
      duty: 'web.seo',
    })
    act(() => {
      markPinned('rep_2')
    })
    expect(currentPane().pinned).toBe('rep_2')
    fireEvent.click(screen.getByTestId('rail-panel-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
    expect(currentPane().pane).toBeNull()
    // 做一份报表那一格：宿主认得（身体由 WP438 挂）
    act(() => {
      openRightPane({ kind: 'report-compose', prompt: '做一份报表：' })
    })
    expect((await screen.findByTestId('rail-panel-frame')).getAttribute('data-panel')).toBe(
      'report-compose',
    )
    // 换成别的格子：参数换成那一格的；人点顶栏图标直接开（不经口子）时参数清掉
    fireEvent.click(screen.getByTestId('open-browser'))
    expect(currentPane().pane).toEqual({ kind: 'browser' })
    act(() => {
      openRightPane({ kind: 'report-compose' })
    })
    await screen.findByTestId('rail-panel-report-compose')
    fireEvent.click(screen.getByTestId('rail-icon-changes'))
    await waitFor(() => {
      expect(currentPane().pane).toBeNull()
    })
    act(() => {
      closeRightPane()
    })
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })

  it('报表按 560 宽算挤不挤（窗口已为它加宽）：1440 宽并排、看板让位；1399 盖上去；看板按「窗口 − 第三栏」定宽', () => {
    const at = (viewport: number, third: number) =>
      columnsLayout({ size: { body: viewport - 240, viewport }, third, narrow: false })
    expect(at(1440, paneWidth('report', 380))).toMatchObject({ overlay: false, board: false })
    expect(at(1399, paneWidth('report', 380)).overlay).toBe(true)
    expect(at(1400, paneWidth('report', 380)).overlay).toBe(false)
    // WP481：看板宽度不跟着为第三栏加出来的那一截变（1700 − 560 = 1140 → 看板 300）
    expect(at(1700, paneWidth('report', 380))).toMatchObject({ board: true, boardWidth: 300 })
    expect(at(1699, paneWidth('report', 380)).board).toBe(false)
  })
})
