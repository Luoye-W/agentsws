/**
 * WP173（docs/84 §2 / §11.1）：「主动开发」岗位页上的开发信那一块。
 *
 * 钉的是"发不了的原因看得见"：
 *
 * 1. 还没选发信邮箱 → 一句话指到那张卡；选了主域名 → 「主域名」+ 风险在问号里；
 * 2. SPF / DKIM 没过 → 可见的一句「没过不发」；
 * 3. 德国 / 奥地利默认不发，原因常驻；勾选之后还要**再点一次确认**才发出设置请求；
 * 4. 开一轮之后，没放进来的人逐个写原因。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { B2bOutboundData, B2bSequenceStartData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const BASE: B2bOutboundData = {
  settings: { de_at_confirmed: false, choice_card_id: 'apr_choice' },
  needs: ['sender_choice', 'company_address'],
  funnel: [],
  queued: { sender_choice: 3 },
  eligible: 3,
  excluded: [
    { reason: 'de_at', label: '德国 / 奥地利默认不发', count: 2 },
    { reason: 'no_source', label: '没写从哪来的', count: 1 },
  ],
}

const WITH_SENDER: B2bOutboundData = {
  ...BASE,
  settings: {
    ...BASE.settings,
    postal_address: '8 Keji Rd',
    sender_address: 'hello@brand.example',
  },
  needs: ['sender_auth'],
  queued: { sender_auth: 3 },
  sender: {
    address: 'hello@brand.example',
    separate_domain: false,
    auth: {
      spf: 'pass',
      dkim: 'fail',
      dmarc: 'missing',
      notes: ['DKIM：测试信签的是 other.example'],
    },
    quota: {
      cap: 20,
      sent_today: 0,
      reserved: 0,
      remaining: 20,
      warming: true,
      warm_from: '2026-10-12T02:00:00.000Z',
    },
  },
}

const START: B2bSequenceStartData = {
  status: 'nothing_to_send',
  message: '这一批都在德国 / 奥地利，默认不发。',
  picked: 0,
  queued_tomorrow: 0,
  excluded: [
    {
      contact_id: 'ctc_nord',
      name: 'Jan',
      company: 'Nordlicht',
      reason: 'de_at',
      label: '德国 / 奥地利默认不发：两国法院常把未经同意的 B2B 冷邮件判为违法',
    },
  ],
}

const getB2bOutbound = vi.fn<() => Promise<B2bOutboundData>>()
const saveB2bOutboundSettings = vi.fn<(input: unknown) => Promise<B2bOutboundData>>()
const startB2bSequence = vi.fn<(input: unknown) => Promise<B2bSequenceStartData>>()
const checkB2bSender = vi.fn<() => Promise<B2bOutboundData>>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getB2bOutbound: () => getB2bOutbound(),
    saveB2bOutboundSettings: (input: unknown) => saveB2bOutboundSettings(input),
    startB2bSequence: (input: unknown) => startB2bSequence(input),
    checkB2bSender: () => checkB2bSender(),
  }
})

const { B2bOutboundPanel } = await import('@/components/b2b/outbound-panel')

describe('开发信面板', () => {
  beforeEach(() => {
    getB2bOutbound.mockReset()
    saveB2bOutboundSettings.mockReset()
    startB2bSequence.mockReset()
    checkB2bSender.mockReset()
  })

  it('还没选发信邮箱：一句话指到卡；德奥默认不发的原因常驻', async () => {
    getB2bOutbound.mockResolvedValue(BASE)
    renderWithProviders(<B2bOutboundPanel assignment="asg_out" />)
    expect((await screen.findByTestId('b2b-sender-none')).textContent).toContain(
      '待办里有一张卡等你选',
    )
    expect(screen.getByTestId('b2b-de-at-excluded').textContent).toContain(
      '德国 / 奥地利 2 家默认不发：两国法院常把未经同意的 B2B 冷邮件判为违法',
    )
    expect(screen.getByTestId('b2b-queued').textContent).toContain('还没选发信邮箱 · 3 位')
  })

  it('主域名 + DKIM 没过：看得见「没过不发」与预热配额', async () => {
    getB2bOutbound.mockResolvedValue(WITH_SENDER)
    renderWithProviders(<B2bOutboundPanel assignment="asg_out" />)
    expect(await screen.findByText('主域名')).toBeTruthy()
    expect(screen.getByTestId('b2b-auth-block').textContent).toContain('SPF / DKIM 没过不发')
    expect(document.querySelector('[data-auth="dkim"]')?.getAttribute('data-result')).toBe('fail')
    expect(screen.getByTestId('b2b-quota').textContent).toContain(
      '今天还能发 20 封 · 预热期每天 20 封，10-12 起放宽',
    )
  })

  it('德奥：勾选之后还要再点一次确认，才发出设置请求', async () => {
    getB2bOutbound.mockResolvedValue(BASE)
    saveB2bOutboundSettings.mockResolvedValue({
      ...BASE,
      settings: { ...BASE.settings, de_at_confirmed: true },
    })
    renderWithProviders(<B2bOutboundPanel assignment="asg_out" />)
    fireEvent.click(await screen.findByTestId('b2b-de-at-check'))
    expect(saveB2bOutboundSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '我知道风险，确认要发' }))
    await waitFor(() =>
      expect(saveB2bOutboundSettings).toHaveBeenCalledWith({ de_at_confirm: true }),
    )
    expect(await screen.findByText('已确认风险：德国、奥地利也会发')).toBeTruthy()
  })

  it('开一轮：没放进来的逐个写原因', async () => {
    getB2bOutbound.mockResolvedValue(BASE)
    startB2bSequence.mockResolvedValue(START)
    renderWithProviders(<B2bOutboundPanel assignment="asg_out" />)
    fireEvent.click(await screen.findByRole('button', { name: /开一轮（3 家）/ }))
    const result = await screen.findByTestId('b2b-start-result')
    expect(result.getAttribute('data-status')).toBe('nothing_to_send')
    expect(result.textContent).toContain('Nordlicht（Jan）：德国 / 奥地利默认不发')
  })
})
