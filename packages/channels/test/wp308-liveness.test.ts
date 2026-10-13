/**
 * WP308（决策 451）：钉钉 / 企业微信补齐 WP306 给飞书做的——判死与重连、状态变化报给宿主、
 * 先回「收到」再回答案（钉钉：同一个 sessionWebhook 多发；企业微信：流式回复先开后刷）。
 *
 * 长连接都是内存替身，一行网都不出。
 */
import { describe, expect, it } from 'vitest'
import {
  DingtalkBotAdapter,
  type DingtalkConnState,
  type DingtalkHttp,
  type DingtalkSocket,
  TOPIC_ROBOT,
} from '../src/dingtalk-bot/index.js'
import { MemoryRawStore } from '../src/raw-store.js'
import {
  CMD_EVENT_CALLBACK,
  CMD_MSG_CALLBACK,
  CMD_RESPOND_MSG,
  CMD_SUBSCRIBE,
  WecomBotAdapter,
  type WecomConnState,
  type WecomSocket,
} from '../src/wecom-bot/index.js'
import { FakeClock, waitFor } from './helpers.js'

const WS = 'ws_1'

/** 两边共用的替身：记发出去的帧；`terminate` 不发 close（模拟「假活」那头根本没反应）。 */
class Fake implements WecomSocket, DingtalkSocket {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  terminated = false
  pings = 0
  /** 收到 ping 就回 pong / 心跳回包（「活着」的那种）。 */
  answer = false
  #h: Record<string, ((a: never) => void)[]> = {}
  constructor(readonly kind: 'wecom' | 'dingtalk') {}
  send(data: string): void {
    const f = JSON.parse(data) as Record<string, unknown>
    this.sent.push(f)
    if (this.kind === 'wecom' && f.cmd === 'ping' && this.answer)
      queueMicrotask(() => {
        // 文档：心跳回包没有 cmd，只有同一个 req_id 与 errcode 0
        this.emit('message', JSON.stringify({ headers: f.headers, errcode: 0, errmsg: 'ok' }))
      })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }
  terminate(): void {
    this.terminated = true
  }
  ping(): void {
    this.pings += 1
    if (this.answer) queueMicrotask(() => this.emit('pong', undefined))
  }
  on(event: string, cb: (a: never) => void): void {
    this.#h[event] = [...(this.#h[event] ?? []), cb]
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.#h[event] ?? []) (cb as (a: unknown) => void)(arg)
  }
}

/* ── 企业微信 ──────────────────────────────────────────────────── */

function wecomRig(over: Partial<ConstructorParameters<typeof WecomBotAdapter>[0]> = {}) {
  const clock = new FakeClock()
  const sockets: Fake[] = []
  const states: [WecomConnState, WecomConnState][] = []
  let n = 0
  const adapter = new WecomBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: WS,
    credentials: () => ({ bot_id: 'BOT', secret: 'S' }),
    socket: () => {
      const s = new Fake('wecom')
      sockets.push(s)
      return s
    },
    newId: () => `req_${++n}`,
    backoff_ms: [1],
    on_state: (s, p) => states.push([s, p]),
    on_error: () => {},
    ...over,
  })
  const last = () => sockets[sockets.length - 1] as Fake
  const up = () => {
    last().emit('open', undefined)
    last().emit('message', JSON.stringify({ cmd: CMD_SUBSCRIBE, errcode: 0 }))
  }
  return { adapter, sockets, states, last, up, clock }
}

