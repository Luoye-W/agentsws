/**
 * WP415（自查 R1 / R3 / R4，决策 1236–1239）工作台这一侧：
 * - 没接通的卡标「这一步还没接通」，卡上没有「通过」，「不要」写成「知道了」；演示的卡标「演示」；
 * - 执行过的卡照实说办没办成；
 * - 「这条职责能做什么」照服务端的 `wired` 标「还没接通」（不手写）；
 * - 连接那一句只有真连好才说「都连好了」，只缺可选的说「可选 N 个没连」；要开发者应用的不诱导去填。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { connectionsSummary } from '@/components/rail/card-status'
import type { PositionConnectionItem, RoleDetailView } from '@/lib/api'
import { actionLines } from '@/lib/duty-capabilities'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const t = (key: string): string =>
  ({
    'duty.wired.not_wired': '还没接通',
    'duty.wired.partly': '部分接通',
    'duty.level.L1': '要人批',
  })[key] ?? key

describe('卡上那一格：接没接通、办没办成', () => {
  it('没接通：标「这一步还没接通」，没有通过按钮，「不要」写成「知道了」，点一下就收起（不开写理由的面板）', async () => {
    const decided: unknown[] = []
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          kind: 'staged_change',
          available_actions: ['reject', 'snooze'],
          action_labels: { reject: '知道了' },
          wiring: { state: 'not_wired', reason: '这一步还没接通' },
        })}
        mode="zh_summary"
        onDecide={(r) => {
          decided.push(r)
        }}
        onOpen={noop}
      />,
    )
    const note = screen.getByTestId('deck-wiring')
    expect(note.getAttribute('data-wiring')).toBe('not_wired')
    expect(note.textContent).toContain('这一步还没接通')
    expect(screen.queryByRole('button', { name: /通过|批准|发送/ })).toBeNull()
    await userEvent.click(within(screen.getByTestId('deck-action-bar')).getByText('知道了'))
    expect(decided).toEqual([
      expect.objectContaining({ action: 'reject', reason: '还没接通，我自己去做' }),
    ])
  })

  it('演示：标「演示」', () => {
    renderWithProviders(
      <DeckCardView
        card={draftCard({ wiring: { state: 'demo', reason: '演示' } })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-wiring').getAttribute('data-wiring')).toBe('demo')
  })

  it('执行过的：没做 · 还没接通 / 办好了 · 已核对', () => {
    const a = renderWithProviders(
      <DeckCardView
        card={draftCard({
          status: 'apply_failed',
          available_actions: [],
          execution: { outcome: 'not_done', not_wired: true, reason: '这一步还没接通' },
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('exec-outcome').textContent).toContain('没做 · 还没接通')
    a.unmount()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          status: 'applied',
          available_actions: [],
          execution: { outcome: 'verified' },
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('exec-outcome').textContent).toContain('办好了 · 已核对')
  })
})

describe('「这条职责能做什么」只列做得到的', () => {
  const view = {
    actions: [
      { id: 'stage_refund', kind: 'staged_change', target: 'order', wired: 'not_wired' },
      { id: 'stage_price_change', kind: 'staged_change', target: 'product', wired: 'partly' },
      { id: 'stage_b2b_record', kind: 'staged_change', target: 'b2b', wired: 'wired' },
      { id: 'reply_customer', kind: 'outbound_message', target: 'customer' },
    ],
    automation: [],
  } as unknown as Pick<RoleDetailView, 'actions' | 'automation'>

  it('没接通的标「还没接通」、部分接通的标出来，接通了 / 看渠道的不标', () => {
    const lines = actionLines(view, t)
    expect(lines[0]?.text).toContain('还没接通')
    expect(lines[0]?.not_wired).toBe(true)
    expect(lines[1]?.text).toContain('部分接通')
    expect(lines[2]?.text).not.toContain('接通')
    expect(lines[3]?.text).not.toContain('接通')
  })
})

describe('连接那一句不说假话', () => {
  const item = (o: Partial<PositionConnectionItem>): PositionConnectionItem => ({
    kind: 'x',
    name: { zh: 'X', en: 'X' },
    required: false,
    connected: false,
    needed_by: [],
    status: 'available',
    ...o,
  })

  it('必需的没连 → N 个要处理；只缺可选的 → 可选 N 个没连；真有连上且不缺 → 都连好了；什么都不要 → 不说', () => {
    expect(connectionsSummary([item({ required: true })], [])).toEqual({ kind: 'todo', n: 1 })
    expect(connectionsSummary([item({}), item({ kind: 'y' })], ['email'])).toEqual({
      kind: 'optional',
      n: 2,
    })
    expect(connectionsSummary([], ['email'])).toEqual({ kind: 'ok', n: 1 })
    expect(connectionsSummary([], [])).toBeUndefined()
  })
})
