import { describe, expect, it } from 'vitest'
import { isKernelError, KernelError } from '../src/index.js'

describe('KernelError（28 §2 统一错误码）', () => {
  it('序列化成网关形状，可选字段缺席而不是 undefined', () => {
    const bare = new KernelError('forbidden', 'nope')
    expect(bare.toJSON()).toEqual({ code: 'forbidden', message: 'nope' })
    expect(Object.keys(bare.toJSON())).toEqual(['code', 'message'])
    expect(bare.name).toBe('KernelError')

    const full = new KernelError('halted', 'outbound halted', {
      details: { scope: 'outbound' },
      trace_id: 'tr_1',
      cause: new Error('root'),
    })
    expect(full.toJSON()).toEqual({
      code: 'halted',
      message: 'outbound halted',
      details: { scope: 'outbound' },
      trace_id: 'tr_1',
    })
    expect((full.cause as Error).message).toBe('root')
  })

  it('isKernelError 只认自己', () => {
    expect(isKernelError(new KernelError('not_found', 'x'))).toBe(true)
    expect(isKernelError(new Error('x'))).toBe(false)
    expect(isKernelError(null)).toBe(false)
  })
})