describe('企业微信：判死与重连（WP308）', () => {
  it('心跳发出去一帧都不回 → 判死、掐掉、按退避重连，状态报「在重连」再报「已连接」', async () => {
    const r = wecomRig({ heartbeat_ms: 10 })
    await r.adapter.start(async () => {})
    r.up()
    expect(r.adapter.state).toBe('connected')
    await waitFor(() => r.sockets.length === 2, '判死后重连')
    expect(r.sockets[0]?.terminated).toBe(true)
    expect(r.adapter.state).toBe('reconnecting')
    r.up()
    expect(r.adapter.connected).toBe(true)
    expect(r.states).toEqual([
      ['connecting', 'idle'],
      ['connected', 'connecting'],
      ['reconnecting', 'connected'],
      ['connected', 'reconnecting'],
    ])
    // 被掐掉的旧连接后来才 close：不再触发一次重连
    r.sockets[0]?.close()
    await new Promise((res) => setTimeout(res, 20))
    expect(r.sockets.length).toBe(2)
    await r.adapter.stop()
  })

  it('心跳有回包就一直活着（回包没有 cmd 也算）', async () => {
    const r = wecomRig({ heartbeat_ms: 5 })
    await r.adapter.start(async () => {})
    r.last().answer = true
    r.up()
    await new Promise((res) => setTimeout(res, 60))
    expect(r.sockets.length).toBe(1)
    expect(r.last().sent.filter((f) => f.cmd === 'ping').length).toBeGreaterThan(3)
    await r.adapter.stop()
  })

  it('握手卡住（连上了但订阅一直不回）→ 掐掉重连', async () => {
    const r = wecomRig({ handshake_timeout_ms: 10 })
    await r.adapter.start(async () => {})
    r.last().emit('open', undefined)
    await waitFor(() => r.sockets.length === 2, '握手超时重连')
    expect(r.sockets[0]?.terminated).toBe(true)
    await r.adapter.stop()
  })

  it('被别处的新连接顶掉（disconnected_event）：不再自动重连，说一句为什么', async () => {
    const r = wecomRig()
    await r.adapter.start(async () => {})
    r.up()
    r.last().emit(
      'message',
      JSON.stringify({
        cmd: CMD_EVENT_CALLBACK,
        headers: { req_id: 'e1' },
        body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } },
      }),
    )
    expect(r.adapter.state).toBe('failed')
    expect(r.adapter.lastError).toContain('别的地方连上了')
    r.last().close()
    await new Promise((res) => setTimeout(res, 20))
    expect(r.sockets.length).toBe(1)
  })

  it('人点断开不报状态变化', async () => {
    const r = wecomRig()
    await r.adapter.start(async () => {})
    r.up()
    const before = r.states.length
    await r.adapter.stop()
    expect(r.states.length).toBe(before)
  })
})

describe('企业微信：先回「收到」再回答案（流式回复）', () => {
  it('keep → 开一条流（finish=false）；答案刷同一条流（finish=true）；同一个 req_id', async () => {
    const r = wecomRig()
    await r.adapter.start(async () => {})
    r.up()
    r.last().emit(
      'message',
      JSON.stringify({
        cmd: CMD_MSG_CALLBACK,
        headers: { req_id: 'req-in' },
        body: {
          msgid: 'm1',
          chatid: 'c1',
          chattype: 'single',
          from: { userid: 'u' },
          msgtype: 'text',
          text: { content: '在吗' },
        },
      }),
    )
    await waitFor(() => r.adapter.pending === 1, '收到')
    expect(await r.adapter.reply('wecom:m1', '收到，我查一下。', { keep: true })).toEqual({
      sent: true,
    })
    expect(r.adapter.pending).toBe(1)
    expect(await r.adapter.reply('wecom:m1', '答案')).toEqual({ sent: true })
    expect(r.adapter.pending).toBe(0)
    const frames = r.last().sent.filter((f) => f.cmd === CMD_RESPOND_MSG)
    expect(frames).toHaveLength(2)
    const [a, b] = frames as {
      headers: { req_id: string }
      body: { msgtype: string; stream: { id: string; finish: boolean; content: string } }
    }[]
    expect(a?.headers.req_id).toBe('req-in')
    expect(b?.headers.req_id).toBe('req-in')
    expect(a?.body.msgtype).toBe('stream')
    expect(a?.body.stream).toMatchObject({ finish: false, content: '收到，我查一下。' })
    expect(b?.body.stream).toMatchObject({ id: a?.body.stream.id, finish: true, content: '答案' })
    await r.adapter.stop()
  })

  it('不先回「收到」的：照旧一条普通文本回复', async () => {
    const r = wecomRig()
    await r.adapter.start(async () => {})
    r.up()
    r.last().emit(
      'message',
      JSON.stringify({
        cmd: CMD_MSG_CALLBACK,
        headers: { req_id: 'req-2' },
        body: {
          msgid: 'm2',
          chatid: 'c1',
          chattype: 'single',
          from: { userid: 'u' },
          msgtype: 'text',
          text: { content: '在吗' },
        },
      }),
    )
    await waitFor(() => r.adapter.pending === 1, '收到')
    await r.adapter.reply('wecom:m2', '答')
    const frame = r.last().sent.find((f) => f.cmd === CMD_RESPOND_MSG) as {
      body: { msgtype: string }
    }
    expect(frame.body.msgtype).toBe('text')
    await r.adapter.stop()
  })
})

