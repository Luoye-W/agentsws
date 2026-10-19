/**
 * WP417（自查客服 B3）：Amazon 买家消息（marketplace relay 发来）分拣成客服，不被当成自动通知。
 */
import { describe, expect, it } from 'vitest'
import { type TriageContext, type TriageInput, triageByRules } from '../src/index.js'

const T0 = '2026-10-19T02:00:00.000Z'
const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  from_email: 'abcd1234efgh5678@marketplace.amazon.com',
  subject: 'Inquiry from Amazon customer',
  text: 'Where is my package?',
  thread_id: '<m1@amazon.example>',
  references: [],
  // relay 信头常带这一行，以前会被当成自动通知
  headers: { precedence: 'bulk' },
  has_attachments: false,
  ...over,
})
const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  support_enabled: true,
  kol_enabled: false,
  b2b_enabled: false,
  isSupportThread: () => false,
  isKolThread: () => false,
  isB2bThread: () => false,
  isB2bSender: () => false,
  senderRules: [],
  model_halted: false,
  at: T0,
  ...over,
})

describe('WP417 B3', () => {
  it('relay 地址发来的 → 客服', () => {
    expect(triageByRules(input(), ctx())?.route).toBe('support')
    expect(
      triageByRules(input({ from_email: 'x@marketplace.amazon.co.uk' }), ctx())?.route,
    ).not.toBe('support')
  })
  it('客服没开 → 不走这条', () => {
    expect(triageByRules(input(), ctx({ support_enabled: false }))?.route).not.toBe('support')
  })
})
