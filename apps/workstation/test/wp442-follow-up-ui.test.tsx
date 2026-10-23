/**
 * WP442（docs/108 §5.3）：催促卡与规则清单「系统规则」那一行。
 *
 * - 卡：你哪天发的、上一封开头、催促草稿；「发出」「修改」在卡身里，卡底那排只有「再等等」「不用跟了」；
 *   改了字再发出 → 带着改过的那一版批；没改 → 原样批。
 * - 系统规则：「发出 3 个工作日没回 → 提醒我」，− / + 改天数、开关、按邮箱分开设（跟着上面 / 自己的天数 / 这只不提醒）。
 */
import type { FollowUpNudgePayload, MessageFollowUpSettings } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { FollowUpSystemRule } from '@/components/messages/follow-up-rule'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const decide = vi.fn(async () => ({}))
let settings: MessageFollowUpSettings = {
  enabled: true,
  business_days: 3,
  accounts: [],
  mailboxes: ['hello@shop.example', 'sales@shop.example'],
}
const setSettings = vi.fn(async (patch: Record<string, unknown>) => {
  settings = {
    ...settings,
    ...(patch.account === undefined
      ? patch
      : {
          accounts: [
            { account: String(patch.account), enabled: patch.enabled as boolean | undefined },
          ],
        }),
  } as MessageFollowUpSettings
  return settings
})

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  decide: (...args: unknown[]) => decide(...(args as [])),
  getMessageFollowUpSettings: async () => settings,
  setMessageFollowUpSettings: (patch: Record<string, unknown>) => setSettings(patch),
}))

const noop = (): void => {}

const payload: FollowUpNudgePayload = {
  form: 'follow_up_nudge',
  channel: 'email',
  thread_ref: '<q1@mail.example>',
  account: 'hello@shop.example',
  to: { type: 'contact', id: 'clara@buyer.example', email: 'clara@buyer.example' },
  recipients: [{ email: 'clara@buyer.example', name: 'Clara Jones' }],
  in_reply_to: '<q1@mail.example>',
  references: ['<q1@mail.example>'],
  body: {
    subject: 'Re: Sample order',
    text: 'Hi Clara,\n\nJust following up on my last email about "Sample order".\n\nThanks!',
  },
  lang: 'en',
  quote: 'Hi Clara, please find the quote for the sample order attached.',
  follow_up: {
    thread_id: '<q1@mail.example>',
    waiting_on: { email: 'clara@buyer.example', name: 'Clara Jones' },
    since: '2026-10-23T12:00:00.000Z',
    business_days: 3,
    waited_business_days: 3,
    basis: 'default',
    reminder: 1,
    nudges: 0,
  },
  surface: 'messages',
}

function nudgeCard(over: Partial<FollowUpNudgePayload> = {}): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_fu',
    title: 'Clara Jones 还没回（3 个工作日）',
    summary: '「Sample order」',
    available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
    detail: { ...base.detail, payload: { ...payload, ...over } },
  })
}