/* ── 钉钉 ──────────────────────────────────────────────────────── */

const HOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=abc'

function dingRig(over: Partial<ConstructorParameters<typeof DingtalkBotAdapter>[0]> = {}) {
  const clock = new FakeClock()
  const sockets: Fake[] = []
  const states: [DingtalkConnState, DingtalkConnState][] = []
  const posts: string[] = []
  const http: DingtalkHttp = async (url, init) => {
    if (url.includes('gateway/connections/open'))
      return {
        status: 200,
        json: async () => ({
          endpoint: 'wss://wss-open-connection.dingtalk.com/connect',
          ticket: 'T',
        }),
      }
    posts.push(String((JSON.parse(init.body) as { text: { content: string } }).text.content))
    return { status: 200, json: async () => ({ errcode: 0 }) }
  }
  const adapter = new DingtalkBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: WS,
    credentials: () => ({ client_id: 'c', client_secret: 's' }),
    socket: () => {
      const s = new Fake('dingtalk')
      sockets.push(s)
      return s
    },
    http,
    backoff_ms: [1],
    on_state: (s, p) => states.push([s, p]),
    on_error: () => {},
    ...over,
  })
  const last = () => sockets[sockets.length - 1] as Fake
  return { adapter, sockets, states, posts, last, clock }
}

describe('钉钉：判死与重连（WP308）', () => {
  it('ping 之后到下一次还没 pong → 判死、掐掉、重新换 ticket 重连；状态如实', async () => {
    const r = dingRig({ keepalive_ms: 10 })
    await r.adapter.start(async () => {})
    r.last().emit('open', undefined)
    expect(r.adapter.state).toBe('connected')
    await waitFor(() => r.sockets.length === 2, '判死后重连')
    expect(r.sockets[0]?.pings).toBeGreaterThan(0)
    expect(r.sockets[0]?.terminated).toBe(true)
    r.last().emit('open', undefined)
    expect(r.states).toEqual([
      ['connecting', 'idle'],
      ['connected', 'connecting'],
      ['reconnecting', 'connected'],
      ['connected', 'reconnecting'],
    ])
    await r.adapter.stop()
  })

  it('pong 回得来就一直活着', async () => {
    const r = dingRig({ keepalive_ms: 5 })
    await r.adapter.start(async () => {})
    r.last().answer = true
    r.last().emit('open', undefined)
    await new Promise((res) => setTimeout(res, 60))
    expect(r.sockets.length).toBe(1)
    expect(r.last().pings).toBeGreaterThan(3)
    await r.adapter.stop()
  })

  it('握手卡住（拿到 ticket 但一直不 open）→ 掐掉重连', async () => {
    const r = dingRig({ handshake_timeout_ms: 10 })
    await r.adapter.start(async () => {})
    await waitFor(() => r.sockets.length === 2, '握手超时重连')
    expect(r.sockets[0]?.terminated).toBe(true)
    await r.adapter.stop()
  })

  it('keep：同一个 sessionWebhook 先回「收到」、再回答案', async () => {
    const r = dingRig()
    const seen: unknown[] = []
    await r.adapter.start(async (m) => {
      seen.push(m)
    })
    r.last().emit('open', undefined)
    r.last().emit(
      'message',
      JSON.stringify({
        type: 'CALLBACK',
        headers: { topic: TOPIC_ROBOT, messageId: 'mid' },
        data: JSON.stringify({
          msgId: 'k1',
          msgtype: 'text',
          text: { content: '在吗' },
          conversationType: '1',
          senderStaffId: 'staff',
          sessionWebhook: HOOK,
          sessionWebhookExpiredTime: Date.parse('2026-09-09T09:00:00.000Z'),
        }),
      }),
    )
    await waitFor(() => seen.length === 1, '收到')
    expect(await r.adapter.reply('dingtalk:k1', '收到，我查一下。', { keep: true })).toEqual({
      sent: true,
    })
    expect(r.adapter.pending).toBe(1)
    expect(await r.adapter.reply('dingtalk:k1', '答案')).toEqual({ sent: true })
    expect(r.adapter.pending).toBe(0)
    expect(r.posts).toEqual(['收到，我查一下。', '答案'])
    await r.adapter.stop()
  })
})

