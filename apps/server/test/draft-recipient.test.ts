import { describe, expect, it } from 'vitest'
import { pickDraftRecipient } from '../src/runtime.js'

describe('回信收件人只能是来信人（31 §3.3，09-14 真店实测）', () => {
  const sender = { type: 'contact' as const, id: 'cnt_sender' }
  const orderCustomer = { type: 'contact' as const, id: 'cnt_order_customer' }

  it('事项钉着来信人：模型给了订单上的客户邮箱也改回来信人', () => {
    expect(pickDraftRecipient({ pinnedContact: sender, resolved: orderCustomer })).toEqual(sender)
  })

  it('事项钉着来信人、模型给的地址解析不出来：仍然是来信人', () => {
    expect(pickDraftRecipient({ pinnedContact: sender, resolved: undefined })).toEqual(sender)
  })

  it('老事项没钉联系人：按模型给的地址解析出来的那个；解析不出就不建卡', () => {
    expect(pickDraftRecipient({ pinnedContact: undefined, resolved: orderCustomer })).toEqual(
      orderCustomer,
    )
    expect(pickDraftRecipient({ pinnedContact: undefined, resolved: undefined })).toBeUndefined()
  })
})
