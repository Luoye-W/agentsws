/**
 * 钉钉机器人适配器（WP211；Stream 模式）。
 *
 * 换 ticket 的 HTTP 与长连接都是**内存替身**：私聊、群 @、群里没 @ 我、回执、
 * 系统 ping、服务端要求换连接、断线重连、凭据错误给人话、回复窗口与回复地址白名单
 * 都真的走了一遍状态机，CI 一行网都不出。
 */
import { describe, expect, it } from 'vitest'
import {
  DINGTALK_BOT_CHANNEL,
  DingtalkBotAdapter,
  type DingtalkHttp,
  type DingtalkRobotMessage,
  type DingtalkSocket,
  dingtalkPipelineAdapter,
  isDingtalkWebhook,
  TOPIC_ROBOT,
} from '../src/dingtalk-bot/index.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { FakeClock, waitFor } from './helpers.js'

const WS = 'ws_1'
const HOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=abc'

class FakeSocket implements DingtalkSocket {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  #h: Record<string, ((a: never) => void)[]> = {}
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }
  on(event: string, cb: (a: never) => void): void {
    this.#h[event] = [...(this.#h[event] ?? []), cb]
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.#h[event] ?? []) (cb as (a: unknown) => void)(arg)
  }
  push(frame: unknown): void {
    this.emit('message', JSON.stringify(frame))
  }
  robot(m: DingtalkRobotMessage, messageId = 'mid_1'): void {
    this.push({
      type: 'CALLBACK',
      headers: { topic: TOPIC_ROBOT, messageId },
      data: JSON.stringify(m),
    })
  }
}

function robotMsg(over: Partial<DingtalkRobotMessage> = {}): DingtalkRobotMessage {
  return {
    msgId: 'msg_1',
    msgtype: 'text',
    text: { content: ' 这周谁在管退款？ ' },
    conversationId: 'cid_1',
    conversationType: '1',
    senderStaffId: 'staff_zhang',
    senderId: '$:LWCP_v1:$x',
    senderNick: '张三',
    sessionWebhook: HOOK,
    sessionWebhookExpiredTime: Date.parse('2026-09-09T09:00:00.000Z'),
    ...over,
  }
}

function rig(
  opts: { statuses?: number[]; creds?: { client_id: string; client_secret: string } | null } = {},
) {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const statuses = [...(opts.statuses ?? [])]
  let credCalls = 0
  const http: DingtalkHttp = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ url, body })
    if (url.includes('gateway/connections/open')) {
      const status = statuses.shift() ?? 200
      return {
        status,
        json: async () =>
          status === 200
            ? { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'T+1' }
            : { code: 'x' },
      }
    }
    return { status: 200, json: async () => ({ errcode: 0 }) }
  }
  const errors: unknown[] = []
  const creds =
    opts.creds === undefined ? { client_id: 'ding_a', client_secret: 'SEC-2' } : opts.creds
  const adapter = new DingtalkBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: WS,
    credentials: () => {
      credCalls += 1
      return creds ?? undefined
    },
    socket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    http,
    backoff_ms: [1],
    on_error: (e) => errors.push(e),
  })
  const seen: DingtalkRobotMessage[] = []
  const start = () =>
    adapter.start(async (m) => {
      seen.push(m)
    })
  const last = () => sockets[sockets.length - 1] as FakeSocket
  return { adapter, sockets, calls, errors, seen, start, last, clock, credCalls: () => credCalls }
}

describe('钉钉：连上、回执、心跳', () => {
  it('换 ticket 带 Client ID / Secret，只订机器人消息；ticket 拼进连接地址', async () => {
    const r = rig()
    await r.start()
    expect(r.calls[0]?.body).toMatchObject({
      clientId: 'ding_a',
      clientSecret: 'SEC-2',
      subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }],
    })
    expect(r.last().url).toBe('wss://wss-open-connection.dingtalk.com:443/connect?ticket=T%2B1')
    r.last().emit('open', undefined)
    expect(r.adapter.connected).toBe(true)
    expect(JSON.stringify(r.adapter)).not.toContain('SEC-2')
  })

  it('系统 ping 原样回；回调先回执再处理', async () => {
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().push({
      type: 'SYSTEM',
      headers: { topic: 'ping', messageId: 'p1' },
      data: '{"opaque":"x"}',
    })
    expect(r.last().sent[0]).toMatchObject({
      code: 200,
      headers: { topic: 'ping' },
      data: '{"opaque":"x"}',
    })
    r.last().robot(robotMsg(), 'mid_7')
    expect(r.last().sent[1]).toMatchObject({ code: 200, headers: { messageId: 'mid_7' } })
    await waitFor(() => r.seen.length === 1, '私聊收到')
  })

  it('群里：@ 了才收；isInAtList=false 不收（但照样回执）', async () => {
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().robot(robotMsg({ msgId: 'g0', conversationType: '2', isInAtList: false }), 'm0')
    r.last().robot(robotMsg({ msgId: 'g1', conversationType: '2', isInAtList: true }), 'm1')
    await waitFor(() => r.seen.length === 1, '群 @ 收到')
    expect(r.seen[0]?.msgId).toBe('g1')
    expect(r.last().sent.filter((f) => f.code === 200)).toHaveLength(2)
  })
})

