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
    role_id: 'dtc.aftersales',
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
    const nav = screen.getByRole('navigation')
    const links = Array.from(nav.querySelectorAll('a'))
    // 固定 11 条 + 岗位 2 条
    expect(links).toHaveLength(13)
    for (const link of links) {
      expect(link.querySelector('svg'), `「${link.textContent ?? ''}」少了图标`).not.toBeNull()
    }
  })

  it('岗位按职责给图标，认不出的也有一个', () => {
    renderShell()
    const nav = screen.getByRole('navigation')
    for (const href of ['/positions/asg_1', '/positions/asg_2']) {
      const link = nav.querySelector(`a[href="${href}"]`)
      expect(link?.querySelector('svg')).not.toBeNull()
    }
  })
})
