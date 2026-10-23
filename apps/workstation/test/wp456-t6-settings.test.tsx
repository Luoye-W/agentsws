/**
 * WP456-T6（WP456 §3.8）：设置页这一轮的几条规矩。
 *
 * - 岗位与职责：一个岗位一行，整行点开看详情；行上只有一颗**次按钮**（请同事一起做），
 *   改名 / 加减职责 / 合并 / 拆出 / 移动 / 删掉都进「⋯」；删掉红字、点了要确认；
 * - 「⋯」菜单里按 Esc 只收菜单，不把外面的设置弹窗一起关了；
 * - 「看教程」全站一种样子：Luoye 10-23 起是灰色书本图标 + 悬停提示「看教程」（取代 T6 的灰字下划线）；
 * - 列表行右边那个问号：悬停是介绍、点开是教程（一个问号代替「ⓘ + 看教程」两颗）。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TutorialHint, TutorialLink } from '@/components/help/tutorial-link'
import { OverflowMenu } from '@/components/org/position-menu'
import { PositionsTab } from '@/components/org/positions-tab'
import type { OrgPositionView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const row = (id: string, name: string, roles: [string, string][]): OrgPositionView => ({
  id,
  name,
  name_en: name,
  version: '1.0.0',
  source: 'custom',
  roles: roles.map(([role_id, n]) => ({ role_id, name: n, default: true, loaded: true })),
  holders: [{ person_id: 'p_wang', name: '王岚', ranges: [{ kind: 'store', id: 'store_main' }] }],
})

const POSITIONS: OrgPositionView[] = [
  row('support', '客服', [
    ['dtc.support', '网站客服'],
    ['dtc.chat', '网站在线客服'],
  ]),
  row('social', '社媒运营', [
    ['social.tiktok', 'TikTok'],
    ['social.youtube', 'YouTube'],
  ]),
]

function renderTab(onDelete = vi.fn()) {
  renderWithProviders(
    <PositionsTab
      positions={POSITIONS}
      roles={[]}
      busy={false}
      onAssign={() => {}}
      onCreate={() => {}}
      onSaveRoles={() => {}}
      onDelete={onDelete}
      onRename={() => {}}
      onCopyRole={() => {}}
      onProposeRole={() => {}}
      onMerge={() => {}}
      onMoveDuty={() => {}}
      onSplit={() => {}}
    />,
  )
  return onDelete
}

const card = (id: string): HTMLElement =>
  screen
    .getAllByTestId('position-card')
    .find((c) => c.getAttribute('data-position') === id) as HTMLElement

afterEach(() => {
  vi.restoreAllMocks()
})

describe('岗位与职责：一行一个岗位，按钮降级', () => {
  it('收着时一行：名字 + 在做几条 + 谁在做；没有内部范围 id；一屏一个主按钮都没有', () => {
    renderTab()
    const support = within(card('support'))
    expect(card('support').classList.contains('ws-row')).toBe(true)
    expect(card('support').closest('[data-slot="list-group"]')).not.toBeNull()
    expect(support.getByTestId('position-duty-count').textContent).toBe('2 条职责')
    expect(support.getByTestId('position-holders').textContent).toContain('王岚')
    expect(support.getByTestId('position-holders').textContent).not.toContain('store_main')
    // 详情收着
    expect(support.queryByTestId('position-detail')).toBeNull()
    // 行上只有「请同事一起做」一颗次按钮 +「⋯」；改名、删掉不再摊开
    expect(support.getByTestId('position-assign').getAttribute('data-variant')).toBe('secondary')
    expect(support.queryByTestId('position-rename')).toBeNull()
    expect(support.queryByTestId('position-delete')).toBeNull()
    expect(document.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(
      0,
    )
  })

  it('整行点开看详情（职责跟着展开），再点收起', async () => {
    const user = userEvent.setup()
    renderTab()
    const support = within(card('support'))
    const open = support.getByTestId('position-open')
    await user.click(open)
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(support.getAllByTestId('position-duty')).toHaveLength(2)
    await user.click(open)
    expect(support.queryByTestId('position-detail')).toBeNull()
  })

  it('「⋯」里：改名、加减职责、合并到…、拆出…、移动职责、删掉（红字，点了先问）', async () => {
    const user = userEvent.setup()
    const onDelete = renderTab()
    const support = within(card('support'))
    await user.click(support.getByTestId('position-menu'))
    const items = support.getAllByRole('menuitem').map((m) => m.textContent)
    expect(items).toEqual(['改名', '加减职责', '合并到…', '拆出…', '移动职责', '删掉'])
    expect(support.getByTestId('position-delete').className).toContain('text-ws-bad')
    // 不确认 = 不删
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    await user.click(support.getByTestId('position-delete'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await user.click(support.getByTestId('position-menu'))
    await user.click(support.getByTestId('position-delete'))
    expect(onDelete).toHaveBeenCalledWith('support')
  })

  it('从「⋯」挑「拆出…」：这一行自己展开、只出拆出那张小表单', async () => {
    const user = userEvent.setup()
    renderTab()
    const social = within(card('social'))
    await user.click(social.getByTestId('position-menu'))
    await user.click(social.getByTestId('position-split'))
    expect(card('social').getAttribute('data-expanded')).toBe('true')
    expect(social.getByTestId('position-split-form')).toBeTruthy()
    expect(social.queryByTestId('position-merge-form')).toBeNull()
  })
})

describe('「⋯」菜单', () => {
  it('Esc 只收菜单：外面（设置弹窗）挂在 document 上的 Esc 收不到', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer, true)
    renderWithProviders(
      <OverflowMenu
        label="更多"
        testId="menu"
        items={[{ key: 'a', label: '改名', testId: 'menu-a', onSelect: () => {} }]}
      />,
    )
    fireEvent.click(screen.getByTestId('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('menu-a'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer, true)
  })
})

describe('「看教程」与问号', () => {
  it('「看教程」是灰色书本图标 + 悬停提示（Luoye 10-23），不是绿字', () => {
    renderWithProviders(<TutorialLink slug="conn-email" />)
    const link = screen.getByTestId('tutorial-link')
    expect(link.className).toContain('text-ws-muted-fg')
    expect(link.className).not.toContain('text-primary')
    expect(link.querySelector('svg')).not.toBeNull()
    expect(link.textContent).toBe('')
    expect(link.getAttribute('aria-label')).toBe('看教程')
  })

  it('一个问号：悬停是介绍（读屏也念「点开看教程」），点开是教程', async () => {
    renderWithProviders(
      <TutorialHint
        text="**最省事**：填邮箱地址和一个授权码。"
        guide={{ title: '新邮箱', markdown: '1. 打开 IMAP\n2. 生成应用专用密码' }}
      />,
    )
    const help = screen.getByTestId('tutorial-link')
    expect(help.getAttribute('data-hint')).toBe('最省事：填邮箱地址和一个授权码。')
    expect(help.getAttribute('aria-label')).toContain('点开看教程')
    fireEvent.click(help)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('新邮箱')).toBeTruthy()
    expect((await within(dialog).findByTestId('help-article')).textContent).toContain('打开 IMAP')
  })
})
