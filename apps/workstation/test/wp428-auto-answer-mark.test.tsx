/**
 * WP428（决策 1246 改）：对话记录里 AI 直接答的那一句标「AI 直接答 · 出处」，旁边「这句不该直接答」。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const calls = vi.hoisted(() => ({ flagged: [] as string[] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    flagChatAutoAnswer: async (session_id: string, message_id: string) => {
      calls.flagged.push(`${session_id}/${message_id}`)
      return { learned: true }
    },
  }
})

const { ChatTranscript } = await import('@/components/chat/transcript')

const AT = '2026-10-19T03:00:00.000Z'

describe('WP428 直接答那一句', () => {
  it('标出处；点「这句不该直接答」→ 记下了', async () => {
    const messages: ChatMessageView[] = [
      { id: 'm1', role: 'visitor', text: 'How much is shipping?', at: AT },
      {
        id: 'm2',
        role: 'agent',
        text: 'Shipping to the US is free over $50.',
        at: AT,
        plan_action: 'auto_answer',
        auto_answer: {
          score: 0.86,
          sources: [{ kind: 'fact_card', label: '美国订单满 $50 免邮' }],
          flagged: false,
        },
      },
    ]
    renderWithProviders(<ChatTranscript messages={messages} sessionId="cs_1" assignment="asg_1" />)
    const mark = await screen.findByTestId('chat-auto-answer-mark')
    expect(mark.textContent).toContain('AI 直接答')
    expect(mark.textContent).toContain('出处：美国订单满 $50 免邮')
    // 只有直接答的那一句有这一行
    expect(screen.getAllByTestId('chat-auto-answer-mark')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('chat-auto-answer-flag'))
    await waitFor(() => {
      expect(screen.getByTestId('chat-auto-answer-flagged').textContent).toContain('记下了')
    })
    expect(calls.flagged).toEqual(['cs_1/m2'])
  })

  it('点过的那一句只显示「记下了」', async () => {
    renderWithProviders(
      <ChatTranscript
        sessionId="cs_1"
        messages={[
          {
            id: 'm3',
            role: 'agent',
            text: 'ok',
            at: AT,
            plan_action: 'auto_answer',
            auto_answer: { score: 0.8, sources: [], flagged: true },
          },
        ]}
      />,
    )
    await screen.findByTestId('chat-auto-answer-flagged')
    expect(screen.queryByTestId('chat-auto-answer-flag')).toBeNull()
  })
})
