/**
 * WP71（36 §10）左栏：**品牌 / 账号在最下面，岗位可展开看职责**。
 *
 * 四条断言对着 Luoye 09-16 那三句话：
 * - 岗位行首有展开箭头，展开后列的是**本人持有**的那几条职责；
 * - 点职责跳职责页（地址是那条职责自己的分配）；
 * - **当前岗位默认展开**，别的岗位默认折着；
 * - 品牌切换器与账号块在左栏最下面那一块里；顶栏只剩 ⌘K 与两个芯片。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import type { Me, PositionInstanceData, PositionSummary } from '@/lib/api'
import { RAIL_EXPANDED_KEY, readFlags } from '@/lib/ui-state'
import { renderWithProviders } from './helpers'

/** 网站运营（三条职责，其中一条是别人的）+ 客服（一条）。 */
const INSTANCES: PositionInstanceData[] = [
  {
    position_id: 'web-ops',
    workspace_id: 'ws_1',
    name: { zh: '网站运营', en: 'Web Operations' },
    template_version: '1.1.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'dtc.store',
        role_name: '店铺管理',
        default: true,
        assignment_ids: ['asg_store'],
        my_assignment_id: 'asg_store',
      },
      {
        role_id: 'dtc.content',
        role_name: '内容与博客',
        default: true,
        assignment_ids: ['asg_content'],
        my_assignment_id: 'asg_content',
      },
      // 别人那条：展开层里**不出现**（借岗位扩权那条老规矩，54 §2）
      {
        role_id: 'dtc.email',
        role_name: '邮件营销',
        default: true,
        assignment_ids: ['asg_other'],
      },
    ],
    open_matters: 2,
    pending_cards: 3,
    memory_summary: '',
  },
  {
    position_id: 'customer-care',
    workspace_id: 'ws_1',
    name: { zh: '客服', en: 'Customer Care' },
    template_version: '1.0.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'dtc.support',
        role_name: '独立站售后客服',
        default: true,
        assignment_ids: ['asg_support'],
        my_assignment_id: 'asg_support',
      },
    ],
    open_matters: 0,
    pending_cards: 0,
    memory_summary: '',
  },
]

const POSITIONS: PositionSummary[] = []

/**
 * 这一档 jsdom 的 `localStorage` 只是个空壳（连 `setItem` 都没有，
 * 见 `models.test.tsx` 里同一条注释），所以要验"记住展开态"就得自己铺一个。
 * 铺的是**真的 Storage 面**，走的仍是 `lib/ui-state.ts` 那条写入路径。
 */
function stubStorage(): Map<string, string> {
  const box = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      box.set(k, v)
    },
    removeItem: (k: string) => {
      box.delete(k)
    },
  })
  return box
}

const ME: Me = {
  person: { id: 'per_li', email: 'li@example.com', name: '李默' },
  workspace: { id: 'ws_1', name: '玻璃碗工作室' },
  assignments: [],
}

function renderShell(current = 'asg_store'): void {
  renderWithProviders(
    <AppShell
      positions={POSITIONS}
      instances={INSTANCES}
      cards={[]}
      tileLibrary={[]}
      me={ME}
      onAddTile={() => {}}
    >
      <div>主区</div>
    </AppShell>,
    '/',
    current,
  )
}

describe('左栏：岗位可展开看职责（WP71 / 36 §10）', () => {
  beforeEach(() => {
    stubStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('当前岗位默认展开，列的是本人持有的那几条职责；别人那条不出现', () => {
    renderShell('asg_store')
    const rows = screen.getAllByTestId('nav-position-row')
    const webOps = rows.find((r) => r.getAttribute('data-position') === 'web-ops') as HTMLElement
    const duties = within(webOps).getByTestId('nav-duties')
    expect(within(duties).getByText('店铺管理')).toBeDefined()
    expect(within(duties).getByText('内容与博客')).toBeDefined()
    // 别人持有的那条职责没有 my_assignment_id —— 列出来只会点进一个进不去的页面
    expect(within(duties).queryByText('邮件营销')).toBeNull()
  })

  it('不是当前岗位的那个默认折着，点箭头才展开', async () => {
    const user = userEvent.setup()
    renderShell('asg_store')
    const rows = screen.getAllByTestId('nav-position-row')
    const care = rows.find(
      (r) => r.getAttribute('data-position') === 'customer-care',
    ) as HTMLElement
    expect(within(care).queryByTestId('nav-duties')).toBeNull()
    await user.click(within(care).getByTestId('nav-position-toggle'))
    expect(within(care).getByText('独立站售后客服')).toBeDefined()
  })

  it('点职责进职责页：地址用那条职责自己的分配', () => {
    renderShell('asg_store')
    const links = screen.getAllByTestId('nav-duty')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/positions/asg_store/duties/dtc.store',
      '/positions/asg_content/duties/dtc.content',
    ])
  })

  it('展开 / 折起记在本机：收起当前岗位之后它不会又被默认规则打开', async () => {
    const user = userEvent.setup()
    renderShell('asg_store')
    const rows = screen.getAllByTestId('nav-position-row')
    const webOps = rows.find((r) => r.getAttribute('data-position') === 'web-ops') as HTMLElement
    await user.click(within(webOps).getByTestId('nav-position-toggle'))
    expect(within(webOps).queryByTestId('nav-duties')).toBeNull()
    expect(readFlags(RAIL_EXPANDED_KEY)).toEqual({ 'web-ops': false })
  })

  it('展开层里没有「记忆 · 技能 · 知识 · 额度」那一行（它们在第三栏）', () => {
    renderShell('asg_store')
    const nav = screen.getByTestId('main-nav')
    for (const word of ['记忆', '额度']) {
      expect(within(nav).queryByText(new RegExp(word))).toBeNull()
    }
  })
})

describe('品牌 / 账号在左栏最下面（WP71）', () => {
  beforeEach(() => {
    stubStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('账号块在左栏最下面那一块里，写着名字与「角色 · 公司名」', () => {
    renderShell()
    const bottom = screen.getByTestId('rail-bottom')
    expect(within(bottom).getByTestId('account-name').textContent).toBe('李默')
    expect(bottom.textContent).toContain('玻璃碗工作室')
  })

  it('点开账号块：账号与积分 / 设置 / 退出都在，深浅色与语言也收在这里', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByTestId('account-toggle'))
    const menu = screen.getByTestId('account-menu')
    for (const id of [
      'account-credits',
      'account-settings',
      'account-theme',
      'account-lang',
      'account-logout',
    ]) {
      expect(within(menu).getByTestId(id)).toBeDefined()
    }
  })

  it('顶栏只剩 ⌘K 与两个芯片：主题 / 语言按钮不在顶栏上了', () => {
    renderShell()
    const header = screen.getByRole('banner')
    expect(within(header).getByLabelText('命令面板 (⌘K)')).toBeDefined()
    expect(within(header).queryByTestId('account-block')).toBeNull()
    expect(within(header).queryByTestId('brand-switcher')).toBeNull()
  })
})
