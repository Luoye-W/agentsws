/**
 * 企业微信智能机器人适配器 + IM 卡片渲染（WP85；54 §5）。
 *
 * 长连接用一个**内存假服务器**（`FakeWecomServer`）：它实现 `WecomSocket` 那四个
 * 事件，所以握手、心跳、断线重连、24h 回复窗口、限流全都是真的走了一遍状态机，
 * 而 `@agentsws/channels` 一行 `ws` 依赖都不用加，CI 也一行网都不出。
 * 真 `ws` 那一档在 `apps/server/test/im-channels.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { imCardDeepLink, renderCardForIm } from '../src/im-cards.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { MemoryRawStore } from '../src/raw-store.js'
import {
  CMD_MSG_CALLBACK,
  CMD_RESPOND_MSG,
  CMD_SUBSCRIBE,
  isAddressedToBot,
  RATE_PER_MINUTE,
  REPLY_WINDOW_MS,
  WECOM_BOT_CHANNEL,
  WecomBotAdapter,
  type WecomInboundBody,
  type WecomSocket,
  wecomDedupeKey,
  wecomPipelineAdapter,
} from '../src/wecom-bot/index.js'
import { FakeClock, waitFor } from './helpers.js'

const WS = 'ws_1'

/** 内存假长连接：记下发出去的帧，可以随时往回推一帧或者断线。 */
class FakeWecomServer implements WecomSocket {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  #handlers: Record<string, ((arg: never) => void)[]> = {}

  send(data: string): void {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }

  on(event: 'open' | 'message' | 'close' | 'error', cb: (arg: never) => void): void {
    const list = this.#handlers[event] ?? []
    list.push(cb)
    this.#handlers[event] = list
  }

  emit(event: string, arg: unknown): void {
    for (const cb of this.#handlers[event] ?? []) (cb as (a: unknown) => void)(arg)
  }

  /** 服务端：连上了。 */
  open(): void {
    this.emit('open', undefined)
  }

  /** 服务端：订阅回执。 */
  ack(errcode = 0): void {
    this.emit('message', JSON.stringify({ cmd: CMD_SUBSCRIBE, errcode, errmsg: 'ok' }))
  }

  /** 服务端：推一条消息。 */
  push(body: WecomInboundBody, req_id = 'req-1'): void {
    this.emit('message', JSON.stringify({ cmd: CMD_MSG_CALLBACK, headers: { req_id }, body }))
  }

  get subscribeFrames(): Record<string, unknown>[] {
    return this.sent.filter((f) => f.cmd === CMD_SUBSCRIBE)
  }

  get replies(): Record<string, unknown>[] {
    return this.sent.filter((f) => f.cmd === CMD_RESPOND_MSG)
  }
}

function body(over: Partial<WecomInboundBody> = {}): WecomInboundBody {
  return {
    msgid: 'wm_1',
    aibotid: 'bot_1',
    chatid: 'chat_1',
    chattype: 'group',
    from: { userid: 'zhangsan', name: '张三' },
    msgtype: 'text',
    text: { content: '@机器人 我这周有什么要定的？' },
    ...over,
  }
}

interface Rig {
  clock: FakeClock
  adapter: WecomBotAdapter
  sockets: FakeWecomServer[]
  inbound: { body: WecomInboundBody; msgid: string }[]
  errors: unknown[]
}

async function makeRig(
  over: Partial<ConstructorParameters<typeof WecomBotAdapter>[0]> = {},
): Promise<Rig> {
  const clock = new FakeClock()
  const sockets: FakeWecomServer[] = []
  const inbound: { body: WecomInboundBody; msgid: string }[] = []
  const errors: unknown[] = []
  let n = 0
  const adapter = new WecomBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: WS,
    credentials: () => ({ bot_id: 'BOT-ID', secret: 'BOT-SECRET' }),
    socket: () => {
      const s = new FakeWecomServer()
      sockets.push(s)
      return s
    },
    newId: () => `req_${++n}`,
    on_error: (e) => {
      errors.push(e)
    },
    ...over,
  })
  await adapter.start(async (b) => {
    inbound.push({ body: b, msgid: wecomDedupeKey(b) })
  })
  return { clock, adapter, sockets, inbound, errors }
}

