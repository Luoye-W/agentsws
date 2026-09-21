import { describe, expect, it } from 'vitest'
import {
  createNodeRelay,
  ensurePairingToken,
  MemoryPairingStore,
  type RelaySocket,
} from '../src/node.js'
import { parseClientFrame, type RelayFrame } from '../src/protocol.js'

/** 一条可驱动的假 WS（与服务端那侧对接）。 */
class FakeSocket implements RelaySocket {
  readonly inbox: RelayFrame[] = []
  private messageHandler: ((text: string) => void) | undefined
  private closeHandler: (() => void) | undefined
  closed = false

  send(text: string): void {
    this.inbox.push(JSON.parse(text) as RelayFrame)
  }
  close(): void {
    this.closed = true
    this.closeHandler?.()
  }
  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  /** 测试驱动：模拟对面发来一帧。 */
  emit(text: string): void {
    this.messageHandler?.(text)
  }
  hello(pairing: string, peer: 'server' | 'hosted' = 'server'): void {
    this.emit(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: 'ws_x',
        pairing,
        peer,
        config: { enabled: true, accent: '#2563eb', greeting: '你好' },
      }),
    )
  }
}

describe('Node 薄适配', () => {
  it('首启配对密钥只生成一次，之后只存哈希（重发 = 再泄露一遍）', () => {
    const store = new MemoryPairingStore()
    const first = ensurePairingToken(store, 'ws_x')
    expect(first).toMatch(/^prk_/)
    // 第二次：绝不重发
    expect(ensurePairingToken(store, 'ws_x')).toBeUndefined()
    // 存的是哈希不是明文
    expect(store.hash('ws_x')).not.toBe(first)
    expect(store.hash('ws_x')).toHaveLength(64)
  })

  it('握手 → 访客消息 → 回复原路回去（acceptSocket 全流程）', async () => {
    const store = new MemoryPairingStore()
    const token = ensurePairingToken(store, 'ws_x') as string
    const relay = createNodeRelay({
      clock: () => '2026-09-21T10:00:00.000Z',
      pairing: store,
    })
    const socket = new FakeSocket()
    relay.acceptSocket(socket)

    socket.hello('wrong')
    expect(socket.inbox[0]).toMatchObject({ type: 'hello_err', reason: 'bad_pairing' })

    socket.hello(token)
    expect(socket.inbox[1]).toMatchObject({ type: 'hello_ok', protocol_version: 1 })

    const pushed: unknown[] = []
    relay.core.attachVisitor('ws_x', 's1', 'v1', { send: (f) => pushed.push(f), close: () => {} })
    expect(
      relay.core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: 'hi' }),
    ).toEqual({
      status: 'forwarded',
    })
    const visit = socket.inbox.find((f) => f.type === 'visit') as { turn: string; text: string }
    expect(visit.text).toBe('hi')

    socket.emit(
      JSON.stringify({
        type: 'reply',
        session: 's1',
        turn: visit.turn,
        message_id: 'm1',
        text: '回你',
      }),
    )
    expect(pushed).toContainEqual({ type: 'message', message: { role: 'agent', text: '回你' } })
  })

  it('未握手的连接不许说话', () => {
    const store = new MemoryPairingStore()
    ensurePairingToken(store, 'ws_x')
    const relay = createNodeRelay({ clock: () => '2026-09-21T10:00:00.000Z', pairing: store })
    const socket = new FakeSocket()
    relay.acceptSocket(socket)
    socket.emit(
      JSON.stringify({ type: 'reply', session: 's', turn: 't', message_id: 'm', text: 'x' }),
    )
    expect(socket.inbox).toContainEqual({
      type: 'error',
      code: 'not_handshaken',
      message: '先握手再说话',
    })
  })

  it('带自由文本的打字帧被协议层拒绝（全替身，不联网）', () => {
    const store = new MemoryPairingStore()
    const token = ensurePairingToken(store, 'ws_x') as string
    const relay = createNodeRelay({ clock: () => '2026-09-21T10:00:00.000Z', pairing: store })
    const socket = new FakeSocket()
    relay.acceptSocket(socket)
    socket.hello(token)
    const before = socket.inbox.length
    socket.emit(JSON.stringify({ type: 'typing', session: 's1', active: true, draft: '偷渡' }))
    expect(socket.inbox.length).toBe(before + 1)
    expect(socket.inbox.at(-1)).toMatchObject({ type: 'error', code: 'bad_frame' })
    // 合法的纯布尔打字帧被接受（不产生错误帧）
    const beforeOk = socket.inbox.length
    socket.emit(JSON.stringify({ type: 'typing', session: 's1', active: true }))
    expect(socket.inbox.slice(beforeOk).some((f) => f.type === 'error')).toBe(false)
  })

  it('parseClientFrame 是唯一入口：形状不对的帧一律 bad_frame', () => {
    const store = new MemoryPairingStore()
    const token = ensurePairingToken(store, 'ws_x') as string
    const relay = createNodeRelay({ clock: () => '2026-09-21T10:00:00.000Z', pairing: store })
    const socket = new FakeSocket()
    relay.acceptSocket(socket)
    socket.hello(token)
    const before = socket.inbox.length
    socket.emit('not json')
    socket.emit(JSON.stringify({ type: 'nonsense' }))
    expect(socket.inbox.slice(before)).toEqual([
      { type: 'error', code: 'bad_frame', message: '帧解析失败' },
      { type: 'error', code: 'bad_frame', message: '帧解析失败' },
    ])
    expect(parseClientFrame('{}')).toBeUndefined()
  })
})
