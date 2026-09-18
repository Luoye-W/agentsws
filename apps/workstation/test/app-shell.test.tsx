/**
 * WP43 §1：左栏每一条都带图标。
 *
 * 断言的是「每个 NavLink 里有一个 svg」——图标换成别的 lucide 图形不该让测试红，
 * 但漏掉一条就该红。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppShell } from '@/components/app-shell'
import type { PositionSummary } from '@/lib/api'
import { renderWithProviders } from './helpers'

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
    role_name: '工作区所有者',
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
    // 固定 12 条（WP85 加了「消息渠道」）+ 岗位 2 条
    expect(links).toHaveLength(14)
    for (const link of links) {
      expect(link.querySelector('svg'), `「${link.textContent ?? ''}」少了图标`).not.toBeNull()
    }
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