describe('企业微信协议：纯函数', () => {
  it('去重键就是 msgid', () => {
    expect(wecomDedupeKey(body())).toBe('wecom:wm_1')
  })

  it('单聊与群聊都算「说给机器人听」（群里本来就只有被 @ 才收得到）', () => {
    expect(isAddressedToBot(body({ chattype: 'single' }))).toBe(true)
    expect(isAddressedToBot(body({ chattype: 'group' }))).toBe(true)
  })
})

describe('企业微信长连接', () => {
  it('连上就用 BotID + Secret 订阅；订阅成功之后才算连上', async () => {
    const { adapter, sockets } = await makeRig()
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    expect(socket.subscribeFrames).toHaveLength(1)
    expect(socket.subscribeFrames[0]?.body).toEqual({ bot_id: 'BOT-ID', secret: 'BOT-SECRET' })
    expect(adapter.connected).toBe(false)
    socket.ack()
    expect(adapter.connected).toBe(true)
    expect(adapter.health().ok).toBe(true)
    await adapter.stop()
  })

  it('订阅被拒不静默：报一条说得清的错', async () => {
    const { adapter, sockets, errors } = await makeRig()
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack(40001)
    expect(adapter.connected).toBe(false)
    expect(String(errors[0])).toContain('企业微信订阅被拒')
    await adapter.stop()
  })

  it('断线会重连（退避梯子），重连时重新取一次凭据', async () => {
    let credCalls = 0
    const { adapter, sockets } = await makeRig({
      credentials: () => {
        credCalls += 1
        return { bot_id: 'BOT-ID', secret: 'BOT-SECRET' }
      },
    })
    expect(credCalls).toBe(1)
    const first = sockets[0] as FakeWecomServer
    first.open()
    first.ack()
    first.close()
    await waitFor(() => sockets.length > 1, '重连')
    expect(adapter.reconnects).toBe(1)
    // 13 §4.3：secret 每次现取，不在适配器里留
    expect(credCalls).toBe(2)
    await adapter.stop()
  })

  it('stop 之后不再重连', async () => {
    const { adapter, sockets } = await makeRig()
    const first = sockets[0] as FakeWecomServer
    first.open()
    first.ack()
    await adapter.stop()
    first.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(sockets).toHaveLength(1)
  })

  it('心跳按 30s 的节奏 ping（测试里调快）', async () => {
    const { adapter, sockets } = await makeRig({ heartbeat_ms: 5 })
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack()
    await waitFor(() => socket.sent.some((f) => f.cmd === 'ping'), '心跳')
    await adapter.stop()
  })
})

