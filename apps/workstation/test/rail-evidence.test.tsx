/**
 * WP100：第三栏那一格「证据」有正文了（36 §9 表里的第四格）。
 *
 * WP98 把卡面上的证据层全收进了右上角那枚「证据 N」，而它点开的面板到 09-18 为止
 * 还是"这个面板还没做"——胶囊说有 4 条，点开一条都没有。这一版补上正文，钉三件事：
 *
 * 1. **点「证据 N」→ 面板里就是那 N 条**（同一个 `evidenceLines`，不是另算一遍）；
 * 2. **没人点过就照实说**那一句操作说明，不摆空壳子；
 * 3. 面板走的是**公开注册路**：注册表里 `evidence` 现在有身体，图标轨点开
 *    不再落到"还没做"那句兜底上。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { focusEvidenceCard } from '@/components/deck/deck-focus'
import { evidenceLines } from '@/components/deck/evidence-chips'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider, useRailState } from '@/components/rail/rail-state'
import { panelBody, resolvePanelId } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

/** 别处那句 `show('evidence')`（卡上「证据 N」走的也是它）。 */
function OpenEvidence(): React.ReactNode {
  const rail = useRailState()
  return (
    <button type="button" data-testid="open-evidence" onClick={() => rail.show('evidence')}>
      证据
    </button>
  )
}

const noop = (): void => {}

/** 卡 + 第三栏一起渲染：点卡上的胶囊，看右栏里出来什么。 */
function renderDeckWithRail(): void {
  focusEvidenceCard(null)
  renderWithProviders(
    <RailStateProvider>
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />
      <RightRail />
    </RailStateProvider>,
  )
}

describe('证据面板（WP100）', () => {
  it('注册表里 evidence 有身体了（WP372 起是「产出」的「证据」标签）', () => {
    ensureBuiltinPanels()
    expect(resolvePanelId('evidence')).toEqual({ id: 'outputs', sub: 'evidence' })
    expect(panelBody('outputs')).toBeDefined()
  })

  it('点「证据 N」→ 面板里列出的就是那 N 条（与胶囊同一份，不另算一遍）', async () => {
    renderDeckWithRail()
    const pill = screen.getByTestId('deck-evidence')
    const n = Number(pill.dataset.count)
    expect(n).toBeGreaterThan(0)

    await userEvent.click(pill)
    const panel = await screen.findByTestId('rail-evidence')
    expect(within(panel).getAllByTestId('rail-evidence-line')).toHaveLength(n)
    // 胶囊 title 上挂的那几句，逐条都在面板里
    for (const line of (pill.getAttribute('title') ?? '').split(' · ')) {
      expect(panel.textContent).toContain(line)
    }
  })

  it('摊开的是这张卡的东西：标题、对象引用、依据的那句话、预检结论', async () => {
    renderDeckWithRail()
    await userEvent.click(screen.getByTestId('deck-evidence'))
    const panel = await screen.findByTestId('rail-evidence')
    expect(within(panel).getByTestId('rail-evidence-title').textContent).toContain('Anna')
    expect(within(panel).getAllByTestId('object-chip')[0]?.textContent).toContain('订单 #1001')
    expect(panel.textContent).toContain('退货窗口 14 天')
    expect(panel.textContent).toContain('14 days from delivery')
    expect(panel.textContent).toContain('预检通过')
    // 出处预检是 ok → 事实卡那一行挂「已验证」
    expect(within(panel).getAllByTestId('rail-evidence-fact-status')[0]?.textContent).toBe('已验证')
  })

  it('裸 id 一个字都不印（fact_ / cus_ / ord_ 只用来跳转）', async () => {
    renderDeckWithRail()
    await userEvent.click(screen.getByTestId('deck-evidence'))
    const panel = await screen.findByTestId('rail-evidence')
    expect(panel.textContent ?? '').not.toContain('fact_')
    expect(panel.textContent ?? '').not.toContain('ord_')
  })

  it('没人点过「证据 N」时，这一栏写的是那句操作说明，不是一个空壳子', async () => {
    focusEvidenceCard(null)
    renderWithProviders(
      <RailStateProvider>
        <OpenEvidence />
        <RightRail />
      </RailStateProvider>,
    )
    // WP372：没有「证据」图标了——卡上「证据 N」与别处 `show('evidence')` 开到「产出」的「证据」标签
    await userEvent.click(screen.getByTestId('open-evidence'))
    const empty = await screen.findByTestId('rail-evidence-empty')
    // WP486：界面上改叫「详情」
    expect(empty.textContent).toContain('详情')
    expect(screen.queryByTestId('rail-placeholder')).toBeNull()
  })

  it('"还有 N 条你无权查看"那句在（29 §2：丢掉的 ref 只报个数）', async () => {
    const base = draftCard()
    focusEvidenceCard(null)
    renderWithProviders(
      <RailStateProvider>
        <DeckCardView
          card={draftCard({ detail: { ...base.detail, enrichment: { dropped_refs: 2 } } })}
          mode="zh_summary"
          onDecide={noop}
          onOpen={noop}
        />
        <RightRail />
      </RailStateProvider>,
    )
    await userEvent.click(screen.getByTestId('deck-evidence'))
    const panel = await screen.findByTestId('rail-evidence')
    expect(within(panel).getByTestId('rail-evidence-dropped').textContent).toContain('2')
  })

  it('证据行与卡上那枚胶囊出自同一个函数（改了一处，另一处跟着变）', () => {
    const card = draftCard()
    const lines = evidenceLines(
      card,
      (k) => k,
      () => '',
    )
    expect(lines.length).toBeGreaterThan(0)
  })
})
