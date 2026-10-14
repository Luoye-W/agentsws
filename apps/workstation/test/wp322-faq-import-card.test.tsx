/**
 * WP322：FAQ 表导入那两张卡的样子。
 *
 * - 定规矩卡：列对照（问题 ← 某列）、一两行预览、改前改后、几条（只出不为 0 的）、表里少了的一行灰字；
 *   按钮就是选项（记下 / 只加新的 / 不用），不出「选一个」单选、不出改之前 / 改之后双格；
 *   键盘 → 是「记下」、← 是「不用」（不是中间那个）；
 * - ③ 整批卡：几条 + 预览。
 *
 * 假问答，不放任何真实客户数据。
 */
import type { FaqBatchPayload, FaqImportPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { noticeKeys } from '@/components/peers/handoff-strip'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const options: FaqImportPayload['options'] = [
  { id: 'all', label: '记下' },
  { id: 'new_only', label: '只加新的' },
  { id: 'skip', label: '不用' },
]

const payload: FaqImportPayload = {
  form: 'faq_import',
  source_id: 'ks_1',
  filename: '小蓝灯FAQ.xlsx',
  sheets: [
    {
      sheet: '中文问答',
      header_row: 3,
      rows: 3,
      by: 'ai',
      columns: [
        { field: 'question', col: 1, header: '客户常见问题' },
        { field: 'answer', col: 2, header: '标准回复话术' },
        { field: 'category', col: 0, header: '问题分类' },
      ],
    },
  ],
  counts: { new: 2, changed: 1, same: 4, removed: 1, skipped: 0 },
  preview: [{ question: '充满要多久？', answer: '约 90 分钟。' }],
  changes: [{ question: '保修多久？', before: '一年。', after: '两年。' }],
  removed: ['能退吗？'],
  options,
}

function importCard(): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_faq',
    kind: 'policy_change',
    layout: 'policy',
    title: '「小蓝灯FAQ.xlsx」导入 3 条问答',
    summary: '记下后当场生效，知识库里能改、能删。',
    content_variants: { zh_summary: '记下后当场生效，知识库里能改、能删。' },
    options,
    detail: { ...base.detail, payload, proposer: { kind: 'person', id: 'per_wang' } },
  })
}

describe('WP322 FAQ 导入的定规矩卡', () => {
  it('列对照、预览、改前改后、几条、表里少了；三个选项就是按钮；点「记下」带 all', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={importCard()} mode="zh_summary" onDecide={onDecide} onOpen={() => {}} />,
    )
    const mapping = screen.getByTestId('faq-mapping')
    expect(mapping.textContent).toContain('问题 ← 客户常见问题')
    expect(mapping.textContent).toContain('答案 ← 标准回复话术')
    expect(mapping.textContent).toContain('AI 认的')
    expect(screen.getByTestId('faq-preview').textContent).toContain('约 90 分钟。')
    expect(screen.getByTestId('faq-change').textContent).toContain('两年。')
    expect(screen.getByTestId('faq-counts').textContent).toBe('新 2改 1没变 4表里少了 1')
    expect(screen.getByTestId('faq-removed').textContent).toBe('表里少了：能退吗？')
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
    expect(screen.getByTestId('deck-card').textContent).not.toContain('按提议改')
    fireEvent.click(screen.getByText('记下'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'all' }),
    )
    expect(noticeKeys(importCard())).toEqual({
      right: { id: 'all', label: '记下' },
      left: { id: 'skip', label: '不用' },
    })
  })

  it('③ 整批卡：几条 + 预览，不出双格', () => {
    const batch: FaqBatchPayload = {
      form: 'faq_batch',
      source_id: 'ks_1',
      filename: '小蓝灯FAQ.xlsx',
      card_ids: ['f1', 'f2'],
      replaces: { f2: 'f0' },
      counts: { new: 1, changed: 1 },
      preview: [{ question: '充满要多久？', answer: '约 90 分钟。' }],
      before: null,
      after: '新 1 条 · 改 1 条',
    }
    const base = draftCard()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          id: 'ap_batch',
          kind: 'knowledge_update',
          layout: 'change',
          title: '「小蓝灯FAQ.xlsx」里的 2 条问答',
          detail: { ...base.detail, payload: batch },
        })}
        mode="zh_summary"
        onDecide={() => {}}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('deck-layout-faq-batch')).toBeDefined()
    expect(screen.getByTestId('faq-counts').textContent).toBe('新 1改 1')
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
  })
})
