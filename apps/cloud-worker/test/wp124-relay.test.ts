/**
 * WP124：官方托管的聊天转发器（`ChatRelayDO`）的测试。
 *
 * 全替身：DO 存储用 `FakeDoStorage`（better-sqlite3 假的 storage.sql），
 * WebSocket 用一对可驱动的假 socket，网络一概不碰。
 */

import { createHash } from 'node:crypto'
import { openSealed } from '@agentsws/chat-relay'
import type { VerifiedCloudToken } from '@agentsws/contracts'
import type { SubscriptionWallet } from '@agentsws/kol-cloud'
import { describe, expect, it } from 'vitest'
import {
  ChatRelayDoCore,
  type RelayDoStateLike,
  type RelayWebSocket,
} from '../src/chat-relay-do.js'
import type { WorkerEnv } from '../src/env.js'
import { withInternalHeaders } from '../src/internal.js'
import { FakeDoStorage } from './helpers.js'

const WS = 'ws_relay_test'
const NOW = '2026-09-21T10:00:00.000Z'
const ORIGIN = 'https://shop.example.com'
/** WP137：访客令牌种子显式注入（≥ 32 字节；生产走 `AGENTSWS_CHAT_RELAY_KEY`，没有兜底）。 */
const TEST_VISITOR_SEED = 'wp124-test-visitor-seed-0123456789abcdef'

const principal: VerifiedCloudToken = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: WS,
  scopes: ['kol'],
}

/**
 * 一对可驱动的假 WS（生产是 workerd 的 WebSocketPair）。
 *
 * 方向语义与真 socket 一致：`send` = 这一侧发出去（记进 `inbox` 供测试读，
 * 同时递给对面的 message handler）；`emit` = 对面发进来的那一帧。
 */
class FakeWSSide implements RelayWebSocket {
  readonly inbox: { data: unknown }[] = []
  handlers: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  peer: FakeWSSide | undefined

  send(text: string): void {
    this.inbox.push({ data: text })
    this.peer?.receive(text)
  }
  close(): void {
    this.handlers.close?.()
  }
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
  addEventListener(type: 'message' | 'close', handler: (event?: { data: unknown }) => void): void {
    if (type === 'message') this.handlers.message = handler as (e: { data: unknown }) => void
    else this.handlers.close = handler as () => void
  }
  /** 测试驱动：从对端发一帧进来。 */
  emit(text: string): void {
    this.receive(text)
  }
  receive(text: string): void {
    this.handlers.message?.({ data: text })
  }
  static linked(): { client: FakeWSSide; server: FakeWSSide } {
    const client = new FakeWSSide()
    const server = new FakeWSSide()
    client.peer = server
    server.peer = client
    return { client, server }
  }
}

interface Harness {
  core: ChatRelayDoCore
  storage: FakeDoStorage
  pair(): { client: FakeWSSide; server: FakeWSSide }
  issuePairing(): Promise<{ pairing_token: string; message_key: string }>
  /** 连一台带白名单的「商家本机」，返回服务器侧 socket。 */
  connectPeer(pairing: string): Promise<FakeWSSide>
  status(): Promise<Record<string, unknown> & { notifications: { type: string }[] }>
  visitorSession(): Promise<{ session_id: string; visitor_token: string }>
  sendMessage(
    session: { session_id: string; visitor_token: string },
    text: string,
  ): Promise<Response>
}

