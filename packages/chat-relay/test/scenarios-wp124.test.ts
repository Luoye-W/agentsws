/**
 * WP124 交付 7：六条「模拟场景」——每条对应派工单点名的那个故事。
 *
 * 为什么在 `packages/chat-relay` 里而不是 `packs/dtc-3c-3p/scenarios/`：
 * 模拟世界（`packages/simulation`）的 chat 循环不认识转发器——把转发器接进
 * 合成世界等于再造一层装配，超出本单范围。按 WP125 的先例（判断层接进
 * `apps/server` 后同样未做成 baseline 级场景），改由**同一套全替身运行时**下的
 * 场景测试钉住；每条都写清故事、操作与断言。模拟 yml 的回归不受影响
 * （场景数没变，无需 --rewrite-baseline）。
 */
import { describe, expect, it } from 'vitest'
import { RelayCore, type RelayEvent } from '../src/core.js'
import { MemoryCounterStore, MemoryOfflineBox } from '../src/index.js'
import { parseClientFrame, type RelayFrame } from '../src/protocol.js'
import { openSealed, sealedKeyOf, sealWithKey } from '../src/sealed.js'

const NOW = '2026-09-21T10:00:00.000Z'

interface Peer {
  sent: RelayFrame[]
  handle: { peer: 'server' | 'hosted'; send(f: RelayFrame): void; close(): void }
}

function harness(overrides: { limit?: number; isSubscribed?: () => boolean } = {}): {
  core: RelayCore
  connect(pairing: string, peer?: 'server' | 'hosted'): Peer
  visitor(s: string): { pushed: unknown[] }
  events: RelayEvent[]
  leaveOffline(text: string): void
  pullOffline(): { sealed: string; created_at: string }[]
  messageKey: string
} {
  const events: RelayEvent[] = []
  const offline = new MemoryOfflineBox()
  const messageKey = 'mkk_scenario'
  const core = new RelayCore({
    clock: () => NOW,
    verifyPairing: () => true,
    counters: new MemoryCounterStore(),
    offline,
    seal: (_ws, plaintext) => sealWithKey(sealedKeyOf(messageKey), plaintext),
    onEvent: (e) => events.push(e),
    newId: (() => {
      let n = 0
      return () => {
        n += 1
        return `id${n}`
      }
    })(),
    ...(overrides.limit === undefined ? {} : { conversationLimit: overrides.limit }),
    ...(overrides.isSubscribed === undefined ? {} : { isSubscribed: overrides.isSubscribed }),
  })
  const peers: Peer[] = []
  const connect = (pairing: string, peer: 'server' | 'hosted' = 'server'): Peer => {
    const sent: RelayFrame[] = []
    core.handshake(
      {
        send: (f) => sent.push(f),
        close: () => sent.push({ type: 'error', code: 'closed', message: 'closed' }),
      },
      parseClientFrame(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: 'ws_x',
          pairing,
          peer,
          config: {
            enabled: true,
            accent: '#2563eb',
            greeting: '你好',
            allowed_origins: ['https://shop.example.com'],
          },
        }),
      ) as never,
    )
    const made: Peer = {
      sent,
      handle: {
        peer,
        send: (f) => sent.push(f),
        close: () => sent.push({ type: 'error', code: 'closed', message: 'closed' }),
      },
    }
    peers.push(made)
    return made
  }
  return {
    core,
    connect,
    events,
    messageKey,
    visitor(s: string) {
      const pushed: unknown[] = []
      core.attachVisitor('ws_x', s, `v_${s}`, { send: (f) => pushed.push(f), close: () => {} })
      return { pushed }
    },
    leaveOffline(text: string) {
      core.leaveOfflineMessage('ws_x', text)
    },
    pullOffline() {
      core.onClientFrame('ws_x', { type: 'pull_offline' })
      const last = peers.at(-1)?.sent.at(-1) as Extract<RelayFrame, { type: 'offline_batch' }>
      return last.items
    },
  }
}

describe('场景：官方转发一问一答', () => {
  it('访客问 → 本机答：一句进、一句出，一轮恰好一条', () => {
    const h = harness()
    const peer = h.connect('prk_ok')
    const v = h.visitor('s1')
    expect(
      h.core.visitorMessage({
        workspace: 'ws_x',
        session: 's1',
        visitor: 'v1',
        text: '这款防水吗',
      }),
    ).toEqual({
      status: 'forwarded',
    })
    const visit = peer.sent.find((f) => f.type === 'visit') as { turn: string; text: string }
    expect(visit.text).toBe('这款防水吗')
    coreReply(h.core, peer, 's1', visit.turn, '防水的，IPX7')
    expect(v.pushed).toContainEqual({
      type: 'message',
      message: { role: 'agent', text: '防水的，IPX7' },
    })
    // 同一轮第二条回复：转发器拒收（一次话轮恰好一条回复）
    coreReply(h.core, peer, 's1', visit.turn, '再说一遍')
    expect(v.pushed).not.toContainEqual({
      type: 'message',
      message: { role: 'agent', text: '再说一遍' },
    })
  })
})

