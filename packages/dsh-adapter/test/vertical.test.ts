/**
 * 48 v2 L2（WP54）：dsh 这条路的回信也按垂直包说话。
 *
 * WP54 交付三把 stub 与规则脑改成了从垂直包取模板，**漏了 dsh**——它在
 * `reading.ts` 里自己抄了一份 goods 的句子。3 人 pack 的
 * `digital-vertical/account-issue` 在 `--runtime dsh-subprocess` 上把它揪了出来：
 * 工作区已经是虚拟产品，只有这条路还在向一个没有订单的客户要订单号。
 *
 * 这里钉两件事：实物那一档一个字节都没变；虚拟产品那一档要的是注册邮箱。
 */
import { describe, expect, it } from 'vitest'
import { draftBody } from '../src/index.js'

const BASE = {
  windowDays: 14,
  withinWindow: false,
  signature: 'Customer Care',
  customer: 'Cara',
} as const

describe('48 v2 L2：dsh 的回信按垂直包取模板', () => {
  it('不给垂直 = 实物，与 WP54 之前逐字相同', () => {
    expect(draftBody({ ...BASE })).toBe(
      [
        'Hi Cara,',
        '',
        'Thanks for reaching out.',
        '',
        'Our return policy allows returns within 14 days of delivery.',
        '',
        'Tell us the order number and we will check what applies.',
        '',
        'Kind regards,',
        'Customer Care',
      ].join('\n'),
    )
  })

  it('虚拟产品：要注册邮箱，不要订单号；读不到条款数值就不印退货窗口', () => {
    const body = draftBody({ ...BASE, vertical: 'digital', windowFromFact: false })
    expect(body).toContain('email address your account is registered with')
    expect(body).not.toContain('order number')
    expect(body).not.toContain('Our return policy allows returns')
  })
})