/* ── 决策 453：事件里聊天账号 id 只记哈希 ─────────────────────── */

describe('管线事件：聊天账号 id 只记哈希（WP308）', () => {
  const ingestOnce = async (hashAccount?: (v: string) => string) => {
    const { ChannelInboundPipeline } = await import('../src/pipeline.js')
    const { WECOM_BOT_CHANNEL, wecomPipelineAdapter } = await import('../src/wecom-bot/index.js')
    const clock = new FakeClock()
    const adapter = new WecomBotAdapter({
      clock,
      rawStore: new MemoryRawStore({ clock }),
      workspace_id: WS,
      credentials: () => undefined,
      newId: () => 'r',
    })
    const events: { type: string; payload: Record<string, unknown>; trace: string }[] = []
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [wecomPipelineAdapter(adapter)],
      workspace_id: WS,
      events: {
        append: (e) => {
          events.push({
            type: e.type,
            payload: e.payload as Record<string, unknown>,
            trace: e.correlation.trace_id,
          })
        },
      },
      route: () => ({ role_id: 'common.member', confidence: 1 }),
      onEvent: async () => {},
      ...(hashAccount === undefined ? {} : { hashAccount }),
    })
    // 没有 msgid：去重键兜底拼了发送人 id
    const body = {
      chatid: 'chat_secret',
      chattype: 'single' as const,
      from: { userid: 'zhangsan_userid' },
      msgtype: 'text',
      text: { content: '在吗' },
    }
    await pipeline.ingest(WECOM_BOT_CHANNEL, body, WS)
    await pipeline.ingest(WECOM_BOT_CHANNEL, body, WS)
    return events
  }

  it('给了 hashAccount：received / deduped 里没有原始账号 id，换成稳定的哈希', async () => {
    const hash = (v: string) => `h${v.length}`
    const events = await ingestOnce(hash)
    expect(events.map((e) => e.type)).toEqual(['inbound.received', 'inbound.deduped'])
    const text = JSON.stringify(events)
    expect(text).not.toContain('zhangsan_userid')
    expect(text).not.toContain('chat_secret')
    expect(events[0]?.payload).toMatchObject({
      actor_hash: hash('zhangsan_userid'),
      thread_hash: hash('wecom:chat_secret'),
    })
    expect(events[0]?.payload.actor_external_id).toBeUndefined()
    expect(events[0]?.payload.actor_hash).toBe(events[1]?.payload.actor_hash)
  })

  it('不给（邮件那几条）：照旧记原文', async () => {
    const events = await ingestOnce()
    expect(events[0]?.payload.actor_external_id).toBe('zhangsan_userid')
  })
})
