import { describe, expect, it } from 'vitest'
import {
  type ClientHandle,
  RelayCore,
  type RelayCoreOptions,
  type RelayEvent,
} from '../src/core.js'
import { MemoryOfflineBox } from '../src/index.js'
import { parseClientFrame, type RelayFrame } from '../src/protocol.js'

const NOW = '2026-09-21T10:00:00.000Z'

/** 一个能记下每一帧的假对端（商家本机 / 托管实例）。 */
function fakePeer(): { handle: ClientHandle; sent: RelayFrame[]; closed: boolean } {
  const sent: RelayFrame[] = []
  const state = { closed: false }
  return {
    sent,
    get closed() {
      return state.closed
    },
    handle: {
      peer: 'server',
      send: (f) => sent.push(f),
      close: () => {
        state.closed = true
      },
    },
  }
}

/** 一条假 WS：握手用（handshake 收的是裸 socket 形状）。 */
function fakeSocket(sent: RelayFrame[]): { send(f: RelayFrame): void; close(): void } {
  return {
    send: (f) => sent.push(f),
    close: () => {
      sent.push({ type: 'error', code: 'closed', message: 'closed' })
    },
  }
}

function makeCore(overrides: Partial<RelayCoreOptions> = {}): {
  core: RelayCore
  events: RelayEvent[]
} {
  const events: RelayEvent[] = []
  const core = new RelayCore({
    clock: () => NOW,
    verifyPairing: (ws, token) => ws === 'ws_x' && token === 'prk_ok',
    newId: (() => {
      let n = 0
      return () => {
        n += 1
        return `id${n}`
      }
    })(),
    onEvent: (e) => events.push(e),
    ...overrides,
  })
  return { core, events }
}