function makeCore(over: { wallet?: SubscriptionWallet } = {}): Harness {
  const storage = new FakeDoStorage()
  let lastPair: { client: FakeWSSide; server: FakeWSSide } | undefined
  const state = {
    storage,
    acceptWebSocket: () => {},
    serializeAttachment: () => {},
  } as unknown as RelayDoStateLike
  const core = new ChatRelayDoCore(state, {} as WorkerEnv, {
    clock: () => NOW,
    visitorSeed: TEST_VISITOR_SEED,
    sessionRate: { per_minute: 10_000, per_hour: 10_000 },
    ...(over.wallet === undefined ? {} : { wallet: over.wallet }),
    makeSocketPair: () => {
      lastPair = FakeWSSide.linked()
      return lastPair
    },
  })
  const relayUrl = (path: string): string => `https://do/relay/${WS}${path}`

  return {
    core,
    storage,
    pair: () => lastPair as { client: FakeWSSide; server: FakeWSSide },
    issuePairing: async () => {
      const res = await core.fetch(
        withInternalHeaders(new Request('https://do/__internal/pairing', { method: 'POST' }), {
          principal,
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { pairing_token: string; message_key: string } }
      return body.data
    },
    connectPeer: async (pairing) => {
      await core.fetch(new Request(relayUrl('/connect'), { headers: { upgrade: 'websocket' } }))
      const server = (lastPair as { client: FakeWSSide; server: FakeWSSide }).server
      server.emit(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          workspace: WS,
          pairing,
          peer: 'server',
          config: {
            enabled: true,
            accent: '#2563eb',
            greeting: '你好',
            allowed_origins: [ORIGIN],
          },
        }),
      )
      return server
    },
    status: async () => {
      const res = await core.fetch(
        withInternalHeaders(new Request('https://do/__internal/status'), { principal }),
      )
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: Record<string, unknown> }).data as never
    },
    visitorSession: async () => {
      const res = await core.fetch(
        new Request(relayUrl('/v1/chat/public/sessions'), {
          method: 'POST',
          headers: { origin: ORIGIN },
        }),
      )
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: { session_id: string; visitor_token: string } }).data
    },
    sendMessage: async (session, text) =>
      core.fetch(
        new Request(relayUrl(`/v1/chat/public/sessions/${session.session_id}/messages`), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            authorization: `Bearer ${session.visitor_token}`,
          },
          body: JSON.stringify({ text }),
        }),
      ),
  }
}

const internalRequest = (path: string, method = 'GET'): Request =>
  withInternalHeaders(new Request(`https://do/__internal/${path}`, { method }), { principal })

describe('ChatRelayDO · 客服增值服务（订阅 → 托管实例接手）', () => {
  const okWallet = (): SubscriptionWallet => ({
    async charge() {
      return { ok: true, credits: 30 }
    },
  })
  const brokeWallet = (): SubscriptionWallet => ({
    async charge() {
      return { ok: false, reason: '余额不足' }
    },
  })

  it('开通：当场扣第一期，状态 active，转发器解除 200 上限', async () => {
    const mk = makeCore({ wallet: okWallet() })
    const { pairing_token } = await mk.issuePairing()
    await mk.connectPeer(pairing_token)
    const sub = await mk.core.fetch(internalRequest('support-subscription', 'POST'))
    const { data } = (await sub.json()) as { data: { status: string; charged: unknown[] } }
    expect(data.status).toBe('active')
    expect(data.charged.length).toBe(1)
    // 250 个访客全部放行
    for (let i = 0; i < 250; i += 1) {
      const session = await mk.visitorSession()
      const res = await mk.sendMessage(session, 'hi')
      expect([200, 202]).toContain(res.status)
    }
  })

  it('扣不上：进宽限（服务暂停、数据不动），转发器不解除上限', async () => {
    const mk = makeCore({ wallet: brokeWallet() })
    await mk.issuePairing()
    await mk.connectPeer('whatever-wrong-key')
    const sub = await mk.core.fetch(internalRequest('support-subscription', 'POST'))
    const { data } = (await sub.json()) as { data: { status: string } }
    expect(data.status).toBe('grace')
    // 上限仍在：一个填白名单失败的白名单 → 开会话 403 也说明转发器还在原样工作
    const status = (await mk.status()) as unknown as { subscribed: boolean }
    expect(status.subscribed).toBe(false)
  })

  it('取消：当期用完为止（cancelling 仍生效），到期后 alarm 收走标志', async () => {
    const mk = makeCore({ wallet: okWallet() })
    await mk.issuePairing()
    await mk.core.fetch(internalRequest('support-subscription', 'POST'))
    const cancel = await mk.core.fetch(internalRequest('support-subscription', 'DELETE'))
    const { data } = (await cancel.json()) as { data: { status: string } }
    expect(data.status).toBe('cancelling')
    const status = (await mk.status()) as unknown as { subscribed: boolean }
    expect(status.subscribed).toBe(true)
  })

  it('WP128：商家本机那把配对冒充不了托管（peer=hosted 要另一把，见 wp128-hosted.test.ts）', async () => {
    const mk = makeCore({ wallet: okWallet() })
    const { pairing_token } = await mk.issuePairing()
    await mk.core.fetch(internalRequest('support-subscription', 'POST'))
    await mk.core.fetch(
      new Request(`https://do/relay/${WS}/connect`, { headers: { upgrade: 'websocket' } }),
    )
    mk.pair().server.emit(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: WS,
        pairing: pairing_token,
        peer: 'hosted',
      }),
    )
    const frames = mk
      .pair()
      .server.inbox.map((e) => JSON.parse(String(e.data)) as Record<string, unknown>)
    expect(frames.some((f) => f.type === 'hello_err' && f.reason === 'bad_pairing')).toBe(true)
  })
})

