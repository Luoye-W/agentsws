/**
 * WP478（决策 1619 选 A，Luoye 10-23）：
 * - 对话框压着内容时缩成底部小条（不出快捷提问）；滚到底 / 内容不够长是完整对话框；
 *   框里有字不缩；点小条立刻展开、光标进输入框；缩成小条时那一截照样占着位子（底部留白不变）。
 * - 决策卡：卡身里的按钮并进卡底一排（方案卡「就这样 / 修改 / 先不设 / 稍后」）；超过 4 颗进「⋯」。
 */
import type { SetupRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckActionBar } from '@/components/deck/deck-action-bar'
import { DeckCardView } from '@/components/deck/deck-card'
import { MatterComposer } from '@/components/matter/matter-composer'
import { ComposerDock } from '@/components/shell/composer-dock'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

/** 内容的底边、完整对话框的顶边（jsdom 不排版，按 testid 给几何）。 */
let contentBottom = 0
const FULL_TOP = 600

beforeEach(() => {
  contentBottom = 0
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.dataset.testid
    const r = (top: number, bottom: number) =>
      ({
        top,
        bottom,
        height: bottom - top,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
      }) as DOMRect
    if (id === 'content') return r(0, contentBottom)
    if (id === 'composer-full') return r(FULL_TOP, FULL_TOP + 150)
    return r(0, 0)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

function Page({ value = '' }: { value?: string }) {
  return (
    <div>
      <div data-testid="content">卡片们</div>
      <ComposerDock testId="dock" above={<div data-testid="quick-prompts">快捷提问</div>}>
        <MatterComposer
          value={value}
          onChange={noop}
          onSend={noop}
          onStop={noop}
          running={false}
          closed={false}
          sending={false}
          docked={false}
          placeholderText="问点什么，或交一件事"
        />
      </ComposerDock>
    </div>
  )
}

describe('WP478 对话框不挡内容', () => {
  it('内容压着对话框 → 底部小条（写这一页的占位词、不出快捷提问），完整版那一截照样占着位子', () => {
    contentBottom = 900
    renderWithProviders(<Page />)
    const dock = screen.getByTestId('dock')
    expect(dock.dataset.state).toBe('pill')
    const pill = screen.getByTestId('composer-pill')
    expect(pill.textContent).toContain('问点什么，或交一件事')
    const full = screen.getByTestId('composer-full')
    // 看不见、点不到（inert），但还在排版里：底部留白不变，页面不跳
    expect(full.hasAttribute('inert')).toBe(true)
    expect(full.getAttribute('aria-hidden')).toBe('true')
    expect(full.className).toContain('opacity-0')
    expect(within(full).getByTestId('quick-prompts')).toBeTruthy()
  })

  it('滚到底（内容停在框上面）或内容不够长 → 完整对话框', () => {
    contentBottom = 560
    renderWithProviders(<Page />)
    expect(screen.getByTestId('dock').dataset.state).toBe('full')
    expect(screen.getByTestId('composer-full').hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('composer-pill').getAttribute('aria-hidden')).toBe('true')
  })

  it('滚动时重新算：从压着变成滚到底就展开', async () => {
    contentBottom = 900
    renderWithProviders(<Page />)
    expect(screen.getByTestId('dock').dataset.state).toBe('pill')
    contentBottom = 590
    await act(async () => {
      fireEvent.scroll(document)
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    })
    expect(screen.getByTestId('dock').dataset.state).toBe('full')
  })

  it('框里有字：压着内容也不缩回小条', () => {
    contentBottom = 900
    renderWithProviders(<Page value="写了一半" />)
    expect(screen.getByTestId('dock').dataset.state).toBe('full')
  })

  it('点小条 → 立刻展开、光标进输入框', () => {
    contentBottom = 900
    renderWithProviders(<Page />)
    fireEvent.click(screen.getByTestId('composer-pill'))
    expect(screen.getByTestId('dock').dataset.state).toBe('full')
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })

  it('首页的简易对话框不缩', () => {
    contentBottom = 900
    renderWithProviders(
      <div>
        <div data-testid="content">x</div>
        <ComposerDock testId="dock" variant="simple">
          <span>框</span>
        </ComposerDock>
      </div>,
    )
    expect(screen.getByTestId('dock').dataset.state).toBeUndefined()
    expect(screen.queryByTestId('composer-pill')).toBeNull()
  })
})

const plan: SetupRequestPayload = {
  form: 'setup_request',
  target: 'reddit.watch',
  why: '我先查了一遍，按这个方案巡查。',
  mode: 'plan',
  fields: [
    {
      key: 'brand_username',
      label: '品牌号',
      kind: 'text',
      suggested: 'Demo_Official',
      required: false,
    },
  ],
}

function planCard(): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_plan',
    kind: 'setup_request',
    layout: 'policy',
    title: 'Reddit 巡查：我打算这样设',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '就这样', reject: '先不设', snooze: '稍后' },
    detail: { ...base.detail, payload: plan as never },
  })
}

describe('WP478 决策卡按钮并成卡底一排', () => {
  it('方案卡：「就这样 / 修改」和「先不设 / 稍后」在卡底同一排，主按钮只有一颗；卡身里不再有一排', () => {
    renderWithProviders(
      <DeckCardView card={planCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const bar = screen.getByTestId('deck-action-bar')
    const labels = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
    expect(labels).toEqual(['就这样', '修改', '先不设', '稍后'])
    expect(bar.querySelectorAll('.ws-btn-primary')).toHaveLength(1)
    expect(within(bar).getByText('就这样').className).toContain('ws-btn-primary')
    expect(screen.queryByTestId('card-body-actions')).toBeNull()
    expect(screen.queryByTestId('deck-more')).toBeNull()
  })

  it('点「修改」展开表单：卡底变成「保存并接着做 / 收起 / 先不设 / 稍后」', () => {
    renderWithProviders(
      <DeckCardView card={planCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    fireEvent.click(screen.getByTestId('setup-plan-edit'))
    const bar = screen.getByTestId('deck-action-bar')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['保存并接着做', '收起', '先不设', '稍后'])
    fireEvent.click(screen.getByTestId('setup-plan-fold'))
    expect(screen.getByTestId('setup-plan-accept')).toBeTruthy()
  })

  it('超过 4 颗：多出来的进「⋯」', () => {
    const card = draftCard({
      available_actions: ['approve', 'instruct', 'reject', 'snooze', 'open'],
    })
    const picked: string[] = []
    renderWithProviders(
      <DeckActionBar
        card={card}
        onAction={(a) => picked.push(a)}
        lead={[
          { key: 'a', label: '甲', onSelect: () => picked.push('甲') },
          { key: 'b', label: '乙', onSelect: () => picked.push('乙') },
        ]}
      />,
    )
    const bar = screen.getByTestId('deck-action-bar')
    const shown = [...bar.querySelectorAll(':scope > button')].map((b) => b.textContent?.trim())
    expect(shown).toHaveLength(4)
    expect(shown.slice(0, 2)).toEqual(['甲', '乙'])
    fireEvent.click(screen.getByTestId('deck-more'))
    const menu = screen.getByTestId('deck-more-menu')
    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThanOrEqual(2)
  })
})
