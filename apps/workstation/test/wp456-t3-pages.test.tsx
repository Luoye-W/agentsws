/**
 * WP456-T3（WP456 §3.1–§3.3、§3.9，决策 1447 / 1448 / 1483 / 1536）：岗位 / 职责 / 事项页 + 看板。
 *
 * 钉的是规则（像素在截图里看，`scripts/e2e-wp456t3-shots.mjs`）：
 * - 全站 `Card` 一种样子：不画 ring，用卡阴影；设置弹窗那条单独的 index.css 规则删了；
 * - 快捷按钮最多露 4 个，其余收进「更多」；
 * - 事项页顶上一行：状态药丸 → 职责标签 →「N 个待办」灰链接 → 最右灰色时间；一个人时不画头像；
 * - 看板：产出 / 连接 / 设定 / 工坊服务注册成清单卡的行（`list`），点名它们 = 第三栏开完整一格。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MatterHeader } from '@/components/matter/matter-header'
import { type LandingAction, LandingActions } from '@/components/position/landing-actions'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { isListCard, railCard } from '@/components/rail/registry'
import { Card } from '@/components/ui/card'
import { renderWithProviders } from './helpers'

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(here, '..', 'src', 'index.css'), 'utf8')

describe('卡不加边框（决策 1483 / 1536）', () => {
  it('全站 Card 用卡阴影、不画 ring；设置弹窗那条单独的规则不在了', () => {
    render(<Card data-testid="c">x</Card>)
    const card = screen.getByTestId('c')
    expect(card.className).toContain('shadow-ws')
    expect(card.className).not.toMatch(/\bring-1\b/)
    expect(CSS).not.toContain('[data-slot="settings-items"] [data-slot="card"]')
  })
})

describe('快捷按钮（§3.1）', () => {
  const make = (n: number): LandingAction[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      label: `问法 ${i + 1}`,
      kind: 'send' as const,
      run: vi.fn(),
    }))

  it('多于 4 个：露 4 个 +「更多」，点了全出来', () => {
    renderWithProviders(<LandingActions actions={make(6)} />)
    expect(screen.getAllByTestId('landing-action')).toHaveLength(4)
    fireEvent.click(screen.getByTestId('landing-more'))
    expect(screen.getAllByTestId('landing-action')).toHaveLength(6)
    expect(screen.queryByTestId('landing-more')).toBeNull()
  })

  it('4 个以内：不出「更多」', () => {
    renderWithProviders(<LandingActions actions={make(3)} />)
    expect(screen.getAllByTestId('landing-action')).toHaveLength(3)
    expect(screen.queryByTestId('landing-more')).toBeNull()
  })
})

describe('事项页状态那一行（§3.3）', () => {
  const base = {
    title: 'Anna 要退 #1001',
    roleId: 'dtc.support',
    roleName: '网站客服',
    duties: [{ role_id: 'dtc.support', role_name: '网站客服', mine: true }],
    onReroute: () => {},
    rerouting: false,
    state: 'awaiting' as const,
    lastActivity: '10月18日 09:00',
    todos: [
      {
        id: 'td_1',
        title: '等 Anna 寄回',
        status: 'open',
        cards: [],
      } as unknown as Parameters<typeof MatterHeader>[0]['todos'][number],
    ],
    onCheckTodo: () => {},
    pinned: [],
    canArchive: true,
    onArchive: () => {},
    canClose: true,
    onClose: () => {},
    onRetitle: () => {},
  }

  it('状态药丸 → 职责标签 →「1 个待办」→ 最右时间；一个人不画头像', () => {
    renderWithProviders(<MatterHeader {...base} people={[{ person_id: 'per_1', label: '王岚' }]} />)
    const row = screen.getByTestId('matter-meta')
    const ids = Array.from(row.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(ids.indexOf('matter-state')).toBeLessThan(ids.indexOf('matter-reroute'))
    expect(ids.indexOf('matter-reroute')).toBeLessThan(ids.indexOf('matter-todos-chip'))
    expect(ids.indexOf('matter-todos-chip')).toBeLessThan(ids.indexOf('matter-recent'))
    expect(screen.getByTestId('matter-state').className).toContain('ws-pill')
    expect(screen.getByTestId('matter-state').getAttribute('data-tone')).toBe('warn')
    expect(screen.getByTestId('matter-reroute').className).toContain('ws-tag')
    expect(screen.getByTestId('matter-todos-chip').className).toContain('ws-link-muted')
    expect(screen.queryByTestId('matter-participant')).toBeNull()
    // 原来那颗「AI」头像不在了
    expect(row.textContent).not.toContain('AI')
  })

  it('多于一个人时才画头像', () => {
    renderWithProviders(
      <MatterHeader
        {...base}
        people={[
          { person_id: 'per_1', label: '王岚' },
          { person_id: 'per_2', label: '李默' },
        ]}
      />,
    )
    expect(screen.getAllByTestId('matter-participant')).toHaveLength(2)
  })
})

describe('看板清单卡（决策 1448）', () => {
  it('产出 / 连接 / 设定 / 工坊服务是清单卡的行，都有第三栏那一格；对话 / 报表 / 计划各占一张', () => {
    ensureBuiltinPanels()
    for (const id of ['outputs', 'connections', 'settings', 'workshop-services']) {
      expect(isListCard(id)).toBe(true)
      expect(railCard(id)?.panel).toBeDefined()
    }
    for (const id of ['conversations', 'reports', 'plans']) expect(isListCard(id)).toBe(false)
    // 对话卡头右边是「+」（展开 + 开新对话那一格）
    expect(railCard('conversations')?.action?.intent).toBe('compose')
  })
})