describe('ChatRelayDO · 配对', () => {
  it('首次签发返回密钥一次；第二次 409（重发等于再泄露一遍）', async () => {
    const mk = makeCore()
    const first = await mk.issuePairing()
    expect(first.pairing_token).toMatch(/^prk_/)
    expect(first.message_key).toMatch(/^mkk_/)
    const again = await mk.core.fetch(internalRequest('pairing', 'POST'))
    expect(again.status).toBe(409)
  })

  it('没有 principal 的内部路由进不来', async () => {
    const { core } = makeCore()
    const res = await core.fetch(new Request('https://do/__internal/pairing', { method: 'POST' }))
    expect(res.status).toBe(401)
  })
})

describe('ChatRelayDO · 转发全流程（访客 ↔ 商家本机）', () => {
  it('握手 → 访客消息转发（带 turn）→ 回复原路 → 同一轮第二条回复被拒', async () => {
    const mk = makeCore()
    const { pairing_token } = await mk.issuePairing()
    const server = await mk.connectPeer(pairing_token)

    const session = await mk.visitorSession()
    const sent = await mk.sendMessage(session, '这款防水吗')
    expect([200, 202]).toContain(sent.status)

    const frames = server.inbox.map((e) => JSON.parse(String(e.data)) as Record<string, unknown>)
    const visit = frames.find((f) => f.type === 'visit')
    expect(visit).toMatchObject({ text: '这款防水吗' })
    const turn = visit?.turn as string

    // 回复原路回去：访客流里应出现那条回复（SSE 流直接读）
    const stream = await mk.core.fetch(
      new Request(`https://do/relay/${WS}/v1/chat/public/sessions/${session.session_id}/stream`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${session.visitor_token}` },
      }),
    )
    expect(stream.status).toBe(200)
    server.emit(
      JSON.stringify({
        type: 'reply',
        session: session.session_id,
        turn,
        message_id: 'm1',
        text: '防水的',
      }),
    )
    const reader = (stream.body as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (let i = 0; i < 5 && !text.includes('防水的'); i += 1) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value as Uint8Array)
    }
    expect(text).toContain('防水的')

    // 同一轮第二条回复：丢弃 + 错误帧
    server.emit(
      JSON.stringify({
        type: 'reply',
        session: session.session_id,
        turn,
        message_id: 'm2',
        text: '再说一遍',
      }),
    )
    const errorFrames = server.inbox
      .map((e) => JSON.parse(String(e.data)) as Record<string, unknown>)
      .filter((f) => f.type === 'error')
    expect(errorFrames.some((f) => f.code === 'turn_already_answered')).toBe(true)
  })

  it('白名单空 = 全拒：陌生 Origin 开会话 403（请求体里没有 origin 字段可改）', async () => {
    const mk = makeCore()
    await mk.issuePairing()
    await mk.connectPeer('prk_wrong_but_whitelist_comes_from_hello')
    // 连的是对端，但握手密钥错了 → 外观没存进来 → 白名单空 → 403
    const open = await mk.core.fetch(
      new Request(`https://do/relay/${WS}/v1/chat/public/sessions`, {
        method: 'POST',
        headers: { origin: ORIGIN },
      }),
    )
    expect(open.status).toBe(403)
  })

  it('hello 里的工作区与路径不一致：握手直接拒', async () => {
    const mk = makeCore()
    const { pairing_token } = await mk.issuePairing()
    await mk.core.fetch(
      new Request(`https://do/relay/${WS}/connect`, { headers: { upgrade: 'websocket' } }),
    )
    const server = mk.pair().server
    server.emit(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        workspace: 'ws_other',
        pairing: pairing_token,
        peer: 'server',
      }),
    )
    const frames = server.inbox.map((e) => JSON.parse(String(e.data)) as Record<string, unknown>)
    expect(frames[0]).toMatchObject({ type: 'hello_err', reason: 'bad_pairing' })
  })
})

