/**
 * WP486（Luoye 10-23 真机）：「昨天学到的」卡右下角的 → 点了没反应。
 *
 * → 的意思是「进这件事」（决策 1580）；可这张卡没有对应的事项，原来退回岗位页——人本来就在岗位页上，
 * 看起来就是死按钮。改成：**没有事项就打开右栏「详情」**。这里遍历全部卡种，钉住「→ 永远有反应」：
 * 有事项 → 交给 `onOpen`（进事项）；没有 → 第三栏开到详情。
 */
import { LAYOUT_BY_KIND } from '@agentsws/deck'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { focusEvidenceCard, useEvidenceCard } from '@/components/deck/deck-focus'
import { RailStateProvider, useRailState } from '@/components/rail/rail-state'
import { matterTarget, matterUrl } from '@/lib/work'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

function RailProbe(): React.ReactNode {
  const rail = useRailState()
  const focused = useEvidenceCard()
  return (
    <>
      <span data-testid="rail-open">{rail.open ?? '—'}</span>
      <span data-testid="rail-focus">{focused?.id ?? '—'}</span>
    </>
  )
}

const KINDS = Object.entries(LAYOUT_BY_KIND) as [string, string][]

describe('WP486：卡右下角的 → 不能是死按钮（遍历全部卡种）', () => {
  it.each(KINDS)('%s：没有事项 → 打开右栏「详情」，标签写「看详情」', async (kind, layout) => {
    focusEvidenceCard(null)
    const onOpen = vi.fn()
    const card = draftCard({
      id: `ap_${kind}`,
      kind: kind as never,
      layout: layout as never,
      detail: { ...draftCard().detail, payload: {} },
    })
    renderWithProviders(
      <RailStateProvider>
        <DeckCardView card={card} mode="zh_summary" onDecide={() => {}} onOpen={onOpen} />
        <RailProbe />
      </RailStateProvider>,
    )
    const go = screen.getByTestId('ws-go')
    expect(go.getAttribute('aria-label')).toBe('看详情')
    await userEvent.click(go)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByTestId('rail-open').textContent).toBe('evidence')
    expect(screen.getByTestId('rail-focus').textContent).toBe(card.id)
  })

  it.each(KINDS)('%s：有事项 → 进这件事（onOpen）', async (kind, layout) => {
    const onOpen = vi.fn()
    const card = draftCard({
      id: `ap_${kind}`,
      kind: kind as never,
      layout: layout as never,
      matter_id: 'mat_9',
      detail: { ...draftCard().detail, payload: {} },
    })
    renderWithProviders(
      <RailStateProvider>
        <DeckCardView card={card} mode="zh_summary" onDecide={() => {}} onOpen={onOpen} />
      </RailStateProvider>,
    )
    expect(screen.getByTestId('ws-go').getAttribute('aria-label')).toBe('打开这件事')
    await userEvent.click(screen.getByTestId('ws-go'))
    expect(onOpen).toHaveBeenCalledWith(card)
  })

  it('matterTarget：payload 里的事项 / 站内页面优先，其次卡上的 matter_id；都没有就是 undefined', () => {
    const base = draftCard({ detail: { ...draftCard().detail, payload: {} } })
    expect(matterTarget(base)).toBeUndefined()
    expect(matterUrl(base)).toBe('/positions/asg_1')
    expect(matterTarget({ ...base, matter_id: 'mat_1' })).toBe('/matters/mat_1#card-ap_1')
    expect(
      matterTarget({ ...base, detail: { ...base.detail, payload: { open_path: '/settings' } } }),
    ).toBe('/settings')
    expect(
      matterTarget({
        ...base,
        matter_id: 'mat_1',
        detail: { ...base.detail, payload: { matter_id: 'mat_2' } },
      }),
    ).toBe('/matters/mat_2#card-ap_1')
  })
})
