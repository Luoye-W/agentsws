/**
 * WP95：第三栏两个新面板（`docs/upstream/sidebar-compare.md` #11 / #12 / #15）。
 *
 * - **运行中的浏览器**：三种执行器各画一种；等人接管、被拦下、还没开过网页都要说清楚；
 *   **只给域名**（网址里常带订单号与一次性令牌，不往这一栏搬）。
 * - **变更审阅**：列这一轮的 staged change，点开逐文件 diff；
 *   行对比超时降级成粗粒度时**界面要说出来**——不说的话人会以为这个文件被整个重写了。
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChangeFilesView, MatterViewWithPeople, RunBrowserView, StagedChange } from '@/lib/api'
import { renderWithProviders } from './helpers'

const MATTER = {
  matter: { id: 'mat_1', title: '首页改版' },
  timeline: [
    { id: 'me_1', matter_id: 'mat_1', at: '2026-09-18T01:00:00.000Z', kind: 'note', text: '开始' },
    {
      id: 'me_2',
      matter_id: 'mat_1',
      at: '2026-09-18T02:00:00.000Z',
      kind: 'note',
      text: '跑了一轮',
      run_id: 'run_1',
    },
  ],
  has_more: false,
  todos: [],
  open_card_ids: [],
  pinned_labels: [],
  people: [],
} as unknown as MatterViewWithPeople

const getMatter = vi.fn(async () => MATTER)
const getRunBrowser = vi.fn<() => Promise<RunBrowserView>>()
const listChanges = vi.fn<() => Promise<StagedChange[]>>()
const getChangeFiles = vi.fn<() => Promise<ChangeFilesView>>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    getRunBrowser: (...a: unknown[]) => getRunBrowser(...(a as [])),
    listChanges: (...a: unknown[]) => listChanges(...(a as [])),
    getChangeFiles: (...a: unknown[]) => getChangeFiles(...(a as [])),
  }
})

const { RunBrowserPanel } = await import('@/components/rail/panels/run-browser-panel')
const { ChangesPanel } = await import('@/components/rail/panels/changes-panel')

const BASE: RunBrowserView = {
  run_id: 'run_1',
  executor: 'none',
  running: true,
  navigations: 0,
  blocked: 0,
}

function renderBrowser(route = '/matters/mat_1'): void {
  renderWithProviders(<RunBrowserPanel tier="position" pathname={route} />, route)
}

function renderChanges(route = '/matters/mat_1'): void {
  renderWithProviders(<ChangesPanel tier="position" pathname={route} />, route)
}

describe('运行中的浏览器（#12 / #15）', () => {
  it('官方 provider 那一种：说是哪种执行器、现在在哪家站上', async () => {
    getRunBrowser.mockResolvedValue({
      ...BASE,
      executor: 'playwright-mcp',
      current_host: 'shop.myshopify.com',
      last_navigation: {
        at: '2026-09-18T02:01:00.000Z',
        host: 'shop.myshopify.com',
        tool: 'mcp__playwright-mcp__browser_navigate',
      },
      navigations: 3,
    })
    renderBrowser()
    const box = await screen.findByTestId('rail-browser')
    expect(box.getAttribute('data-executor')).toBe('playwright-mcp')
    expect(screen.getByTestId('rail-browser-executor').textContent).toContain('独立浏览器')
    expect(screen.getByTestId('rail-browser-host').textContent).toContain('shop.myshopify.com')
    expect(screen.getByTestId('rail-browser-counts').textContent).toContain('3')
  })

  it('BrowserSkill 那一种：等人接管时把那句话摆到最上面', async () => {
    getRunBrowser.mockResolvedValue({
      ...BASE,
      executor: 'browserskill',
      current_host: 'admin.shopify.com',
      awaiting_handoff: { at: '2026-09-18T02:05:00.000Z', note: 'browser_assist' },
    })
    renderBrowser()
    expect((await screen.findByTestId('rail-browser-executor')).textContent).toContain(
      'BrowserSkill',
    )
    expect(screen.getByTestId('rail-browser-handoff')).toBeDefined()
  })

  it('一个浏览器工具都没调过：照实说，不画一个空壳浏览器', async () => {
    getRunBrowser.mockResolvedValue({ ...BASE, executor: 'none', running: false })
    renderBrowser()
    expect((await screen.findByTestId('rail-browser-executor')).textContent).toContain(
      '没有开过浏览器',
    )
    expect(screen.getByTestId('rail-browser-nowhere')).toBeDefined()
  })

  it('被门禁拦下来的那一次也看得见（白名单外的站）', async () => {
    getRunBrowser.mockResolvedValue({
      ...BASE,
      executor: 'browserskill',
      last_blocked: {
        at: '2026-09-18T02:06:00.000Z',
        tool: 'browser_page',
        reason: 'browser_host_not_allowed: example.com 不在这个岗位开放的站里',
      },
      blocked: 1,
    })
    renderBrowser()
    expect((await screen.findByTestId('rail-browser-blocked')).textContent).toContain(
      'browser_host_not_allowed',
    )
  })

  it('不在事项页 / 这件事还没跑过：照实说，不去打一条注定 404 的接口', async () => {
    renderBrowser('/')
    expect(await screen.findByTestId('rail-browser-no-matter')).toBeDefined()
    expect(getRunBrowser).not.toHaveBeenCalled()
  })
})

describe('变更审阅：逐文件 diff（#11）', () => {
  const CHANGE = {
    id: 'chg_1',
    kind: 'publish_theme',
    status: 'staged',
  } as unknown as StagedChange

  it('列出这一轮的变更，点开一条 → 逐文件；再点一个文件 → 那几行', async () => {
    listChanges.mockResolvedValue([CHANGE])
    getChangeFiles.mockResolvedValue({
      change_id: 'chg_1',
      kind: 'publish_theme',
      available: true,
      store: 'shop',
      truncated: false,
      files: [
        {
          path: 'sections/header.liquid',
          status: 'modified',
          additions: 4,
          deletions: 1,
          diff: '@@ -1,3 +1,6 @@\n-<h1>旧标题</h1>\n+<h1>新标题</h1>',
          truncated: false,
          coarse: false,
          binary: false,
        },
      ],
    })
    renderChanges()
    fireEvent.click(await screen.findByTestId('rail-changes-item-chg_1'))
    fireEvent.click(await screen.findByTestId('rail-changes-file-sections/header.liquid'))
    expect(screen.getByText('+<h1>新标题</h1>')).toBeDefined()
    expect(screen.getByText('-<h1>旧标题</h1>')).toBeDefined()
  })

  it('行对比超时降级成粗粒度：界面要说出来，不能装成"整个重写了"', async () => {
    listChanges.mockResolvedValue([CHANGE])
    getChangeFiles.mockResolvedValue({
      change_id: 'chg_1',
      kind: 'publish_theme',
      available: true,
      truncated: false,
      files: [
        {
          path: 'assets/theme.css',
          status: 'modified',
          additions: 900,
          deletions: 880,
          diff: '',
          truncated: false,
          coarse: true,
          binary: false,
        },
      ],
    })
    renderChanges()
    fireEvent.click(await screen.findByTestId('rail-changes-item-chg_1'))
    fireEvent.click(await screen.findByTestId('rail-changes-file-assets/theme.css'))
    expect((await screen.findByTestId('rail-changes-coarse')).textContent).toContain('超时')
  })

  it('这台机器上没有这份工作副本：照实说（不是错误，是常态）', async () => {
    listChanges.mockResolvedValue([CHANGE])
    getChangeFiles.mockResolvedValue({
      change_id: 'chg_1',
      kind: 'publish_theme',
      available: false,
      detail: '这份主题副本不是 git 仓库，比不出改了哪几行',
      truncated: false,
      files: [],
    })
    renderChanges()
    fireEvent.click(await screen.findByTestId('rail-changes-item-chg_1'))
    expect((await screen.findByTestId('rail-changes-unavailable')).textContent).toContain(
      'git 仓库',
    )
  })

  it('这一轮没有改文件的变更（改价、退款那些不进这一栏）', async () => {
    listChanges.mockResolvedValue([{ ...CHANGE, kind: 'price_change' } as unknown as StagedChange])
    renderChanges()
    expect(await screen.findByTestId('rail-changes-empty')).toBeDefined()
  })

  it('不在事项页：照实说，一条接口都不打', async () => {
    listChanges.mockClear()
    renderChanges('/')
    expect(await screen.findByTestId('rail-changes-no-matter')).toBeDefined()
    expect(listChanges).not.toHaveBeenCalled()
  })
})