describe('ChatRelayDO · 离线留言', () => {
  it('留言以密文入箱；拉走即清除；用签发的留言密钥能开箱', async () => {
    const mk = makeCore()
    const { message_key, pairing_token } = await mk.issuePairing()
    await mk.connectPeer(pairing_token)
    const leave = await mk.core.fetch(
      new Request(`https://do/relay/${WS}/v1/chat/public/offline-messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'v@example.com', text: '订单没到', order_ref: 'A123' }),
      }),
    )
    expect(leave.status).toBe(200)

    const pull = await mk.core.fetch(internalRequest('offline-messages', 'POST'))
    const { data } = (await pull.json()) as { data: { items: { sealed: string }[] } }
    expect(data.items.length).toBe(1)
    const sealed = data.items[0]?.sealed as string
    // 箱里不是明文
    expect(sealed).not.toContain('订单没到')
    // 本机用签发的留言密钥能开箱
    const key = createHash('sha256').update(`chat-relay:${message_key}`).digest()
    expect(openSealed(key, sealed)).toContain('订单没到')
    // 拉走即清除
    const second = await mk.core.fetch(internalRequest('offline-messages', 'POST'))
    const { data: empty } = (await second.json()) as { data: { items: unknown[] } }
    expect(empty.items.length).toBe(0)
  })

  it('alarm 把超期 7 天的留言扫掉', async () => {
    const mk = makeCore()
    const { pairing_token } = await mk.issuePairing()
    await mk.connectPeer(pairing_token)
    const leave = await mk.core.fetch(
      new Request(`https://do/relay/${WS}/v1/chat/public/offline-messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'v@example.com', text: '太旧了' }),
      }),
    )
    expect(leave.status).toBe(200)
    // 把 created_at 改到 8 天前（直接动 kv 表）
    const db = mk.storage.db
    const row = db.prepare("SELECT k, v FROM relay_kv WHERE k LIKE 'offline:%'").get() as {
      k: string
      v: string
    }
    const old = new Date(Date.parse(NOW) - 8 * 24 * 3600 * 1000).toISOString()
    db.prepare('UPDATE relay_kv SET v = ? WHERE k = ?').run(
      JSON.stringify({ ...JSON.parse(row.v), created_at: old }),
      row.k,
    )
    await mk.core.alarm()
    const pull = await mk.core.fetch(internalRequest('offline-messages', 'POST'))
    const { data } = (await pull.json()) as { data: { items: unknown[] } }
    expect(data.items.length).toBe(0)
  })
})

describe('ChatRelayDO · 状态与提醒', () => {
  it('status 回本月计数 / 上限 / 对端在线；80% 提醒落成站内提醒行', async () => {
    const mk = makeCore()
    const { pairing_token } = await mk.issuePairing()
    await mk.connectPeer(pairing_token)

    for (let i = 0; i < 160; i += 1) {
      const session = await mk.visitorSession()
      await mk.sendMessage(session, 'hi')
    }
    const data = (await mk.status()) as unknown as {
      conversations_this_month: number
      limit: number
      peer_online: boolean
      peer_kind: string
      notifications: { type: string; message_zh: string }[]
    }
    expect(data.conversations_this_month).toBe(160)
    expect(data.limit).toBe(200)
    expect(data.peer_online).toBe(true)
    expect(data.peer_kind).toBe('server')
    expect(data.notifications.map((n) => n.type)).toContain('quota_warn_80')
    expect(data.notifications.find((n) => n.type === 'quota_warn_80')?.message_zh).toContain('80%')
  })

  it('订阅生效后 status 标出 subscribed；计数继续但不受限（直接在 core 上注入）', async () => {
    const mk = makeCore()
    const { pairing_token } = await mk.issuePairing()
    await mk.connectPeer(pairing_token)
    // 订阅路由（交付5）写进来的标志；这里直接放 kv 验证转发器读它
    const db = mk.storage.db
    db.prepare(
      'INSERT INTO relay_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    ).run(`sub:${WS}`, 'active')
    const data = (await mk.status()) as unknown as { subscribed: boolean }
    expect(data.subscribed).toBe(true)
    // 250 个访客：全部放行
    for (let i = 0; i < 250; i += 1) {
      const session = await mk.visitorSession()
      const res = await mk.sendMessage(session, 'hi')
      expect([200, 202]).toContain(res.status)
    }
  })
})
