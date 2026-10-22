/**
 * WP298：页面出错不再一片空白。
 *
 * - 某一页渲染抛错 → 主区换成「这一页出错了」+ 重新加载 / 回首页 + 技术信息；左栏还在、点别的页就复原；
 * - 接住的同时记一条日志（发给 `POST /v1/client-errors`，洗过）；
 * - 右栏面板那一层只换掉那一块；
 * - `vite:preloadError` → 整页重载一次，30 秒内再来不再重载（不死循环）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { ErrorBoundary } from '@/components/error-boundary'
import type { PositionSummary } from '@/lib/api'
import { AppProvider } from '@/lib/app-context'
import {
  _setClientErrorSender,
  type ClientErrorReport,
  installGlobalErrorReporting,
  reportClientError,
  sanitizeReport,
  technicalLine,
} from '@/lib/client-errors'
import { handlePreloadError, PRELOAD_RELOAD_KEY } from '@/lib/preload-reload'
import { renderWithProviders } from './helpers'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => [],
    getPositions: async () => ({ positions }),
  }
})

const positions: PositionSummary[] = [
  {
    position_id: 'asg_1',
    role_id: 'dtc.support',
    role_name: '独立站售后客服',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

let sent: ClientErrorReport[] = []
beforeEach(() => {
  sent = []
  _setClientErrorSender((body) => {
    sent.push(JSON.parse(body) as ClientErrorReport)
  })
  // React 会把接住的错误打到 console.error；测试里不看它
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  _setClientErrorSender()
  vi.restoreAllMocks()
})

function Boom(): ReactNode {
  throw new TypeError('Cannot read properties of undefined (reading wang@nordvolt.example)')
}

describe('页面层错误边界', () => {
  it('一页抛错：主区出「这一页出错了」，左栏还在；点别的页复原', async () => {
    renderWithProviders(
      <AppShell positions={positions} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
        <Routes>
          <Route path="/im-channels" element={<Boom />} />
          <Route path="/planner" element={<p>日历页</p>} />
        </Routes>
      </AppShell>,
      '/im-channels',
    )
    const crash = await screen.findByTestId('crash-page')
    expect(crash.textContent).toContain('这一页出错了')
    expect(screen.getByTestId('crash-reload').textContent).toBe('重新加载')
    expect(screen.getByTestId('crash-home').textContent).toBe('回首页')
    // 技术信息：错误名 + 第一行，邮箱已洗掉
    const detail = screen.getByTestId('crash-detail').textContent ?? ''
    expect(detail).toContain('TypeError: Cannot read properties of undefined')
    expect(detail).not.toContain('@nordvolt')
    // 左栏照常可用
    const nav = screen.getByTestId('main-nav')
    // WP342：连接收进了账号菜单，左栏点「日历与待办」（WP469）
    const link = nav.querySelector('a[href="/planner"]')
    expect(link).not.toBeNull()
    fireEvent.click(link as Element)
    expect(await screen.findByText('日历页')).toBeTruthy()
    expect(screen.queryByTestId('crash-page')).toBeNull()
    // 记了一条（洗过），路径只有 pathname
    expect(sent.length).toBe(1)
    expect(sent[0]?.kind).toBe('boundary')
    expect(sent[0]?.scope).toBe('page')
    expect(sent[0]?.name).toBe('TypeError')
    expect(sent[0]?.message).toContain('<email>')
  })

  it('回首页：走路由回到 /，复原', async () => {
    renderWithProviders(
      <AppShell positions={positions} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
        <Routes>
          <Route path="/" element={<p>首页内容</p>} />
          <Route path="/im-channels" element={<Boom />} />
        </Routes>
      </AppShell>,
      '/im-channels',
    )
    fireEvent.click(await screen.findByTestId('crash-home'))
    expect(await screen.findByText('首页内容')).toBeTruthy()
    expect(screen.queryByTestId('crash-page')).toBeNull()
  })
})

describe('面板层与最外层', () => {
  it('面板：只换掉那一块，没有「回首页」', () => {
    render(
      <AppProvider initialLang="zh">
        <p>别的</p>
        <ErrorBoundary scope="panel" label="panel:help">
          <Boom />
        </ErrorBoundary>
      </AppProvider>,
    )
    expect(screen.getByTestId('crash-panel').textContent).toContain('这一块没加载出来')
    expect(screen.queryByTestId('crash-home')).toBeNull()
    expect(screen.getByText('别的')).toBeTruthy()
    expect(sent[0]?.kind).toBe('panel')
    expect(sent[0]?.scope).toBe('panel:help')
  })

  it('最外层：没有 AppProvider 也能出兜底（默认中文）', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary scope="shell">
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('crash-shell').textContent).toContain('这一页出错了')
    expect(screen.getByTestId('crash-home')).toBeTruthy()
  })
})

describe('前端报错洗干净再发', () => {
  it('去查询串、去本机源、去个人数据、截长度、只留第一行', () => {
    const out = sanitizeReport({
      kind: 'error',
      name: 'Error',
      message: `failed http://127.0.0.1:4317/v1/x?token=abc&email=a@b.com\nsecond line ${'x'.repeat(50)}`,
      stack: `Error: x\n    at f (http://127.0.0.1:4317/assets/index-abc.js?v=1:1:2)\n${'    at g (https://example.com/a.js?q=1:1:1)\n'.repeat(20)}`,
      route: '/connections?service=shopify_admin#x',
    })
    expect(out.message).toBe('failed /v1/x')
    expect(out.route).toBe('/connections')
    expect(out.stack).toContain('/assets/index-abc.js:1:2')
    expect(out.stack).not.toContain('?')
    expect(out.stack?.split('\n').length).toBeLessThanOrEqual(8)
    const long = sanitizeReport({ kind: 'error', name: 'E', message: 'm'.repeat(5000), route: '/' })
    expect(long.message.length).toBeLessThanOrEqual(300)
    expect(
      sanitizeReport({ kind: 'error', name: 'E', message: '13800138000', route: '/' }).message,
    ).toBe('<num>')
  })

  it('同一条一分钟内只发一次；一次打开最多 20 条', () => {
    expect(reportClientError('error', new Error('a'), { now: 1_000 })).toBe(true)
    expect(reportClientError('error', new Error('a'), { now: 2_000 })).toBe(false)
    expect(reportClientError('error', new Error('a'), { now: 62_000 })).toBe(true)
    for (let i = 0; i < 40; i += 1) reportClientError('error', new Error(`n${String(i)}`))
    expect(sent.length).toBe(20)
  })

  it('window 的 error / unhandledrejection 都记', () => {
    const stop = installGlobalErrorReporting(window)
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('r1'), message: 'r1' }))
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
    rejection.reason = new Error('p1')
    window.dispatchEvent(rejection)
    stop()
    expect(sent.map((s) => `${s.kind}:${s.message}`)).toEqual(['error:r1', 'rejection:p1'])
  })

  it('技术信息一行：错误名 + 第一行', () => {
    expect(technicalLine(new SyntaxError('bad\nmore'))).toBe('SyntaxError: bad')
    expect(technicalLine('plain')).toBe('string: plain')
  })
})

describe('vite:preloadError', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const m = new Map<string, string>()
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => {
        m.set(k, v)
      },
    }
  }

  it('第一次重载；30 秒内再来不再重载（不死循环）；过了 30 秒又可以', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    let now = 100_000
    const fire = (): boolean => {
      const event = new Event('vite:preloadError', { cancelable: true })
      return handlePreloadError(event, { storage, reload, now: () => now })
    }
    expect(fire()).toBe(true)
    expect(storage.getItem(PRELOAD_RELOAD_KEY)).toBe('100000')
    now += 5_000
    expect(fire()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    now += 60_000
    expect(fire()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
    expect(sent.some((s) => s.kind === 'preload')).toBe(true)
  })

  it('存储用不了：不重载（重载后无从知道刚重载过）', () => {
    const reload = vi.fn()
    const event = new Event('vite:preloadError', { cancelable: true })
    expect(handlePreloadError(event, { storage: undefined, reload, now: () => 1 })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
