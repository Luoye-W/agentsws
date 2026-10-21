/**
 * WP440（docs/108 M9）：邮件客服按把握直接回——
 * ① 那封下面一行「AI 直接回 · 出处：…」，旁边「这封不该直接回」；
 * ② 邮箱上「有把握就直接回」开关（缺省开）+ 档位下拉（严格 / 适中 / 宽松），关了下拉就收起。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MailboxSwitchesView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const calls = vi.hoisted(() => ({
  flagged: [] as string[],
  saved: [] as Record<string, unknown>[],
  view: {
    connection_id: 'conn_mail',
    shadow_mode: false,
    move: true,
    mark_read: true,
    takeover: true,
    auto_reply: true,
    auto_reply_strictness: 'balanced',
  } as MailboxSwitchesView,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    flagMessageAutoReply: async (id: string) => {
      calls.flagged.push(id)
      return { learned: true }
    },
    getMailboxSwitches: async () => calls.view,
    setMailboxSwitches: async (_id: string, input: Record<string, unknown>) => {
      calls.saved.push(input)
      calls.view = { ...calls.view, ...input }
      return calls.view
    },
  }
})

const { EmailAutoReplyMark } = await import('@/components/messages/auto-reply-mark')
const { MailboxAutoReply } = await import('@/components/connections/mailbox-auto-reply')

describe('WP440 · AI 直接回那一封', () => {
  it('标出处；点「这封不该直接回」→ 记下了', async () => {
    renderWithProviders(
      <EmailAutoReplyMark
        approvalItemId="apr_1"
        sources={[{ label: '充电类产品的保修期是 24 个月' }]}
        excerpt="充电类产品的保修期是 24 个月，从签收日算起。"
      />,
    )
    const mark = await screen.findByTestId('email-auto-reply-mark')
    expect(mark.textContent).toContain('AI 直接回')
    expect(mark.textContent).toContain('出处：充电类产品的保修期是 24 个月')
    fireEvent.click(screen.getByTestId('email-auto-reply-flag'))
    await waitFor(() => {
      expect(screen.getByTestId('email-auto-reply-flagged').textContent).toContain('记下了')
    })
    expect(calls.flagged).toEqual(['apr_1'])
  })

  it('点过的只显示「记下了」', async () => {
    renderWithProviders(<EmailAutoReplyMark approvalItemId="apr_2" sources={[]} flagged />)
    await screen.findByTestId('email-auto-reply-flagged')
    expect(screen.queryByTestId('email-auto-reply-flag')).toBeNull()
  })
})

describe('WP440 · 邮箱上的开关与档位', () => {
  it('缺省开、适中；改档位只发档位；关了下拉收起', async () => {
    renderWithProviders(<MailboxAutoReply connectionId="conn_mail" />)
    const select = (await screen.findByTestId('mailbox-auto-reply-strictness')) as HTMLSelectElement
    expect(select.value).toBe('balanced')
    expect([...select.options].map((o) => o.textContent)).toEqual(['严格', '适中', '宽松'])
    fireEvent.change(select, { target: { value: 'strict' } })
    await waitFor(() => {
      expect(calls.saved.at(-1)).toEqual({ auto_reply_strictness: 'strict' })
    })
    fireEvent.click(screen.getByTestId('mailbox-switch-auto_reply'))
    await waitFor(() => {
      expect(calls.saved.at(-1)).toEqual({ auto_reply: false })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('mailbox-auto-reply-strictness')).toBeNull()
    })
  })
})
