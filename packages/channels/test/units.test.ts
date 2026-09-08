import { describe, expect, it } from 'vitest'
import { MemoryThreadStore, mergeThread } from '../src/email/threads.js'
import { ChannelError, isChannelError } from '../src/errors.js'
import * as channels from '../src/index.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { hasSecret, scrubSecrets } from '../src/secrets.js'

describe('包出口', () => {
  it('barrel 导出三件套：适配器、管线、投递', () => {
    expect(typeof channels.EmailChannelAdapter).toBe('function')
    expect(typeof channels.ChannelInboundPipeline).toBe('function')
    expect(typeof channels.EmailDeliveryProvider).toBe('function')
    expect(typeof channels.MemoryRawStore).toBe('function')
    expect(typeof channels.defaultRoute).toBe('function')
  })
})

describe('ChannelError', () => {
  it('只用契约里的错误码，并可判别', () => {
    const e = new ChannelError('invalid_input', '坏输入', { field: 'from' })
    expect(isChannelError(e)).toBe(true)
    expect(isChannelError(new Error('x'))).toBe(false)
    expect(e.code).toBe('invalid_input')
    expect(e.details).toEqual({ field: 'from' })
  })
})

describe('secrets', () => {
  it('四类模式都命中并只报一次', () => {
    const r = scrubSecrets('key sk-abcdefghijklmnop AKIAABCDEFGHIJKLMNOP card 4111111111111111')
    expect(r.rules).toEqual(['api_key', 'aws_key', 'card_number'])
    expect(r.text).not.toContain('sk-abcdefghijklmnop')
    expect(r.text).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  it('干净文本原样返回', () => {
    expect(scrubSecrets('order 1001 is late')).toEqual({
      text: 'order 1001 is late',
      rules: [],
    })
    expect(hasSecret('order 1001 is late')).toBe(false)
    expect(hasSecret('password: hunter2000')).toBe(true)
  })
})

describe('MemoryRawStore', () => {
  it('put / get / all / size', () => {
    const store = new MemoryRawStore()
    const ref = store.put({
      channel: 'email',
      kind: 'message',
      stored_at: '2026-09-09T08:00:00.000Z',
      payload: 'hello 4111 1111 1111 1111',
    })
    expect(store.size).toBe(1)
    expect(store.all()[0]?.ref).toBe(ref)
    expect(store.get('raw://nope')).toBeUndefined()
  })

  it('scrub 就地脱敏，字节载荷不动，缺记录报 not_found', () => {
    const store = new MemoryRawStore()
    const text = store.put({
      channel: 'email',
      kind: 'message',
      stored_at: '2026-09-09T08:00:00.000Z',
      payload: 'card 4111 1111 1111 1111',
    })
    store.scrub(text, (t) => scrubSecrets(t).text)
    expect(store.get(text)?.payload).toBe('card [redacted:card_number]')
    expect(store.get(text)?.secrets_scrubbed).toBe(true)

    const bytes = store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: '2026-09-09T08:00:00.000Z',
      payload: new Uint8Array([1, 2, 3]),
    })
    store.scrub(bytes, (t) => t.toUpperCase())
    expect(store.get(bytes)?.payload).toEqual(new Uint8Array([1, 2, 3]))

    expect(() => store.scrub('raw://nope', (t) => t)).toThrow(/原始材料不存在/)
  })
})

describe('线程台账', () => {
  it('mergeThread 去重参与者与 references，保留旧的 last_message_id', () => {
    const first = mergeThread(undefined, {
      external_id: '<t1@x>',
      participants: ['Ann@X.com', 'ann@x.com', ''],
      references: ['<r1@x>'],
      message_id: '<m1@x>',
      subject: 'Order',
      at: '2026-09-09T08:00:00.000Z',
    })
    expect(first.participants).toEqual(['ann@x.com'])
    expect(first.references).toEqual(['<r1@x>', '<m1@x>'])
    expect(first.last_message_id).toBe('<m1@x>')

    const second = mergeThread(first, {
      external_id: '<t1@x>',
      participants: ['bob@x.com'],
      references: ['<r1@x>'],
      at: '2026-09-09T09:00:00.000Z',
    })
    expect(second.participants).toEqual(['ann@x.com', 'bob@x.com'])
    expect(second.last_message_id).toBe('<m1@x>')
    expect(second.subject).toBe('Order')

    const noPrior = mergeThread(undefined, {
      external_id: '<t2@x>',
      participants: [],
      references: [],
      at: '2026-09-09T09:00:00.000Z',
    })
    expect(noPrior.last_message_id).toBeUndefined()
    expect(noPrior.subject).toBeUndefined()
  })

  it('MemoryThreadStore 返回拷贝，改不动库里的记录', () => {
    const store = new MemoryThreadStore()
    store.upsert({
      external_id: '<t@x>',
      participants: ['ann@x.com'],
      references: [],
      updated_at: '2026-09-09T08:00:00.000Z',
    })
    const rec = store.get('<t@x>')
    rec?.participants.push('attacker@evil.com')
    expect(store.get('<t@x>')?.participants).toEqual(['ann@x.com'])
    expect(store.get('<missing@x>')).toBeUndefined()
    expect(store.size).toBe(1)
  })
})
