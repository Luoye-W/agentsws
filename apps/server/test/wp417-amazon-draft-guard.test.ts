/**
 * WP417（自查客服 B5）：Amazon 买家消息起草时就过平台硬闸。
 */
import { describe, expect, it } from 'vitest'
import { amazonDraftGuard } from '../src/amazon-draft-guard.js'

const RELAY = 'abcd1234efgh5678@marketplace.amazon.com'

describe('WP417 B5', () => {
  it('relay 收件人 + 正文带外链 → 打回重写，说清为什么', () => {
    const v = amazonDraftGuard({
      recipient: RELAY,
      subject: 'Re: your order',
      body: 'Please visit https://myshop.example/help or email me at me@shop.example',
    })
    expect(v?.action).toBe('rewrite')
    expect(v?.note).toContain('Amazon 站内信规矩')
    expect(v?.rewrite_instruction.length).toBeGreaterThan(0)
  })
  it('干净的正文 / 不是 relay 收件人 → 照常走', () => {
    expect(
      amazonDraftGuard({
        recipient: RELAY,
        subject: 'Re: order',
        body: 'Your parcel ships tomorrow.',
      }),
    ).toBeUndefined()
    expect(
      amazonDraftGuard({
        recipient: 'ann@customer.test',
        subject: 'Re',
        body: 'see https://x.example',
      }),
    ).toBeUndefined()
  })
})
