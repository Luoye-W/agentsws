/**
 * WP210（Luoye 09-30）：失败的信系统自己按退避重投，手动「重投」只留在「设置 → 诊断」；
 * 消息渠道页减字（安全承诺进页头问号）；已连上的卡标题取账号本身。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountLabel } from '@/components/connections/account-label'
import type { DeadLetterView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const requeued: string[] = []
const letters: DeadLetterView[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listDeadLetters: async () => ({ dead_letters: letters }),
    requeueDeadLetter: async (id: string) => {
      requeued.push(id)
      return { requeued: true }
    },
    getImStatus: async () => ({
      wechat: { allowed: true, bound: false, live: false },
      wecom: { configured: false, connected: false },
    }),
  }
})

const { DiagnosticsCard } = await import('@/components/settings/diagnostics-card')
const { ImChannelsPage } = await import('@/pages/im-channels')

beforeEach(() => {
  requeued.length = 0
  letters.splice(0, letters.length)
})

describe('设置 → 诊断：没进来的信', () => {
  it('列出系统打算怎么办；客户来信打标；手动重投只在这里', async () => {
    const user = userEvent.setup()
    letters.push(
      {
        id: 'dl_1',
        channel: 'email',
        from: 'Alice',
        reason: 'retries_exhausted',
        attempts: 5,
        last_error: 'canonicalJson 炸了',
        at: '2026-09-30T08:00:00.000Z',
        customer: true,
        auto_retry: { rounds: 1, gave_up: false, next_at: '2026-09-30T10:00:00.000Z' },
      },
      {
        id: 'dl_2',
        channel: 'email',
        from: 'Shopify',
        reason: 'retries_exhausted',
        attempts: 5,
        at: '2026-09-29T08:00:00.000Z',
        customer: false,
        auto_retry: { rounds: 4, gave_up: true },
      },
    )
    renderWithProviders(<DiagnosticsCard assignment="asg_owner" />)
    const rows = await screen.findAllByTestId('dead-letter')
    expect(rows).toHaveLength(2)
    const [alice, shopify] = rows as [HTMLElement, HTMLElement]
    expect(alice.textContent).toContain('客户来信')
    expect(alice.textContent).toContain('自动再试')
    expect(within(alice).getByTestId('dead-letter-why').getAttribute('data-hint')).toContain(
      'canonicalJson',
    )
    expect(shopify.textContent).not.toContain('客户来信')
    expect(shopify.textContent).toContain('已停止自动重试')
    await user.click(within(shopify).getByRole('button', { name: /重投/ }))
    await waitFor(() => {
      expect(requeued).toEqual(['dl_2'])
    })
  })

  it('一封都没有：一句空态', async () => {
    renderWithProviders(<DiagnosticsCard assignment="asg_owner" />)
    expect(await screen.findByTestId('diagnostics-dead-empty')).toBeDefined()
  })
})

describe('消息渠道页减字', () => {
  it('卡上只有名字 + 问号 + 状态 + 主按钮（微信条款风险例外）；安全承诺与「只投摘要」进页头问号', async () => {
    renderWithProviders(<ImChannelsPage />)
    const header = await screen.findByTestId('im-header-hint')
    const hint = header.getAttribute('data-hint') ?? ''
    expect(hint).toContain('不经 AI')
    expect(hint).toContain('Secret 直接进本机加密库')
    expect(hint).toContain('不放通过 / 驳回按钮')
    // 例外（Fable 09-30）：微信的条款风险一行留在卡上，原话照旧，条款出处在旁边问号里
    const notes = [...document.querySelectorAll('[data-slot="safety-note"]')]
    expect(notes).toHaveLength(1)
    expect(notes[0]?.textContent).toContain('会牵连你的主微信号')
    expect(notes[0]?.querySelector('[data-slot="hint"]')?.getAttribute('data-hint')).toContain(
      '6.1',
    )
    expect(screen.getByTestId('im-wechat-what').getAttribute('data-hint') ?? '').toContain(
      '扫一次码',
    )
  })
})

describe('accountLabel', () => {
  it('身份展示名 → 账号 id → 别名 → 类型名', () => {
    const base = { alias: '', service_label: '任意邮箱（IMAP / SMTP）' }
    expect(accountLabel({ ...base, identity: { display_name: 'a@b.com' } })).toBe('a@b.com')
    expect(accountLabel({ ...base, identity: { account_id: 'shop-1.myshopify.com' } })).toBe(
      'shop-1.myshopify.com',
    )
    expect(accountLabel({ ...base, alias: '主店' })).toBe('主店')
    expect(accountLabel(base)).toBe('任意邮箱（IMAP / SMTP）')
  })
})

describe('客户来信投不进的那张卡（Fable 09-30：两个按钮）', () => {
  it('主按钮「再投一次」、次按钮「去邮箱回复」；后者直接记一笔并带人去消息页', async () => {
    const { DeckCardView } = await import('@/components/deck/deck-card')
    const { draftCard } = await import('./fixtures')
    const decided: { action: string; reason?: string }[] = []
    const user = userEvent.setup()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          kind: 'inbound_dead_letter',
          layout: 'policy',
          title: '有一封客户来信没能处理，请看一眼',
          available_actions: ['approve', 'reject', 'snooze', 'open'],
        })}
        mode="zh_summary"
        onDecide={(r) => {
          decided.push(r)
        }}
        onOpen={() => {}}
      />,
      '/',
    )
    const bar = screen.getByTestId('deck-action-bar')
    const primary = within(bar).getByRole('button', { name: '再投一次' })
    expect(primary.getAttribute('data-rank')).toBe('primary')
    const reply = within(bar).getByRole('button', { name: '去邮箱回复' })
    expect(reply.getAttribute('data-rank')).toBe('secondary')
    await user.click(reply)
    // 不开写理由的面板，直接决定
    expect(decided).toEqual([{ action: 'reject', reason: '我自己去邮箱回复', version: 1 }])
    expect(screen.getByTestId('deck-card').getAttribute('data-go-messages')).toBe('true')
  })
})