describe('WP442 催促卡', () => {
  beforeEach(() => {
    decide.mockClear()
  })

  it('卡面：你哪天发的、上一封开头、草稿；「发出」「修改」和「不用跟了」「再等等」并成卡底一排（WP478）', () => {
    renderWithProviders(
      <DeckCardView card={nudgeCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    // 没归属的：头一行写「消息 · 催一下」（不写挂名那个岗位）
    expect(screen.getByTestId('deck-band').textContent).toBe('消息 · 催一下')
    expect(screen.getByTestId('follow-up-meta').textContent).toBe('你 10-23 发的')
    expect(screen.getByTestId('follow-up-quote').textContent).toContain('sample order attached')
    expect(screen.getByTestId('follow-up-draft').textContent).toContain('Just following up')
    expect(screen.getByTestId('follow-up-to').textContent).toBe('发给 Clara Jones')
    expect(screen.getByTestId('follow-up-send').textContent).toBe('发出')
    expect(screen.getByTestId('follow-up-edit').textContent).toBe('修改')
    expect(screen.getByTestId('follow-up-rule').textContent).toContain(
      '系统规则：发出 3 个工作日没回 → 提醒我',
    )
    const bar = screen.getByTestId('deck-action-bar')
    const labels = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent)
    // WP478：卡身里的「发出 / 修改」并进卡底这一排
    expect(labels).toEqual(['发出', '修改', '不用跟了', '再等等'])
  })

  it('对方说过哪天答复、第二次提醒：灰字照实写', () => {
    renderWithProviders(
      <DeckCardView
        card={nudgeCard({
          follow_up: {
            ...payload.follow_up,
            basis: 'promised',
            promised_reply_at: '2026-10-26T12:00:00.000Z',
            reminder: 2,
          },
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('follow-up-meta').textContent).toBe(
      '你 10-23 发的 · 对方说过 10-26 答复 · 第二次提醒（之后不再提醒）',
    )
  })

  it('点「修改」就地改字，再「发出」→ 带着改过的那一版批', async () => {
    renderWithProviders(
      <DeckCardView card={nudgeCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    fireEvent.click(screen.getByTestId('follow-up-edit'))
    fireEvent.change(screen.getByTestId('follow-up-text'), {
      target: { value: 'Hi Clara, any news on the sample?' },
    })
    expect(screen.getByTestId('follow-up-edit').textContent).toBe('改好了')
    fireEvent.click(screen.getByTestId('follow-up-send'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [id, input] = decide.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toBe('ap_fu')
    expect(input).toMatchObject({
      action: 'approve',
      edited_payload: {
        form: 'follow_up_nudge',
        body: { text: 'Hi Clara, any news on the sample?' },
      },
    })
  })

  it('没改就发出 → 原样批', async () => {
    renderWithProviders(
      <DeckCardView card={nudgeCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    fireEvent.click(screen.getByTestId('follow-up-send'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [, input] = decide.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(input.edited_payload).toBeUndefined()
  })
})

describe('WP442 系统规则「发出 N 个工作日没回 → 提醒我」', () => {
  beforeEach(() => {
    setSettings.mockClear()
    settings = {
      enabled: true,
      business_days: 3,
      accounts: [],
      mailboxes: ['hello@shop.example', 'sales@shop.example'],
    }
  })

  it('一行：天数、开关；+ 改成 4 天，关掉打出去的是 enabled:false', async () => {
    renderWithProviders(<FollowUpSystemRule />)
    expect((await screen.findByTestId('follow-up-rule-label')).textContent).toContain(
      '发出 3 个工作日没回 → 提醒我',
    )
    fireEvent.click(screen.getByTestId('follow-up-rule-more'))
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ business_days: 4 }))
    await waitFor(() => expect(screen.getByTestId('follow-up-rule-days').textContent).toBe('4'))
    fireEvent.click(screen.getByTestId('follow-up-rule-toggle'))
    await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ enabled: false }))
  })

  it('按邮箱分开设：每只邮箱一行，选「这只不提醒」打出去的是那只邮箱的 enabled:false', async () => {
    renderWithProviders(<FollowUpSystemRule />)
    fireEvent.click(await screen.findByTestId('follow-up-rule-per-account'))
    const rows = screen.getAllByTestId('follow-up-rule-account')
    expect(rows.map((r) => r.getAttribute('data-account'))).toEqual([
      'hello@shop.example',
      'sales@shop.example',
    ])
    fireEvent.change(rows[1] as HTMLSelectElement, { target: { value: 'off' } })
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({ account: 'sales@shop.example', enabled: false }),
    )
    fireEvent.change(rows[0] as HTMLSelectElement, { target: { value: '5' } })
    await waitFor(() =>
      expect(setSettings).toHaveBeenLastCalledWith({
        account: 'hello@shop.example',
        enabled: true,
        business_days: 5,
      }),
    )
  })
})
