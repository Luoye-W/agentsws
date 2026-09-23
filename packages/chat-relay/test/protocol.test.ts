import { describe, expect, it } from 'vitest'
import {
  encodeRelayFrame,
  negotiateVersion,
  parseClientFrame,
  RELAY_PROTOCOL_VERSION,
} from '../src/protocol.js'

describe('转发器协议', () => {
  it('版本协商：支持区间内的取原值，区间外不兼容', () => {
    expect(negotiateVersion([1], 1)).toBe(1)
    expect(negotiateVersion([1], 2)).toBeUndefined()
    expect(negotiateVersion([1, 2], 2)).toBe(2)
    expect(RELAY_PROTOCOL_VERSION).toBe(1)
  })

  it('握手帧解析：形状完整才通过', () => {
    const hello = {
      type: 'hello',
      protocol_version: 1,
      workspace: 'ws_x',
      pairing: 'prk_abc',
      peer: 'server',
    }
    expect(parseClientFrame(JSON.stringify(hello))).toMatchObject({ type: 'hello' })
    // 缺配对密钥 / 工作区 / 对端类型：都是不合法
    expect(parseClientFrame(JSON.stringify({ ...hello, pairing: '' }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ ...hello, workspace: 3 }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ ...hello, peer: 'admin' }))).toBeUndefined()
    expect(parseClientFrame('not json')).toBeUndefined()
  })

  it('打字信号只承载布尔：多一个键都拒（FR-035，服务端强制）', () => {
    expect(
      parseClientFrame(JSON.stringify({ type: 'typing', session: 's1', active: true })),
    ).toEqual({
      type: 'typing',
      session: 's1',
      active: true,
    })
    // 带输入框内容 / 字符数 / 片段：一律拒——隐私红线不依赖客户端自律
    expect(
      parseClientFrame(
        JSON.stringify({ type: 'typing', session: 's1', active: true, draft: 'hi' }),
      ),
    ).toBeUndefined()
    expect(
      parseClientFrame(JSON.stringify({ type: 'typing', session: 's1', active: true, length: 2 })),
    ).toBeUndefined()
    // active 不是布尔也拒
    expect(
      parseClientFrame(JSON.stringify({ type: 'typing', session: 's1', active: 'yes' })),
    ).toBeUndefined()
  })

  it('回复帧必须带会话、话轮、消息 id 与正文', () => {
    const reply = { type: 'reply', session: 's1', turn: 't1', message_id: 'm1', text: '好的' }
    expect(parseClientFrame(JSON.stringify(reply))).toEqual(reply)
    expect(parseClientFrame(JSON.stringify({ ...reply, text: '' }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ ...reply, turn: '' }))).toBeUndefined()
  })

  it('帧序列化是 JSON 文本', () => {
    expect(encodeRelayFrame({ type: 'pong' })).toBe('{"type":"pong"}')
  })
})