describe('企业微信收信与回信', () => {
  it('群里 @ 进来的消息进管线，回信带回入站那条的 req_id', async () => {
    const { adapter, sockets, inbound } = await makeRig()
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack()
    socket.push(body(), 'req-abc')
    await waitFor(() => inbound.length === 1, '收到一条')

    const head = await adapter.toInbound(inbound[0]?.body as WecomInboundBody, WS)
    expect(head.channel).toBe(WECOM_BOT_CHANNEL)
    expect(head.actor.external_id).toBe('zhangsan')
    expect(head.thread.external_id).toBe('wecom:chat_1')
    expect(head.channel_meta.chat_type).toBe('group')

    const sent = await adapter.reply('wecom:wm_1', '你有 2 张卡等你定。')
    expect(sent).toEqual({ sent: true })
    expect(socket.replies[0]).toMatchObject({
      cmd: CMD_RESPOND_MSG,
      headers: { req_id: 'req-abc' },
      body: { msgtype: 'text', text: { content: '你有 2 张卡等你定。' } },
    })
    await adapter.stop()
  })

  it('过了 24h 回复窗口就不回', async () => {
    const { adapter, clock, sockets, inbound } = await makeRig()
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack()
    socket.push(body())
    await waitFor(() => inbound.length === 1, '收到一条')
    clock.advance(REPLY_WINDOW_MS + 1)
    expect(await adapter.reply('wecom:wm_1', '迟到一天的回复')).toEqual({
      sent: false,
      reason: 'reply_window_closed',
    })
    expect(socket.replies).toHaveLength(0)
    await adapter.stop()
  })

  it('单会话限额满了就不发，也不排队', async () => {
    const { adapter, sockets, inbound } = await makeRig({ rate: { per_minute: 2 } })
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack()
    for (let i = 0; i < 3; i++) socket.push(body({ msgid: `wm_${i}` }), `req-${i}`)
    await waitFor(() => inbound.length === 3, '收到三条')
    expect(await adapter.reply('wecom:wm_0', 'a')).toEqual({ sent: true })
    expect(await adapter.reply('wecom:wm_1', 'b')).toEqual({ sent: true })
    expect(await adapter.reply('wecom:wm_2', 'c')).toEqual({
      sent: false,
      reason: 'rate_limited',
    })
    expect(socket.replies).toHaveLength(2)
    expect(RATE_PER_MINUTE).toBe(30)
    await adapter.stop()
  })

  it('没连上就不发', async () => {
    const { adapter, sockets, inbound } = await makeRig()
    const socket = sockets[0] as FakeWecomServer
    socket.open()
    socket.ack()
    socket.push(body())
    await waitFor(() => inbound.length === 1, '收到一条')
    await adapter.stop()
    expect(await adapter.reply('wecom:wm_1', 'x')).toEqual({
      sent: false,
      reason: 'not_connected',
    })
  })

  it('同一条推两遍，管线只产出一条事件', async () => {
    const clock = new FakeClock()
    const raw = new MemoryRawStore({ clock })
    const adapter = new WecomBotAdapter({
      clock,
      rawStore: raw,
      workspace_id: WS,
      credentials: () => undefined,
      newId: () => 'r',
    })
    const delivered: string[] = []
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [wecomPipelineAdapter(adapter)],
      workspace_id: WS,
      route: () => ({ role_id: 'common.member', confidence: 1 }),
      onEvent: async (e) => {
        delivered.push(e.dedupe_key)
      },
    })
    await pipeline.ingest(WECOM_BOT_CHANNEL, body(), WS)
    const second = await pipeline.ingest(WECOM_BOT_CHANNEL, body(), WS)
    expect(second.deduped).toBe(true)
    expect(delivered).toEqual(['wecom:wm_1'])
  })

  it('管线那一头不做任意外发', async () => {
    const { adapter } = await makeRig()
    await expect(wecomPipelineAdapter(adapter).send()).rejects.toThrow(/24h 回复窗口/)
    await adapter.stop()
  })
})

describe('卡片在 IM 里：只有摘要 + 深链，没有按钮', () => {
  it('渲染出来的东西里没有 decision_token、没有动作参数', () => {
    const link = imCardDeepLink('http://127.0.0.1:7777', 'itm_42')
    const text = renderCardForIm(
      {
        id: 'itm_42',
        title: '给 Jane 的退款回信',
        summary: '客户说包裹破损，草稿里承诺全额退款。',
        kind: 'draft_reply',
        hint: '发出去之前你得点一下',
      },
      link,
    )
    expect(text).toContain('【待你定 · 一封待发的回信】给 Jane 的退款回信')
    expect(text).toContain('去工作台处理：')
    expect(text).toContain('/cards/itm_42')
    expect(text).not.toContain('decision_token')
    expect(text).not.toContain('action=')
    expect(text).not.toContain('approve')
  })

  it('摘要里抄来的秘密会被抹掉（出站脱敏）', () => {
    // 运行时拼出一串像 key 的假字符串：字面量会触发 GitHub 的密钥扫描（2026-09-16 误报一次）
    const fakeKey = ['sk', 'abcdefghijklmnopqrstuvwxyz', '0123456789ABCD'].join('-').replace('-0', '0')
    const text = renderCardForIm(
      {
        id: 'itm_43',
        title: '客户把 key 发过来了',
        summary: `他贴了 ${fakeKey} 过来。`,
      },
      'http://127.0.0.1:7777/cards/itm_43',
    )
    expect(text).not.toContain(fakeKey)
  })

  it('长摘要会截断（IM 里没人读长文）', () => {
    const text = renderCardForIm(
      { id: 'x', title: 't', summary: '啊'.repeat(400) },
      'http://127.0.0.1:1/cards/x',
    )
    expect(text.length).toBeLessThan(300)
  })
})
