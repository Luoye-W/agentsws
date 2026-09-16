/**
 * WP70（54 §4 收口）：**职责一律归在岗位下面，默认折叠收纳**——左栏这一侧。
 *
 * 三条断言对着 Luoye 09-16 那句原话：
 * - 左栏「岗位」栏列的是岗位，一条职责名都不出现（以前列的是一条条分配 = 职责）；
 * - 多岗位的人点哪个岗位，当前分配就落在那个岗位下（`assignmentForPosition`）；
 * - 只有一条职责的岗位不出第二层（共用折叠件 `DutyFold`）。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { DutyFold } from '@/components/ui/duty-fold'
import type { PositionInstanceData, PositionSummary } from '@/lib/api'
import { assignmentForPosition, groupDutiesByPosition } from '@/lib/positions'
import { renderWithProviders } from './helpers'

/** 一个人同时做两个岗位：网站运营（三条职责）与客服（一条）。 */
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
      {
        role_id: 'dtc.email',
        role_name: '邮件营销',
        default: true,
        assignment_ids: ['asg_email'],
        my_assignment_id: 'asg_email',
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

/** 同一个人的四条分配——以前左栏列的就是这四条（= 四条职责）。 */
const POSITIONS: PositionSummary[] = [
  ['asg_store', 'dtc.store', '店铺管理'],
  ['asg_content', 'dtc.content', '内容与博客'],
  ['asg_email', 'dtc.email', '邮件营销'],
  ['asg_support', 'dtc.support', '独立站售后客服'],
].map(([position_id, role_id, role_name]) => ({
  position_id: position_id as string,
  role_id: role_id as string,
  role_name: role_name as string,
  ranges: [],
  ready: true,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday' as const,
  show_tiles: true,
}))

function renderShell(instances?: PositionInstanceData[]): void {
  renderWithProviders(
    <AppShell
      positions={POSITIONS}
      {...(instances === undefined ? {} : { instances })}
      cards={[]}
      tileLibrary={[]}
      onAddTile={() => {}}
    >
      <div>主区</div>
    </AppShell>,
  )
}

describe('左栏：岗位在外，职责不出现（WP70 / 54 §4）', () => {
  it('四条分配两个岗位 → 左栏只出两行岗位，职责名一条都不出现', () => {
    renderShell(INSTANCES)
    const rows = screen.getAllByTestId('nav-position')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.textContent ?? '')).toEqual([
      expect.stringContaining('网站运营'),
      expect.stringContaining('客服'),
    ])
    const nav = screen.getByRole('navigation')
    for (const duty of ['店铺管理', '内容与博客', '邮件营销', '独立站售后客服']) {
      expect(within(nav).queryByText(duty)).toBeNull()
    }
  })

  it('点岗位进的是本人在这个岗位下的第一条分配；待审数按岗位聚合', () => {
    renderShell(INSTANCES)
    const rows = screen.getAllByTestId('nav-position')
    expect((rows[0] as HTMLElement).getAttribute('href')).toBe('/positions/asg_store')
    expect((rows[1] as HTMLElement).getAttribute('href')).toBe('/positions/asg_support')
    // 网站运营三条职责的待审加起来是 3（服务端已经按岗位聚合）
    expect(within(rows[0] as HTMLElement).getByTestId('nav-position-pending').textContent).toBe('3')
    // 一张都没有就不出角标
    expect(within(rows[1] as HTMLElement).queryByTestId('nav-position-pending')).toBeNull()
  })

  it('没装岗位面的服务进程退回按分配列（老样子，一条都不少）', () => {
    renderShell()
    expect(screen.getAllByTestId('nav-position')).toHaveLength(4)
    expect(screen.getByText('店铺管理')).toBeDefined()
  })
})

describe('当前分配跟着岗位走（WP70）', () => {
  it('当前分配不属于这个岗位 → 换成地址栏这条', () => {
    expect(assignmentForPosition(INSTANCES, 'asg_store', 'asg_support')).toBe('asg_store')
  })

  it('当前分配已经属于这个岗位 → 不动它（职责层的切换只在折叠层里做）', () => {
    expect(assignmentForPosition(INSTANCES, 'asg_store', 'asg_content')).toBe('asg_content')
  })

  it('没装岗位面 / 还没进过任何岗位：地址栏是哪条就是哪条', () => {
    expect(assignmentForPosition(undefined, 'asg_store', 'asg_support')).toBe('asg_store')
    expect(assignmentForPosition(INSTANCES, 'asg_store', null)).toBe('asg_store')
    // 不在任何岗位里的分配（历史数据）也照样能进
    expect(assignmentForPosition(INSTANCES, 'asg_loose', 'asg_store')).toBe('asg_loose')
  })
})

describe('共用折叠件 DutyFold（WP70）', () => {
  it('多条职责：默认折叠，标题旁一个数字，点开才展开', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <DutyFold
        duties={[
          { id: 'dtc.store', name: '店铺管理' },
          { id: 'dtc.content', name: '内容与博客' },
        ]}
      />,
    )
    const toggle = screen.getByTestId('duty-fold-toggle')
    expect(toggle.textContent).toContain('2 条职责')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('duty-fold')).toBeNull()
    expect(screen.queryByText('店铺管理')).toBeNull()

    await user.click(toggle)
    expect(screen.getByTestId('duty-fold')).toBeDefined()
    expect(screen.getByText('店铺管理')).toBeDefined()
  })

  it('只有一条职责：不折叠，那一条的名字直接当副标题，没有第二层', () => {
    renderWithProviders(<DutyFold duties={[{ id: 'dtc.support', name: '独立站售后客服' }]} />)
    expect(screen.getByTestId('duty-fold-single').textContent).toBe('独立站售后客服')
    expect(screen.queryByTestId('duty-fold-toggle')).toBeNull()
  })

  it('一条职责都没有：整件不出', () => {
    renderWithProviders(<DutyFold duties={[]} />)
    expect(screen.queryByTestId('duty-fold-toggle')).toBeNull()
    expect(screen.queryByTestId('duty-fold-single')).toBeNull()
  })
})

describe('职责按岗位归堆（WP70）', () => {
  const positions = [
    {
      id: 'web-ops',
      name: '网站运营',
      roles: [{ role_id: 'dtc.store' }, { role_id: 'dtc.email' }],
    },
    { id: 'customer-care', name: '客服', roles: [{ role_id: 'dtc.support' }] },
  ]

  it('按岗位归堆，归不进去的落在最后一堆（没有 id = 未归岗位）', () => {
    const groups = groupDutiesByPosition(
      [
        { role_id: 'dtc.support' },
        { role_id: 'dtc.store' },
        { role_id: 'ads.meta' },
        { role_id: 'dtc.email' },
      ],
      positions,
    )
    expect(groups).toEqual([
      {
        position_id: 'web-ops',
        name: '网站运营',
        duties: [{ role_id: 'dtc.store' }, { role_id: 'dtc.email' }],
      },
      { position_id: 'customer-care', name: '客服', duties: [{ role_id: 'dtc.support' }] },
      { duties: [{ role_id: 'ads.meta' }] },
    ])
  })

  it('一条职责都归不进去（历史数据）：只剩未归岗位那一堆', () => {
    const groups = groupDutiesByPosition([{ role_id: 'ads.meta' }], [])
    expect(groups).toEqual([{ duties: [{ role_id: 'ads.meta' }] }])
  })
})