describe('转发器核心', () => {
  it('握手：版本不符回 hello_err 与支持区间；密钥错回 bad_pairing（不区分提示）', () => {
    const { core } = makeCore()
    const badVersion: RelayFrame[] = []
    const r1 = core.handshake(
      fakeSocket(badVersion),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 99,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    expect(r1.ok).toBe(false)
    expect(badVersion[0]).toMatchObject({ type: 'hello_err', reason: 'version_mismatch' })

    const badPairing: RelayFrame[] = []
    const r2 = core.handshake(
      fakeSocket(badPairing),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_wrong',
          peer: 'server',
        }),
      ) as never,
    )
    expect(r2.ok).toBe(false)
    expect(badPairing[0]).toMatchObject({ type: 'hello_err', reason: 'bad_pairing' })
  })

  it('访客消息转发给在线的对端，回复从原路回去；一轮恰好一条', () => {
    const { core } = makeCore()
    const peer = fakePeer()
    core.handshake(
      fakeSocket(peer.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    // 对面推了挂件外观
    core.onClientFrame('ws_x', {
      type: 'config',
      config: { enabled: true, accent: '#2563eb', greeting: '你好' },
    })
    expect(core.publicConfig('ws_x').enabled).toBe(true)

    const pushed: unknown[] = []
    core.attachVisitor('ws_x', 's1', 'v1', {
      send: (f) => pushed.push(f),
      close: () => {},
    })
    const result = core.visitorMessage({
      workspace: 'ws_x',
      session: 's1',
      visitor: 'v1',
      text: '这款防水吗',
    })
    expect(result).toEqual({ status: 'forwarded' })
    const visit = peer.sent.find((f) => f.type === 'visit') as Extract<
      RelayFrame,
      { type: 'visit' }
    >
    expect(visit?.text).toBe('这款防水吗')
    expect(visit?.turn).toBeTruthy()

    // 第一条回复放行
    core.onClientFrame('ws_x', {
      type: 'reply',
      session: 's1',
      turn: visit.turn,
      message_id: 'm1',
      text: '防水的',
    })
    expect(pushed).toContainEqual({ type: 'message', message: { role: 'agent', text: '防水的' } })

    // 同一轮第二条回复：丢弃并回错误
    core.onClientFrame('ws_x', {
      type: 'reply',
      session: 's1',
      turn: visit.turn,
      message_id: 'm2',
      text: '再说一遍',
    })
    expect(pushed).not.toContainEqual({
      type: 'message',
      message: { role: 'agent', text: '再说一遍' },
    })
    expect(peer.sent.some((f) => f.type === 'error' && f.code === 'turn_already_answered')).toBe(
      true,
    )
  })

  it('对端不在线：访客拿「离线」，可以留言；上线后拉走并清除', () => {
    const box = new MemoryOfflineBox()
    const { core } = makeCore({ offline: box })
    const pushed: unknown[] = []
    core.attachVisitor('ws_x', 's1', 'v1', { send: (f) => pushed.push(f), close: () => {} })
    expect(
      core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: '在吗' }),
    ).toEqual({
      status: 'offline',
      reason: 'peer_offline',
    })
    core.leaveOfflineMessage('ws_x', JSON.stringify({ email: 'a@b.c', text: '留言' }))
    expect(box.count('ws_x')).toBe(1)

    // 上线、拉走、清除
    const peer = fakePeer()
    core.handshake(
      fakeSocket(peer.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    core.onClientFrame('ws_x', { type: 'pull_offline' })
    const batch = peer.sent.find((f) => f.type === 'offline_batch') as Extract<
      RelayFrame,
      { type: 'offline_batch' }
    >
    expect(batch.items.length).toBe(1)
    expect(box.count('ws_x')).toBe(0)
  })

  it('免费额度到顶：新访客拿「离线」，80% 与到顶都有事件；在途放行', () => {
    const { core, events } = makeCore({ conversationLimit: 200 })
    const peer = fakePeer()
    core.handshake(
      fakeSocket(peer.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    // 200 个不同访客（每次都过 30 分钟窗口 = 都是新对话）
    let i = 0
    while (i < 200) {
      i += 1
      core.visitorMessage({ workspace: 'ws_x', session: `s${i}`, visitor: `v${i}`, text: 'hi' })
    }
    // 第 160 个跨了 80%
    expect(events.some((e) => e.type === 'quota_warn_80')).toBe(true)
    // 到顶：第 201 个新访客被拦
    expect(
      core.visitorMessage({ workspace: 'ws_x', session: 's201', visitor: 'v201', text: 'hi' }),
    ).toEqual({ status: 'offline', reason: 'quota_exhausted' })
    expect(events.some((e) => e.type === 'quota_full')).toBe(true)
    // 在途（窗口内刚说过话的 v200）：放行
    expect(
      core.visitorMessage({ workspace: 'ws_x', session: 's200', visitor: 'v200', text: '还在吗' }),
    ).toEqual({ status: 'forwarded' })
  })

  it('订阅生效后不受 200 限制（仍计数给报表）', () => {
    const { core } = makeCore({ conversationLimit: 200, isSubscribed: () => true })
    const peer = fakePeer()
    core.handshake(
      fakeSocket(peer.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'hosted',
        }),
      ) as never,
    )
    for (let i = 0; i < 250; i += 1) {
      expect(
        core.visitorMessage({ workspace: 'ws_x', session: `s${i}`, visitor: `v${i}`, text: 'hi' }),
      ).toEqual({ status: 'forwarded' })
    }
  })

  it('两头都在时托管实例赢（切档 = 换对面是谁，挂件不动）', () => {
    const { core } = makeCore()
    const server = fakePeer()
    const hosted = fakePeer()
    core.handshake(
      fakeSocket(server.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    core.handshake(
      fakeSocket(hosted.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'hosted',
        }),
      ) as never,
    )
    core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: 'hi' })
    expect(hosted.sent.some((f) => f.type === 'visit')).toBe(true)
    expect(server.sent.some((f) => f.type === 'visit')).toBe(false)
  })

  it('打字信号：访客布尔转发给对面；对面的布尔转给访客', () => {
    const { core } = makeCore()
    const peer = fakePeer()
    core.handshake(
      fakeSocket(peer.sent),
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing: 'prk_ok',
          peer: 'server',
        }),
      ) as never,
    )
    const pushed: unknown[] = []
    core.attachVisitor('ws_x', 's1', 'v1', { send: (f) => pushed.push(f), close: () => {} })
    core.visitorTyping('s1', true)
    expect(peer.sent).toContainEqual({ type: 'visitor_typing', session: 's1', active: true })
    core.onClientFrame('ws_x', { type: 'typing', session: 's1', active: true })
    expect(pushed).toContainEqual({ type: 'typing', active: true })
  })
})