describe('钉钉：回复', () => {
  it('经 sessionWebhook 回；群里 @ 回提问人；过了有效期就不回', async () => {
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().robot(robotMsg({ msgId: 'g1', conversationType: '2', isInAtList: true }))
    await waitFor(() => r.seen.length === 1, '收到')
    expect(await r.adapter.reply('dingtalk:g1', '答')).toEqual({ sent: true })
    const hook = r.calls.find((c) => c.url === HOOK)
    expect(hook?.body).toEqual({
      msgtype: 'text',
      text: { content: '答' },
      at: { atUserIds: ['staff_zhang'] },
    })

    r.last().robot(robotMsg({ msgId: 'late' }))
    await waitFor(() => r.seen.length === 2, '又收到')
    r.clock.advance(2 * 60 * 60 * 1000)
    expect(await r.adapter.reply('dingtalk:late', '答')).toEqual({
      sent: false,
      reason: 'reply_window_closed',
    })
  })

  it('回复地址不是钉钉自己的域名就不发', async () => {
    expect(isDingtalkWebhook(HOOK)).toBe(true)
    expect(isDingtalkWebhook('https://evil.example/dingtalk.com')).toBe(false)
    expect(isDingtalkWebhook('http://oapi.dingtalk.com/x')).toBe(false)
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().robot(robotMsg({ msgId: 'x', sessionWebhook: 'https://evil.example/hook' }))
    await waitFor(() => r.seen.length === 1, '收到')
    expect(await r.adapter.reply('dingtalk:x', '答')).toEqual({
      sent: false,
      reason: 'bad_webhook',
    })
    expect(r.calls.some((c) => c.url.includes('evil'))).toBe(false)
  })
})

describe('钉钉：重连与凭据错误', () => {
  it('断线：按退避重连，重新现取凭据、重新换 ticket', async () => {
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().close()
    expect(r.adapter.state).toBe('reconnecting')
    await waitFor(() => r.sockets.length === 2, '重连')
    expect(r.credCalls()).toBe(2)
    expect(r.adapter.reconnects).toBe(1)
    r.last().emit('open', undefined)
    expect(r.adapter.connected).toBe(true)
  })

  it('服务端发 disconnect：主动换一条连接', async () => {
    const r = rig()
    await r.start()
    r.last().emit('open', undefined)
    r.last().push({ type: 'SYSTEM', headers: { topic: 'disconnect' }, data: '' })
    await waitFor(() => r.sockets.length === 2, '换连接')
  })

  it('网关 5xx：暂时连不上，自动重试到连上', async () => {
    const r = rig({ statuses: [503, 200] })
    await r.start()
    expect(r.adapter.lastError?.code).toBe('unreachable')
    await waitFor(() => r.sockets.length === 1, '重试后连上')
  })

  it('凭据错了（4xx）：一句人话、停下不空转', async () => {
    const r = rig({ statuses: [401] })
    await r.start()
    expect(r.adapter.state).toBe('failed')
    expect(r.adapter.lastError?.code).toBe('bad_credentials')
    expect(r.adapter.lastError?.message).toContain('Client Secret')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(r.calls).toHaveLength(1)
    expect(r.sockets).toHaveLength(0)
  })

  it('没配凭据就不连', async () => {
    const r = rig({ creds: null })
    await r.start()
    expect(r.calls).toHaveLength(0)
    expect(r.adapter.health()).toEqual({ ok: false, detail: '没有在连' })
  })
})

describe('钉钉：接进 18 §2 管线', () => {
  it('去重键 = msgId；重推只进一次；提问人 = 员工 userid', async () => {
    const clock = new FakeClock()
    const raw = new MemoryRawStore({ clock })
    const r = rig()
    const events: { actor?: { external_id: string } }[] = []
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [dingtalkPipelineAdapter(r.adapter)],
      workspace_id: WS,
      rawStore: raw,
      route: () => ({ role_id: 'common.member', confidence: 1 }),
      onEvent: async (e) => {
        events.push(e)
      },
    })
    const m = robotMsg({ msgId: 'dup' })
    await pipeline.ingest(DINGTALK_BOT_CHANNEL, m, WS)
    expect((await pipeline.ingest(DINGTALK_BOT_CHANNEL, m, WS)).deduped).toBe(true)
    await waitFor(() => events.length === 1, '进了一次')
    expect(events[0]?.actor?.external_id).toBe('staff_zhang')
  })
})
