/**
 * WP416（自查 kol U5 / U6）：开发信卡卡面直接放正文与要先看一眼的几句；验收卡一句话、不露字段名。
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KolOutreachBody, KolReviewBody } from '@/components/kol/kol-card-bodies'
import { renderWithProviders } from './helpers'

describe('WP416 红人卡面', () => {
  it('开发信卡：标题 + 正文前 6 行，可展开；提醒放卡面', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    renderWithProviders(
      <KolOutreachBody
        payload={{
          kind: 'kol_outreach',
          after: {
            subject: 'NordVolt x you',
            body,
            heads_up: ['还没连发信邮箱：现在批了也发不出去。'],
          },
        }}
      />,
    )
    expect(screen.getByTestId('kol-outreach-subject').textContent).toBe('NordVolt x you')
    expect(screen.getByTestId('kol-outreach-body').textContent).toContain('line 6')
    expect(screen.getByTestId('kol-outreach-body').textContent).not.toContain('line 7')
    expect(screen.getByTestId('kol-outreach-heads-up').textContent).toContain('还没连发信邮箱')
    fireEvent.click(screen.getByTestId('kol-outreach-expand'))
    expect(screen.getByTestId('kol-outreach-body').textContent).toContain('line 10')
  })

  it('验收卡：一句话，不露 review / pending 这类字段名', () => {
    renderWithProviders(
      <KolReviewBody
        payload={{
          kind: 'kol_deliverable_review',
          before: { review: 'pending' },
          after: { review: 'approved', review_label: '已通过' },
        }}
      />,
    )
    const node = screen.getByTestId('deck-layout-kol-review')
    expect(node.textContent).toContain('判为「已通过」')
    expect(node.textContent).not.toContain('review')
    expect(node.textContent).not.toContain('pending')
  })
})
