/**
 * WP430（决策 1288）：设置 → 模型「AI 来源」里自己配的那几条按顺序列、可拖动排序；没测过的灰着并带问号。
 * 拖动本身是 dnd-kit（与右栏卡片同一套），jsdom 里量不出位置，这里只钉顺序、手柄与「不会被自动接上」那一格。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AiSourceOrder } from '@/components/models/ai-source-order'
import { renderWithProviders } from './helpers'

describe('WP430 AI 来源顺序（界面）', () => {
  it('按服务端给的顺序列，带序号与拖动手柄；没测过的标出来', () => {
    renderWithProviders(
      <AiSourceOrder
        own={[
          {
            provider_id: 'openai-codex',
            label: 'ChatGPT 订阅',
            group: 'subscription',
            ready: true,
          },
          { provider_id: 'ds', label: 'DeepSeek', group: 'own', ready: true },
          { provider_id: 'kimi', label: 'Kimi', group: 'own', ready: false },
        ]}
        busy={false}
        onReorder={() => {}}
      />,
    )
    const list = screen.getByTestId('model-ai-source-own')
    expect(list.getAttribute('data-order')).toBe('openai-codex,ds,kimi')
    expect(list.textContent).toContain('1ChatGPT 订阅')
    expect(screen.getByTestId('model-ai-source-row-kimi').getAttribute('data-ready')).toBe('false')
    expect(screen.getByTestId('model-ai-source-row-ds').getAttribute('data-ready')).toBe('true')
    expect(screen.getByTestId('model-ai-source-handle-ds').getAttribute('aria-label')).toContain(
      'DeepSeek',
    )
  })

  it('老服务端没有 ready 那一格：当作能接，不标灰', () => {
    renderWithProviders(
      <AiSourceOrder
        own={[{ provider_id: 'own', label: 'Kimi', group: 'own' }]}
        busy={false}
        onReorder={() => {}}
      />,
    )
    expect(screen.getByTestId('model-ai-source-row-own').getAttribute('data-ready')).toBe('true')
  })
})
