/**
 * WP124：本机 ↔ 转发器客户端的真链路测试。
 *
 * 跑的是真车道（真适配器 → 真入站管线 → 真审批总线，模型是桩），
 * 只有 WebSocket 是替身——不联网。
 */

import { MemoryRawStore } from '@agentsws/channels'
import { sealedKeyOf, sealWithKey } from '@agentsws/chat-relay'
import type { ApprovalItem, Clock, CreateApprovalInput } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { createWork } from '@agentsws/work'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChatLane, createChatLane } from '../src/chat.js'
import {
  ChatRelayClient,
  type RelayClientSocket,
  relayConnectUrl,
} from '../src/chat-relay-client.js'
import type { ChatWidgetAssembly } from '../src/chat-widget.js'

const WS = 'ws_1'
const T0 = '2026-09-14T10:00:00.000Z'
const ENDPOINT = 'https://relay.example.com/relay/ws_1'

class StepClock implements Clock {
  private ms = Date.parse(T0)
  now(): string {
    return new Date(this.ms).toISOString()
  }
  async sleep(): Promise<void> {
    return undefined
  }
  advance(ms: number): void {
    this.ms += ms
  }
}

class RecordingApprovals {
  readonly items: ApprovalItem[] = []
  async create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>> {
    const item = {
      ...input,
      id: `ai_${this.items.length + 1}`,
      state: 'pending',
      created_at: T0,
      updated_at: T0,
      revision: 1,
      deliveries: [],
      links: { children: [] },
    } as unknown as ApprovalItem<P>
    this.items.push(item as ApprovalItem)
    return item
  }
}

