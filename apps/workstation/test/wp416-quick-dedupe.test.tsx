/**
 * WP416（自查 kol U13）：几条职责的快捷按钮同名时，后面带上是哪条职责（不出两个一模一样的「找一批红人」）。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PositionHandoff } from '@/components/position/position-handoff'
import type { PositionInstanceData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const prompt = (id: string, zh: string) => ({ id, label: { zh, en: zh }, prompt: `${zh}（${id}）` })

const VIEW: PositionInstanceData = {
  position_id: 'kol',
  workspace_id: 'ws_1',
  name: { zh: '红人营销', en: 'Creators' },
  template_version: '1.0.0',
  holders: ['p_1'],
  roles: [
    {
      role_id: 'kol.youtube',
      role_name: 'YouTube 红人',
      default: true,
      assignment_ids: ['asg_yt'],
      my_assignment_id: 'asg_yt',
      quick_prompts: [prompt('yt_find', '找一批红人'), prompt('yt_draft', '起草开发信')],
    },
    {
      role_id: 'kol.instagram',
      role_name: 'Instagram 红人',
      default: false,
      assignment_ids: ['asg_ig'],
      my_assignment_id: 'asg_ig',
      quick_prompts: [prompt('ig_find', '找一批红人')],
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
} as PositionInstanceData

describe('WP416 快捷按钮同名去重', () => {
  it('同名的带上职责名；不同名的照旧', () => {
    renderWithProviders(<PositionHandoff id="asg_yt" view={VIEW} />)
    const labels = screen.getAllByTestId('landing-action').map((b) => b.textContent ?? '')
    expect(labels.some((l) => l.includes('找一批红人 · YouTube 红人'))).toBe(true)
    expect(labels.some((l) => l.includes('找一批红人 · Instagram 红人'))).toBe(true)
    expect(labels.some((l) => l.trim() === '起草开发信')).toBe(true)
  })
})
