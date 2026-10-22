/**
 * WP43 §1：左栏每一条都带图标。
 *
 * 断言的是「每个 NavLink 里有一个 svg」——图标换成别的 lucide 图形不该让测试红，
 * 但漏掉一条就该红。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
    // WP342（决策 853）：左栏只剩 随便聊 / 首页 / 消息 / 待办 / 日历 + 岗位（WP469：待办 + 日历合成「日历与待办」）（+ 公司模式的「我的代理」）；
    // 会议 / 知识库 / 技能 / 岗位与品牌 / 连接 / 消息渠道 / 设置收进了账号菜单
    // （WP234：「公司设置与授权」是负责人身份，不在左栏「岗位」里）
    const hrefs = links.map((a) => a.getAttribute('href'))
    for (const gone of [
      '/meetings',
      '/knowledge',
      '/skills',
      '/org',
      '/connections',
      '/im-channels',
      '/settings',
    ])
      expect(hrefs).not.toContain(gone)
    // WP469：待办与日历合成一格「日历与待办」，左栏少一格
    expect(links.length).toBeGreaterThanOrEqual(5)
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
  it('左栏顺序：首页 / 我的助理 / 收件箱 / 日历与待办；目标不在左栏里了', () => {
    renderShell()
    const nav = screen.getByTestId('main-nav')
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    // WP188（Luoye 09-29）：「随便聊」在最上面；WP343 改名「我的助理」（`/assistant`）
    // WP433（Luoye 10-20 问题 1）：「首页」放到最上面
    // WP469（决策 1521）：待办与日历合成一格「日历与待办」（`/planner`）
    expect(hrefs.slice(0, 4)).toEqual(['/', '/assistant', '/messages', '/planner'])
    expect(screen.getByTestId('nav-cal-todo').textContent).toContain('日历与待办')
    expect(hrefs).not.toContain('/todos')
    expect(hrefs).not.toContain('/calendar')
    expect(screen.getByTestId('nav-free-chat').textContent).toBe('助理')
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
  it('WP372（决策 1002）：顶栏没有「交给某个岗位一件事」搜索框了；⌘K 照样开命令面板', async () => {
    renderShell()
    expect(screen.queryByTestId('top-command')).toBeNull()
    expect(screen.getByTestId('top-bar').textContent).not.toContain('交给某个岗位一件事')
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    // WP431：⌘K 打开的就是左上角「搜索」那个弹窗（照 Claude）
    expect(await screen.findByPlaceholderText('搜索事项、对话、岗位、设置…')).toBeTruthy()
  })

  it('品牌与账号还在左栏最下面（WP71 定的位置没被换皮挪走）', () => {
    renderShell()
    const bottom = screen.getByTestId('rail-bottom')
    const nav = screen.getByTestId('main-nav')
    // 最下面 = 在导航之后
    expect(nav.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/** WP342 / WP356：点开账号菜单（「设置」那一组 WP356 起是一行，点了开设置弹窗）。 */
async function openAccountMenu(): Promise<void> {
  fireEvent.click(screen.getByTestId('account-toggle'))
  await screen.findByTestId('account-menu')
}

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
    // WP356：「岗位与品牌」收进设置弹窗（品牌 → 岗位与职责）；账号菜单里只一行「设置」
    await openAccountMenu()
    expect(screen.getByTestId('nav-settings').textContent).toContain('设置')
    expect(screen.queryByTestId('nav-org')).toBeNull()
    expect(screen.queryByTestId('nav-secretary')).toBeNull()
    const account = screen.getByTestId('account-block').textContent ?? ''
    expect(account).toContain('Nordvolt')
    expect(account).not.toContain('所有者')
  })

  it('③ 公司集体：照旧「公司」、账号块「所有者 · 品牌」；「我的代理」并进「我的助理」不再占左栏', async () => {
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
    // WP343：「我的代理」并进「我的助理」（右上角「替我答同事」，见 wp343-assistant.test.tsx）
    expect(screen.queryByTestId('nav-secretary')).toBeNull()
    await openAccountMenu()
    expect(screen.getByTestId('nav-settings')).toBeTruthy()
  })
})