function stubModels(text: string): { api: ModelGatewayApi } {
  const api = {
    async complete() {
      return {
        text,
        usage: { input_tokens: 10, output_tokens: 10, cached_tokens: 0, cost_base: 1 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: 'h',
      }
    },
  } as unknown as ModelGatewayApi
  return { api }
}

/** 一条可驱动的假客户端 socket（替身的不只是 socket，还有"转发器"那一侧的行为）。 */
class FakeSocket implements RelayClientSocket {
  static made: FakeSocket[] = []
  readonly outbox: string[] = []
  private handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {}

  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(text: string): void {
    this.outbox.push(text)
  }
  close(): void {
    this.handlers.close?.()
  }
  addEventListener(type: string, handler: (...args: unknown[]) => void): void {
    this.handlers[type] = handler
  }
  /* 测试驱动 */
  open(): void {
    this.handlers.open?.()
  }
  /** 转发器发来一帧。 */
  serverSend(frame: unknown): void {
    this.handlers.message?.({ data: JSON.stringify(frame) })
  }
}

function rig(replyText = 'Shipping to the US is free over $50.'): {
  clock: StepClock
  chat: ChatLane
  offline: { email: string; text: string; order_ref?: string; left_at: string }[]
  sockets: () => FakeSocket[]
  makeClient: (over?: { pairing?: string; messageKey?: string }) => ChatRelayClient
} {
  const clock = new StepClock()
  const approvals = new RecordingApprovals()
  const models = stubModels(replyText)
  const chat = createChatLane({
    clock,
    workspace_id: WS,
    appendEvent: () => {},
    halt: new MemoryHalt(),
    raw: new MemoryRawStore({ clock }),
    work: createWork({ workspace_id: WS, clock, random: () => 0.5, tz_offset_minutes: 0 }),
    approvals,
    models: models.api,
    searchKnowledge: async () => [],
    position: () => ({ person_id: 'p_wang', assignment_id: 'as_1', role_id: 'dtc.live-chat' }),
    // 真访客那一路靠静默窗口的定时器推进；测试里在定时器里推进合成时钟
    //（StepClock 不走，2s 窗口永远等不满——时钟与定时器必须一起动）
    schedule_turn: (_sid, delay_ms, run) => {
      clock.advance(Math.max(delay_ms, 2000))
      const t = setTimeout(run, 1)
      t.unref?.()
    },
  })
  const widget = {
    config: () => ({
      allowed_origins: ['https://shop.example.com'],
      accent: '#2563eb',
      greeting: '你好',
    }),
  } as unknown as ChatWidgetAssembly
  const offline: { email: string; text: string; order_ref?: string; left_at: string }[] = []
  let pairing: string | undefined = 'prk_test'
  let messageKey: string | undefined = 'mkk_test'
  const makeClient = (over: { pairing?: string; messageKey?: string } = {}): ChatRelayClient => {
    if (over.pairing !== undefined) pairing = over.pairing
    if (over.messageKey !== undefined) messageKey = over.messageKey
    const client = new ChatRelayClient({
      clock,
      workspace_id: WS,
      lane: chat,
      widget,
      endpoint: () => ENDPOINT,
      pairingToken: () => pairing,
      messageKey: () => messageKey,
      socketFactory: (url) => new FakeSocket(url),
      onOfflineMessage: (m) => {
        offline.push(m)
      },
    })
    return client
  }
  return { clock, chat, offline, sockets: () => FakeSocket.made, makeClient }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('转发器连接地址', () => {
  it('https + /relay/<ws> → wss + /connect；不带 /relay 的地址拒', () => {
    expect(relayConnectUrl('https://relay.example.com/relay/ws_1')).toEqual({
      url: 'wss://relay.example.com/relay/ws_1/connect',
      workspace: 'ws_1',
    })
    expect(relayConnectUrl('http://10.0.0.5:8787/relay/ws_x/')).toEqual({
      url: 'ws://10.0.0.5:8787/relay/ws_x/connect',
      workspace: 'ws_x',
    })
    expect(relayConnectUrl('https://relay.example.com/other')).toBeUndefined()
    expect(relayConnectUrl('not a url')).toBeUndefined()
  })
})

describe('本机客户端（真车道 + 假 socket）', () => {
  it('握手帧带协议版本 / 工作区 / 挂件外观；hello_ok 后拉离线留言', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    const hello = JSON.parse(socket.outbox[0] as string) as Record<string, unknown>
    expect(hello).toMatchObject({
      type: 'hello',
      protocol_version: 1,
      workspace: WS,
      pairing: 'prk_test',
      peer: 'server',
    })
    expect((hello.config as Record<string, unknown>).allowed_origins).toEqual([
      'https://shop.example.com',
    ])

    socket.serverSend({
      type: 'hello_ok',
      protocol_version: 1,
      heartbeat_ms: 15000,
      peer: 'server',
    })
    expect(client.state()).toBe('online')
    // 上线第一件事：拉离线留言
    expect(socket.outbox.some((t) => t.includes('pull_offline'))).toBe(true)
    client.stop()
  })

  it('访客消息喂真车道，AI 回复原路回为 reply（带转发器的 turn）', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    socket.serverSend({
      type: 'hello_ok',
      protocol_version: 1,
      heartbeat_ms: 15000,
      peer: 'server',
    })

    socket.serverSend({
      type: 'visit',
      session: 's_relay_1',
      turn: 't_1',
      visitor_id: 'v1',
      display: '网站访客',
      text: 'Do you ship to the US?',
      page: { host: 'shop.example.com', path: '/products/x' },
    })
    // lane.receive 在 visit 处理里被 await——回复在下一个 tick 内出站
    await vi.waitFor(() => {
      const reply = socket.outbox
        .map((t) => JSON.parse(t) as Record<string, unknown>)
        .find((f) => f.type === 'reply')
      expect(reply).toMatchObject({
        session: 's_relay_1',
        turn: 't_1',
        text: 'Shipping to the US is free over $50.',
      })
    })
    // 本机车道里真建了会话（确定性 external id：重启后能找回同一条）
    const sessions = await rigData.chat.sessions({})
    expect(sessions.some((s) => s.external_session_id === 'relay:s_relay_1')).toBe(true)
    client.stop()
  })

  it('话轮之外的 agent 插话走 note（话轮账本不重复记账）', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    socket.serverSend({
      type: 'hello_ok',
      protocol_version: 1,
      heartbeat_ms: 15000,
      peer: 'server',
    })
    socket.serverSend({ type: 'visit', session: 's2', turn: 't_9', visitor_id: 'v2', text: 'hi' })
    await vi.waitFor(() => {
      expect(socket.outbox.some((t) => t.includes('"reply"'))).toBe(true)
    })
    // 话轮已销账：再来一条 agent 帧（比如教 AI 的改写）必须走 note
    const sessions = await rigData.chat.sessions({})
    const laneSession = sessions.find((s) => s.external_session_id === 'relay:s2') as { id: string }
    rigData.chat.stream.publish(laneSession.id, {
      type: 'message',
      message: {
        id: 'cm_note',
        session_id: laneSession.id,
        workspace_id: WS,
        role: 'agent',
        text: 'We can offer a replacement.',
        at: T0,
        external_id: 'n1',
      },
    })
    expect(
      socket.outbox.some((t) => {
        const f = JSON.parse(t) as Record<string, unknown>
        return f.type === 'note' && f.text === 'We can offer a replacement.'
      }),
    ).toBe(true)
    client.stop()
  })

  it('operator 帧（商家教 AI 的中文原话）永不出站', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    socket.serverSend({
      type: 'hello_ok',
      protocol_version: 1,
      heartbeat_ms: 15000,
      peer: 'server',
    })
    socket.serverSend({ type: 'visit', session: 's3', turn: 't_10', visitor_id: 'v3', text: 'hi' })
    await vi.waitFor(() => {
      expect(socket.outbox.some((t) => t.includes('"reply"'))).toBe(true)
    })
    const sessions = await rigData.chat.sessions({})
    const laneSession = sessions.find((s) => s.external_session_id === 'relay:s3') as { id: string }
    rigData.chat.stream.publish(laneSession.id, {
      type: 'message',
      message: {
        id: 'cm_op',
        session_id: laneSession.id,
        workspace_id: WS,
        role: 'operator',
        text: '按 14 天窗口跟他说', // 商家中文原话：一个字都不许到访客屏幕上
        at: T0,
        external_id: 'o1',
      },
    })
    expect(socket.outbox.some((t) => t.includes('按 14 天窗口'))).toBe(false)
    client.stop()
  })

  it('离线留言开箱：用签发的留言密钥能打开，明文交宿主', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    socket.serverSend({
      type: 'hello_ok',
      protocol_version: 1,
      heartbeat_ms: 15000,
      peer: 'server',
    })
    const key = sealedKeyOf('mkk_test')
    const sealed = sealWithKey(key, JSON.stringify({ email: 'v@example.com', text: '订单没到' }))
    socket.serverSend({
      type: 'offline_batch',
      items: [{ id: 'om1', sealed, created_at: T0 }],
    })
    await vi.waitFor(() => {
      expect(rigData.offline).toEqual([{ email: 'v@example.com', text: '订单没到', left_at: T0 }])
    })
    client.stop()
  })

  it('密钥错：停下来，不重试（重试只会把对端刷屏）', () => {
    const rigData = rig()
    const client = rigData.makeClient({ pairing: 'prk_wrong' })
    client.start()
    const socket = rigData.sockets().at(-1) as FakeSocket
    socket.open()
    socket.serverSend({
      type: 'hello_err',
      reason: 'bad_pairing',
      supported_versions: [1],
    })
    expect(client.state()).toBe('stopped')
    client.stop()
  })

  it('断线：指数退避后重连（新 socket 被造出来）', async () => {
    const rigData = rig()
    const client = rigData.makeClient()
    client.start()
    const first = rigData.sockets().at(-1) as FakeSocket
    first.open()
    first.close()
    expect(client.state()).toBe('backoff')
    // 退避是指数的、带抖动；测试里等它真的重连（上限 60ms 内）
    await vi.waitFor(
      () => {
        expect(rigData.sockets().length).toBeGreaterThan(1)
        expect(client.state()).toBe('connecting')
      },
      { timeout: 4000 },
    )
    client.stop()
  })
})
