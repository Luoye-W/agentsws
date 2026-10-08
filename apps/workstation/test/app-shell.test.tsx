/**
 * WP43 §1：左栏每一条都带图标。
 *
 * 断言的是「每个 NavLink 里有一个 svg」——图标换成别的 lucide 图形不该让测试红，
 * 但漏掉一条就该红。
 */
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import type { PositionSummary } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { COMPANY_ORG, SOLO_ORG } from './mode-words'

/** WP271：组织（不给 = 读不到，按 ③ 兜底——老用例全走这一档）。 */
const modeState = vi.hoisted(() => ({ orgs: [] as unknown[] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => modeState.orgs,
    getPositions: async () => ({ positions }),
  }
})

beforeEach(() => {
  modeState.orgs = []
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
  {
    position_id: 'asg_2',
    role_id: 'common.owner',
    role_name: '公司设置与授权',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

function renderShell(): void {
  renderWithProviders(
    <AppShell positions={positions} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
      <div>主区</div>
    </AppShell>,
  )
}

describe('左栏（WP43 §1 图标）', () => {
  it('每个导航项都有一个 svg 图标', () => {
    renderShell()
    const nav = screen.getByTestId('main-nav')
    const links = Array.from(nav.querySelectorAll('a'))
    // 固定 13 条（WP85 加了「消息渠道」，WP188 加了「随便聊」）+ 岗位 1 条
    // （WP234：「公司设置与授权」是负责人身份，不在左栏「岗位」里）
    expect(links).toHaveLength(14)
    expect(nav.textContent).not.toContain('公司设置与授权')
    for (const link of links) {
      expect(link.querySelector('svg'), `「${link.textContent ?? ''}」少了图标`).not.toBeNull()
    }
  })

  /**
   * WP113（63 §1）：左栏那一格从「目标」换成「**消息**」。
   *
   * 钉两件事：顺序是 首页 / 消息 / 待办 / 日历，而且 `/goals` **不在左栏里**了
   * （路由还在、⌘K 还搜得到、待办页有一个 tab——那几条各自有自己的用例）。
   */
  it('左栏顺序：随便聊 / 首页 / 消息 / 待办 / 日历；目标不在左栏里了', () => {
    renderShell()
    const nav = screen.getByTestId('main-nav')
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    // WP188（Luoye 09-29）：「随便聊」在最上面
    expect(hrefs.slice(0, 5)).toEqual(['/free-chat', '/', '/messages', '/todos', '/calendar'])
    expect(hrefs).not.toContain('/goals')
  })

  it('岗位按职责给图标，认不出的也有一个', () => {
    renderShell()
    const nav = screen.getByTestId('main-nav')
    for (const href of ['/positions/asg_1', '/positions/asg_2']) {
      const link = nav.querySelector(`a[href="${href}"]`)
      expect(link?.querySelector('svg')).not.toBeNull()
    }
  })
})

/**
 * WP96 交付 4：左栏与顶栏按画布重排**样式**，结构一个字没动。
 */
describe('左栏 / 顶栏新风格（WP96）', () => {
  it('顶栏那颗 ⌘K 变成一条长搜索框，点开还是同一个命令面板', () => {
    renderShell()
    const bar = screen.getByTestId('top-command')
    expect(bar.textContent).toContain('交给某个岗位一件事')
    expect(bar.textContent).toContain('⌘K')
    expect(bar.getAttribute('aria-label')).toBe('命令面板 (⌘K)')
  })

  it('品牌与账号还在左栏最下面（WP71 定的位置没被换皮挪走）', () => {
    renderShell()
    const bottom = screen.getByTestId('rail-bottom')
    const nav = screen.getByTestId('main-nav')
    // 最下面 = 在导航之后
    expect(nav.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('WP271 三种模式：左栏与账号块', () => {
  const me = {
    person: { id: 'per_wang', name: '王岚', email: 'wang@nordvolt.example' },
    workspace: { id: 'ws_1', name: 'Nordvolt' },
    assignments: [],
  }

  it('① 个人：「岗位与品牌」，「我的代理」收起，账号块只写品牌名', async () => {
    modeState.orgs = [SOLO_ORG]
    renderWithProviders(
      <AppShell
        positions={positions}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
        me={me as never}
      >
        <div>主区</div>
      </AppShell>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('nav-org').textContent).toBe('岗位与品牌')
    })
    expect(screen.queryByTestId('nav-secretary')).toBeNull()
    const account = screen.getByTestId('account-block').textContent ?? ''
    expect(account).toContain('Nordvolt')
    expect(account).not.toContain('所有者')
  })

  it('③ 公司集体：照旧「公司」「我的代理」、账号块「所有者 · 品牌」', async () => {
    modeState.orgs = [COMPANY_ORG]
    renderWithProviders(
      <AppShell
        positions={positions}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
        me={me as never}
      >
        <div>主区</div>
      </AppShell>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('account-block').textContent).toContain('所有者 · Nordvolt')
    })
    expect(screen.getByTestId('nav-org').textContent).toBe('公司')
    expect(screen.getByTestId('nav-secretary')).toBeTruthy()
  })
})
