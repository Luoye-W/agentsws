import { describe, expect, it } from 'vitest'
import {
  changeRequested,
  DirectRuntimeError,
  itemsOfKind,
  orderIdFromText,
  orderView,
  plainText,
  refOf,
  threadText,
  withToolChoice,
} from '../src/index.js'
import { clock, gatewayOf, makeRequest, ORDER } from './helpers.js'

describe('零碎件', () => {
  it('DirectRuntimeError 带契约里的错误码', () => {
    const e = new DirectRuntimeError('invalid_input', '坏输入', { field: 'x' })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('DirectRuntimeError')
    expect(e.code).toBe('invalid_input')
    expect(e.details).toEqual({ field: 'x' })
  })

  it('plainText：字符串 / 数组 / 结构化 / 空值', () => {
    expect(plainText('hi')).toBe('hi')
    expect(plainText(null)).toBe('')
    expect(plainText(undefined)).toBe('')
    expect(plainText(['a', 'b'])).toBe('a\nb')
    expect(plainText({ text: 'body', subject: 'subj' })).toBe('body\nsubj')
    expect(plainText({ a: 'x', b: 'y' })).toBe('x\ny')
    expect(plainText(42)).toBe('42')
  })

  it('orderView / orderIdFromText / refOf / itemsOfKind / threadText', () => {
    expect(orderView(undefined)).toBeUndefined()
    expect(orderView({ nothing: true })).toBeUndefined()
    expect(orderView({ nothing: true }, { type: 'order', id: 'ord_9' })?.id).toBe('ord_9')
    const view = orderView(ORDER)
    expect(view?.customer_name).toBe('Anna Meyer')
    expect(view?.record_version).toBe('v1')
    expect(orderIdFromText('nothing here')).toBeUndefined()
    expect(orderIdFromText('about #1001 please')).toBe('ord_1001')

    const req = makeRequest()
    expect(itemsOfKind(req, 'thread')).toHaveLength(1)
    expect(refOf(req.context[0] as never)).toBeUndefined() // policy 项的 source_ref 是字符串
    expect(threadText(req)).toContain('external_data')
    expect(changeRequested(threadText(req))).toBe(true)
    expect(changeRequested('just saying hello')).toBe(false)
  })

  it('withToolChoice 把其余网关方法原样转发', async () => {
    const c = clock()
    const base = gatewayOf([{ text: 'ok' }], c)
    const wrapped = withToolChoice(base)
    const meta = {
      workspace_id: 'ws_test',
      assignment_id: 'asg_1',
      role_id: 'dtc.aftersales',
      run_id: 'run_test_1',
      purpose: 'run' as const,
    }
    const completion = await wrapped.complete({
      messages: [{ role: 'user', content: 'hi' }],
      meta,
    })
    expect(completion.text).toBe('ok')
    await expect(wrapped.embed(['x'], meta)).rejects.toThrow()
    await expect(wrapped.usage({ workspace_id: 'ws_test' })).resolves.toMatchObject({ calls: 1 })
    await expect(wrapped.budget({ workspace_id: 'ws_test' })).resolves.toMatchObject({
      frozen: false,
    })
  })
})
