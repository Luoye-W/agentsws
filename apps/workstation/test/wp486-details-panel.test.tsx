/**
 * WP486（Luoye 10-23 真机）：点「学到」卡的「证据」，右栏只有「查过什么 / 预检通过 / 有改动对比 /
 * 读了 1 条记录 / 还有 1 条记录你无权查看」——看不出这条是从哪学来的。
 *
 * 1. 「证据」全站改叫「详情」（卡头「详情 N」）；
 * 2. 详情面板对「学到」卡列出攒出这条的那几次纠正：时间、哪张卡（链过去）、原来 / 改成 / 理由。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { focusEvidenceCard } from '@/components/deck/deck-focus'
import { RailStateProvider } from '@/components/rail/rail-state'
import { RightRail } from '@/components/rail/right-rail'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const lessonCard = () =>
  draftCard({
    id: 'ap_lesson',
    kind: 'skill_lesson',
    layout: 'policy',
    title: '昨天学到的：给「回信语气」加一条 回帖里别写 DM us，就在帖子里答',
    summary:
      '你 10-21、10-22 在「回帖：耳机怎么连」「回帖：保修多久」上都把草稿改成了「就在帖子里答」。采纳就写进你的个人层，不采纳以后不再提。',
    entity_chips: [],
    options: [
      { id: 'append', label: '在「回信语气」后面加一句：回帖里别写 DM us，就在帖子里答' },
      { id: 'none', label: '都不要' },
    ],
    detail: {
      ...draftCard().detail,
      citations: [],
      payload: {
        form: 'skill_lesson',
        skill: 'reddit-ops',
        sources: [
          {
            at: '2026-10-21T10:00:00.000Z',
            signal: 'edit_diff',
            quote: 'Happy to help right here.',
            approval_item_id: 'ap_src1',
            card_title: '回帖：耳机怎么连',
            matter_id: 'mat_1',
            before: 'Great question! DM us for a code.',
            after: 'Great question! Happy to help right here.',
          },
          {
            at: '2026-10-22T11:00:00.000Z',
            signal: 'reject',
            quote: '别写 DM us，社区不许拉私信',
            approval_item_id: 'ap_src2',
            card_title: '回帖：保修多久',
          },
        ],
      },
      enrichment: { dropped_refs: 0 },
    },
  })

describe('WP486 详情面板：「学到」卡说得出从哪来', () => {
  it('卡头写「详情 N」，不再是「证据 N」', () => {
    renderWithProviders(
      <DeckCardView card={lessonCard()} mode="zh_summary" onDecide={() => {}} onOpen={() => {}} />,
    )
    const pill = screen.getByTestId('deck-evidence')
    expect(pill.textContent).toContain('详情')
    expect(pill.textContent).not.toContain('证据')
  })

  it('点「详情 N」→ 右栏列出攒出这条的两次纠正：时间、卡名（链到事项 / 那张卡）、原来 / 改成 / 理由', async () => {
    focusEvidenceCard(null)
    renderWithProviders(
      <RailStateProvider>
        <DeckCardView card={lessonCard()} mode="zh_summary" onDecide={() => {}} onOpen={() => {}} />
        <RightRail />
      </RailStateProvider>,
    )
    await userEvent.click(screen.getByTestId('deck-evidence'))
    const panel = await screen.findByTestId('rail-evidence')
    const rows = within(panel).getAllByTestId('rail-evidence-source')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('回帖：耳机怎么连')
    expect(rows[0]?.textContent).toContain('原来：Great question! DM us for a code.')
    expect(rows[0]?.textContent).toContain('改成：Great question! Happy to help right here.')
    expect(rows[1]?.textContent).toContain('你点了「不要」，理由：「别写 DM us，社区不许拉私信」')
    const links = within(panel).getAllByTestId('rail-evidence-source-link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/matters/mat_1#card-ap_src1',
      '/cards/ap_src2',
    ])
    // 本人看自己的卡：不出「无权查看」那一句
    expect(within(panel).queryByTestId('rail-evidence-dropped')).toBeNull()
    expect(panel.textContent).not.toContain('无权')
  })
})