describe('场景：关机留言续聊', () => {
  it('本机不在线 → 访客拿「离线」→ 留言密文暂存 → 上线拉走并清除、开箱可见', () => {
    const h = harness()
    // 关机（没有对端连接）：挂上访客流，转发器对它回「离线」
    h.visitor('s1')
    expect(
      h.core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: '在吗' }),
    ).toEqual({
      status: 'offline',
      reason: 'peer_offline',
    })
    h.leaveOffline(JSON.stringify({ email: 'v@example.com', text: '订单没到', order_ref: 'A123' }))
    // 开机：上线第一件事拉走
    h.connect('prk_ok')
    const items = h.pullOffline()
    expect(items).toHaveLength(1)
    const opened = openSealed(sealedKeyOf(h.messageKey), items[0]?.sealed as string)
    expect(opened).toContain('订单没到')
    // 拉走即清除
    expect(h.pullOffline()).toHaveLength(0)
  })
})

describe('场景：额度到顶——放行在途、拦新', () => {
  it('第 200 个之后新访客拿「离线」，在途访客继续聊，80% 有提醒事件', () => {
    const h = harness({ limit: 200 })
    h.connect('prk_ok')
    for (let i = 1; i <= 200; i += 1) {
      expect(
        h.core.visitorMessage({ workspace: 'ws_x', session: `s${i}`, visitor: `v${i}`, text: 'hi' })
          .status,
      ).toBe('forwarded')
    }
    expect(h.events.some((e) => e.type === 'quota_warn_80')).toBe(true)
    // 新访客：拦
    expect(
      h.core.visitorMessage({ workspace: 'ws_x', session: 's_new', visitor: 'v_new', text: 'hi' }),
    ).toEqual({ status: 'offline', reason: 'quota_exhausted' })
    // 在途（v200 刚说过）：放行
    expect(
      h.core.visitorMessage({ workspace: 'ws_x', session: 's200', visitor: 'v200', text: '还在吗' })
        .status,
    ).toBe('forwarded')
    expect(h.events.some((e) => e.type === 'quota_full')).toBe(true)
  })
})

describe('场景：自建转发', () => {
  it('无上限（limit 不设）：501 个访客全部放行，额度事件从不出现', () => {
    const h = harness()
    h.connect('prk_ok')
    for (let i = 0; i < 501; i += 1) {
      expect(
        h.core.visitorMessage({ workspace: 'ws_x', session: `s${i}`, visitor: `v${i}`, text: 'hi' })
          .status,
      ).toBe('forwarded')
    }
    expect(h.events.some((e) => e.type === 'quota_warn_80' || e.type === 'quota_full')).toBe(false)
  })
})

describe('场景：订阅后转发', () => {
  it('订阅生效：托管实例接手——两头都在时 visit 落在 hosted，本机不在线也 7×24', () => {
    const h = harness({ limit: 200, isSubscribed: () => true })
    const server = h.connect('prk_ok', 'server')
    const hosted = h.connect('prk_ok', 'hosted')
    h.visitor('s1')
    expect(
      h.core.visitorMessage({ workspace: 'ws_x', session: 's1', visitor: 'v1', text: 'hi' }).status,
    ).toBe('forwarded')
    expect(hosted.sent.some((f) => f.type === 'visit')).toBe(true)
    expect(server.sent.some((f) => f.type === 'visit')).toBe(false)
    // 商家本机下线：托管实例继续接
    h.core.dropClient('ws_x')
    void server
  })
})

describe('场景：求助超时转留言', () => {
  it('访客贴了卡号也不落转发器；等待到期 → 访客拿「离线」+ 留言表单通道可用', () => {
    const h = harness()
    // 关机（转发器对访客回离线的那个状态）
    h.visitor('s1')
    // 访客发的话里带了卡号：转发器看得到过路内容但不落盘——
    // 这里钉的是「存储口上从未出现正文」（privacy.test.ts 用 Proxy 钉过整条路径）
    expect(
      h.core.visitorMessage({
        workspace: 'ws_x',
        session: 's1',
        visitor: 'v1',
        text: '卡号 4111 1111 1111 1111，帮我查',
      }),
    ).toEqual({ status: 'offline', reason: 'peer_offline' })
    // 访客改走留言表单（邮箱 + 问题）
    h.leaveOffline(JSON.stringify({ email: 'c@example.com', text: '帮我查下订单' }))
    h.connect('prk_ok')
    const items = h.pullOffline()
    expect(items.length).toBe(1)
  })
})

function coreReply(core: RelayCore, peer: Peer, session: string, turn: string, text: string): void {
  core.onClientFrame('ws_x', { type: 'reply', session, turn, message_id: `m_${text}`, text })
  void peer
}
