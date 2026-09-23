/**
 * WP128：两类对端各占一格。
 *
 * 以前一个工作区只有一格，后连上的顶掉先连的——托管实例在跑、商家一开机，
 * 本机就把托管实例挤下线（与「两头都在时托管实例赢」正好相反）。现在两格并存：
 * 访客消息给托管那一格，没有才给本机；ping / 拉留言回给发帧的那一头。
 */
import { describe, expect, it } from 'vitest'
import { RelayCore } from '../src/core.js'
import { parseClientFrame, type RelayFrame, type RelayPeerKind } from '../src/protocol.js'

const NOW = '2026-09-23T10:00:00.000Z'

function makeCore(): RelayCore {
  let n = 0
  return new RelayCore({
    clock: () => NOW,
    verifyPairing: (ws, token) => ws === 'ws_x' && token === 'prk_ok',
    newId: () => {
      n += 1
      return `id${n}`
    },
  })
}

function connect(core: RelayCore, peer: RelayPeerKind): RelayFrame[] {
  const sent: RelayFrame[] = []
  const verdict = core.handshake(
    { send: (f) => sent.push(f), close: () => {} },
    parseClientFrame(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: 'ws_x',
        pairing: 'prk_ok',
        peer,
      }),
    ) as never,
  )
  expect(verdict.ok).toBe(true)
  return sent
}

const visits = (frames: RelayFrame[]): number => frames.filter((f) => f.type === 'visit').length

describe('RelayCore 两格对端（WP128）', () => {
  it('托管先连、本机后连：本机不把托管挤下线，访客消息仍给托管', () => {
    const core = makeCore()
    const hosted = connect(core, 'hosted')
    const server = connect(core, 'server')
    expect(core.peersOf('ws_x')).toEqual(['hosted', 'server'])
    expect(core.peerKindOf('ws_x')).toBe('hosted')
    core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: 'hi' })
    expect(visits(hosted)).toBe(1)
    expect(visits(server)).toBe(0)
    expect(core.stats().clients).toBe(2)
  })

  it('托管断开（取消订阅 / 停容器）→ 自动切回本机，挂件不动', () => {
    const core = makeCore()
    const hosted = connect(core, 'hosted')
    const server = connect(core, 'server')
    core.dropClient('ws_x', 'hosted')
    expect(core.peerKindOf('ws_x')).toBe('server')
    core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: 'hi' })
    expect(visits(server)).toBe(1)
    expect(visits(hosted)).toBe(0)
  })

  it('ping 的 pong 回给发 ping 的那一头（本机的心跳不被送到托管那边）', () => {
    const core = makeCore()
    const hosted = connect(core, 'hosted')
    const server = connect(core, 'server')
    core.onClientFrame('ws_x', { type: 'ping' }, 'server')
    expect(server.some((f) => f.type === 'pong')).toBe(true)
    expect(hosted.some((f) => f.type === 'pong')).toBe(false)
  })

  it('拉留言回给拉的那一头；没有对端就一条都不拿（不丢在半路）', () => {
    const core = makeCore()
    core.leaveOfflineMessage('ws_x', 'sealed-1')
    core.onClientFrame('ws_x', { type: 'pull_offline' })
    // 没人连着：留言还在
    const server = connect(core, 'server')
    connect(core, 'hosted')
    core.onClientFrame('ws_x', { type: 'pull_offline' }, 'server')
    const batch = server.find((f) => f.type === 'offline_batch') as
      | { type: 'offline_batch'; items: unknown[] }
      | undefined
    expect(batch?.items).toHaveLength(1)
  })

  it('不给 peer 的 dropClient 两格都摘（自建两档的老语义）', () => {
    const core = makeCore()
    connect(core, 'hosted')
    connect(core, 'server')
    core.dropClient('ws_x')
    expect(core.peersOf('ws_x')).toEqual([])
    expect(core.stats().clients).toBe(0)
  })
})
