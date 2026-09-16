/**
 * 微信 ClawBot 适配器（WP85；54 §5）。
 *
 * 分两层测：
 * - **协议层**打真 HTTP（`127.0.0.1` 上的假 iLink，见 `fake-ilink-server.ts`）：
 *   请求头、长轮询、`-14`、`-2` 都是真的走了一遍 fetch；
 * - **纪律层**用内存替身：去重键、游标持久化、`context_token` 过期、
 *   「不是本人发的一律不处理」、「没有会话上下文就不发」。
 */
import type { InboundEvent } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { MemoryQueueStore } from '../src/queue.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { SqliteClawBotStateStore } from '../src/sqlite-queue.js'
import {
  ClawBotLogin,
  clawBotDedupeKey,
  clawBotHeaders,
  clawBotPipelineAdapter,
  createHttpClawBotTransport,
  MemoryClawBotStateStore,
  RET_PREPARE_FAILED,
  RET_STALE_TOKEN,
  textOfMessage,
  WECHAT_CLAWBOT_CHANNEL,
  WeChatClawBotAdapter,
  type WireMessage,
  wechatUin,
} from '../src/wechat-clawbot/index.js'
import { startFakeILink } from './fake-ilink-server.js'
import { FakeClock, MemoryEventSink, waitFor } from './helpers.js'

const WS = 'ws_1'
const ME = 'ilink_user_me'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

function msg(over: Partial<WireMessage> = {}): WireMessage {
  return {
    message_id: '100001',
    from_user_id: ME,
    message_type: 1,
    create_time_ms: Date.parse('2026-09-09T08:00:00.000Z'),
    item_list: [{ type: 1, text_item: { text: '我今天有什么要定的？' } }],
    context_token: 'ctx-1',
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof WeChatClawBotAdapter>[0]> = {}): {
  clock: FakeClock
  adapter: WeChatClawBotAdapter
  state: MemoryClawBotStateStore
  raw: MemoryRawStore
} {
  const clock = new FakeClock()
  const raw = new MemoryRawStore({ clock })
  const state = new MemoryClawBotStateStore()
  const adapter = new WeChatClawBotAdapter({
    clock,
    rawStore: raw,
    transport: {
      qrcode: async () => ({ qrcode: 'q', qrcode_img_content: 'u' }),
      qrcodeStatus: async () => ({ status: 'wait' as const }),
      getUpdates: async () => ({ ret: 0, msgs: [], get_updates_buf: '' }),
      sendMessage: async () => ({ ret: 0, message_id: 'm1' }),
    },
    account_id: 'bot_1',
    base_url: 'https://ilink.example',
    token: () => 'tok',
    allow_from: [ME],
    state,
    idle_delay_ms: 1,
    retry_delay_ms: 1,
    backoff_delay_ms: 1,
    ...over,
  })
  return { clock, adapter, state, raw }
}

describe('ClawBot 协议：纯函数', () => {
  it('去重键就是消息 id', () => {
    expect(clawBotDedupeKey(msg())).toBe('wechat:100001')
  })

  it('没有消息 id 时不把两条不同的消息折成一条', () => {
    const a = clawBotDedupeKey(msg({ message_id: undefined, seq: 1, create_time_ms: 1 }))
    const b = clawBotDedupeKey(msg({ message_id: undefined, seq: 2, create_time_ms: 2 }))
    expect(a).not.toBe(b)
  })

  it('正文只取 text item', () => {
    expect(
      textOfMessage(
        msg({
          item_list: [
            { type: 1, text_item: { text: '一' } },
            { type: 2, image_item: { url: 'x' } },
            { type: 1, text_item: { text: '二' } },
          ],
        }),
      ),
    ).toBe('一\n二')
  })

  it('请求头按文档那张表：有 token 才有 Authorization', () => {
    const uin = wechatUin(() => 0.5)
    expect(clawBotHeaders({ uin })['Authorization']).toBeUndefined()
    expect(clawBotHeaders({ uin, token: 't' })['Authorization']).toBe('Bearer t')
    expect(clawBotHeaders({ uin })['AuthorizationType']).toBe('ilink_bot_token')
    expect(clawBotHeaders({ uin })['iLink-App-Id']).toBe('bot')
    // X-WECHAT-UIN 是「十进制串再 base64」
    expect(Number.isInteger(Number(Buffer.from(uin, 'base64').toString('utf8')))).toBe(true)
  })
})

describe('ClawBot 扫码登录', () => {
  it('bot_token 只走 onConfirmed，不进返回值', async () => {
    const fake = await startFakeILink({
      statuses: [
        { status: 'wait' },
        { status: 'scaned' },
        {
          status: 'confirmed',
          bot_token: 'SECRET-TOKEN',
          ilink_bot_id: 'bot_9',
          baseurl: 'https://idc.example',
          ilink_user_id: ME,
        },
      ],
    })
    closers.push(fake.close)
    const clock = new FakeClock()
    const handed: unknown[] = []
    let n = 0
    const login = new ClawBotLogin({
      clock,
      transport: createHttpClawBotTransport({ base_url: fake.url, random: () => 0.1 }),
      newId: () => `login_${++n}`,
      base_url: fake.url,
      onConfirmed: (h) => {
        handed.push(h)
      },
    })

    const started = await login.start()
    expect(started.qrcode_url).toBe('https://weixin.example/qr/1')

    expect((await login.poll(started.login_id)).status).toBe('waiting')
    expect((await login.poll(started.login_id)).status).toBe('scanned')
    const done = await login.poll(started.login_id)

    expect(done.status).toBe('confirmed')
    expect(done.account_id).toBe('bot_9')
    expect(done.user_id).toBe(ME)
    // 13 §4.3：凭据不进响应体
    expect(JSON.stringify(done)).not.toContain('SECRET-TOKEN')
    expect(handed).toEqual([
      {
        login_id: started.login_id,
        account_id: 'bot_9',
        bot_token: 'SECRET-TOKEN',
        base_url: 'https://idc.example',
        user_id: ME,
      },
    ])
    // 扫码那两条按文档**不带** Authorization
    const status = fake.calls.find((c) => c.path.startsWith('/ilink/bot/get_qrcode_status'))
    expect(status?.headers['authorization']).toBeUndefined()
  })

  it('二维码过期会自动换一张，换够次数就停下', async () => {
    const fake = await startFakeILink({ statuses: [{ status: 'expired' }] })
    closers.push(fake.close)
    const clock = new FakeClock()
    let n = 0
    const login = new ClawBotLogin({
      clock,
      transport: createHttpClawBotTransport({ base_url: fake.url, random: () => 0.1 }),
      newId: () => `login_${++n}`,
      base_url: fake.url,
      onConfirmed: () => undefined,
    })
    const started = await login.start()
    const first = await login.poll(started.login_id)
    expect(first.status).toBe('waiting')
    expect(first.qrcode_url).toBe('https://weixin.example/qr/1')
    await login.poll(started.login_id)
    await login.poll(started.login_id)
    const gaveUp = await login.poll(started.login_id)
    expect(gaveUp.status).toBe('expired')
    expect(login.pending).toBe(0)
  })
})

describe('ClawBot 收信', () => {
  it('长轮询收到的消息进管线，游标落盘，同一条只产一条事件', async () => {
    const clock = new FakeClock()
    const raw = new MemoryRawStore({ clock })
    const state = new MemoryClawBotStateStore()
    let round = 0
    const adapter = new WeChatClawBotAdapter({
      clock,
      rawStore: raw,
      transport: {
        qrcode: async () => ({ qrcode: 'q', qrcode_img_content: 'u' }),
        qrcodeStatus: async () => ({ status: 'wait' as const }),
        getUpdates: async () => {
          round += 1
          if (round === 1) return { ret: 0, msgs: [msg()], get_updates_buf: 'BUF-1' }
          // 第二轮把**同一条**再吐一遍（服务端重投是常态）
          if (round === 2) return { ret: 0, msgs: [msg()], get_updates_buf: 'BUF-2' }
          return { ret: 0, msgs: [], get_updates_buf: 'BUF-2' }
        },
        sendMessage: async () => ({ ret: 0, message_id: 'm1' }),
      },
      account_id: 'bot_1',
      base_url: 'https://ilink.example',
      token: () => 'tok',
      allow_from: [ME],
      state,
      idle_delay_ms: 1,
    })

    const events = new MemoryEventSink()
    const delivered: InboundEvent[] = []
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [clawBotPipelineAdapter(adapter)],
      workspace_id: WS,
      events,
      queue: new MemoryQueueStore(),
      // 路由到「我的代理」：本人的消息一律落 common.member（见 im-channels.ts）
      route: () => ({ role_id: 'common.member', confidence: 1 }),
      onEvent: async (e) => {
        delivered.push(e)
      },
    })

    adapter.start(async (m) => {
      await pipeline.ingest(WECHAT_CLAWBOT_CHANNEL, m, WS)
    })
    await waitFor(() => adapter.received >= 2, '两轮长轮询')
    await adapter.stop()

    // 去重键 = 消息 id → 两次投递只产出一条事件
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.dedupe_key).toBe('wechat:100001')
    expect(events.typesOf()).toContain('inbound.deduped')
    // 游标落盘了（重启不从头拉）
    expect(state.cursor('bot_1')).toBe('BUF-2')
    // 入站的 context_token 缓存下来了
    expect(state.contextToken('bot_1', ME, Date.parse(clock.now()))).toBe('ctx-1')
  })

  it('不是绑定的那个人发的，一条都不处理', async () => {
    const clock = new FakeClock()
    const raw = new MemoryRawStore({ clock })
    const seen: WireMessage[] = []
    const adapter = new WeChatClawBotAdapter({
      clock,
      rawStore: raw,
      transport: {
        qrcode: async () => ({ qrcode: 'q', qrcode_img_content: 'u' }),
        qrcodeStatus: async () => ({ status: 'wait' as const }),
        getUpdates: async () => ({
          ret: 0,
          msgs: [msg({ from_user_id: 'someone_else' }), msg({ message_type: 2 })],
          get_updates_buf: 'B',
        }),
        sendMessage: async () => ({ ret: 0 }),
      },
      account_id: 'bot_1',
      base_url: 'https://ilink.example',
      token: () => 'tok',
      allow_from: [ME],
      idle_delay_ms: 1,
    })
    adapter.start(async (m) => {
      seen.push(m)
    })
    await waitFor(() => adapter.health().ok, '连上')
    await adapter.stop()
    expect(seen).toHaveLength(0)
    expect(adapter.allows('someone_else')).toBe(false)
  })

  it('-14：停一小时并要求重扫', async () => {
    const stale: { account_id: string; paused_until: string }[] = []
    const { adapter, clock } = makeAdapter({
      transport: {
        qrcode: async () => ({ qrcode: 'q', qrcode_img_content: 'u' }),
        qrcodeStatus: async () => ({ status: 'wait' as const }),
        getUpdates: async () => ({ ret: RET_STALE_TOKEN, errmsg: 'stale' }),
        sendMessage: async () => ({ ret: 0 }),
      },
      onTokenStale: (input) => {
        stale.push(input)
      },
    })
    adapter.start(async () => undefined)
    await waitFor(() => stale.length > 0, '-14 触发停机')
    await adapter.stop()
    const paused = adapter.pausedUntil()
    expect(paused).toBeDefined()
    expect(Date.parse(paused as string) - Date.parse(clock.now())).toBe(60 * 60 * 1000)
    expect(adapter.health().ok).toBe(false)
    expect(adapter.health().detail).toContain('重新扫码')
  })
})

describe('ClawBot 回信', () => {
  it('没有会话上下文就不发（不做主动外呼）', async () => {
    const { adapter } = makeAdapter()
    expect(await adapter.sendText(ME, '好')).toEqual({ skipped: 'no_context' })
  })

  it('context_token 过期 = 当没有，等本人下一条消息', async () => {
    const { adapter, clock, state } = makeAdapter()
    state.setContextToken('bot_1', ME, {
      token: 'ctx-1',
      expires_at_ms: Date.parse(clock.now()) + 1000,
    })
    expect(await adapter.sendText(ME, '好')).toEqual({ external_id: 'm1' })
    clock.advance(2000)
    expect(await adapter.sendText(ME, '再一句')).toEqual({ skipped: 'no_context' })
  })

  it('-2：丢掉这条上下文，不重试也不重扫', async () => {
    const { adapter, clock, state } = makeAdapter({
      transport: {
        qrcode: async () => ({ qrcode: 'q', qrcode_img_content: 'u' }),
        qrcodeStatus: async () => ({ status: 'wait' as const }),
        getUpdates: async () => ({ ret: 0, msgs: [] }),
        sendMessage: async () => ({ ret: RET_PREPARE_FAILED, errmsg: 'prepare failed' }),
      },
    })
    state.setContextToken('bot_1', ME, {
      token: 'ctx-1',
      expires_at_ms: Date.parse(clock.now()) + 60_000,
    })
    expect(await adapter.sendText(ME, '好')).toEqual({ skipped: 'context_expired' })
    expect(state.contextToken('bot_1', ME, Date.parse(clock.now()))).toBeUndefined()
    // 没有因此停机（`-2` 不是凭据问题）
    expect(adapter.pausedUntil()).toBeUndefined()
  })

  it('没有 token（解绑过）就不发', async () => {
    const { adapter, clock, state } = makeAdapter({ token: () => undefined })
    state.setContextToken('bot_1', ME, {
      token: 'ctx-1',
      expires_at_ms: Date.parse(clock.now()) + 60_000,
    })
    expect(await adapter.sendText(ME, '好')).toEqual({ skipped: 'no_token' })
  })

  it('管线那一头拒绝主动外呼', async () => {
    const { adapter } = makeAdapter()
    await expect(
      clawBotPipelineAdapter(adapter).send({ external_id: 'x' }, [], {
        connect_token: 't',
        idempotency_key: 'k',
      }),
    ).rejects.toThrow(/主动外呼/)
  })
})

describe('ClawBot 状态落盘（SQLite 档与内存档同一份用例）', () => {
  it('游标与上下文重开一次库还在，clear 之后都没了', () => {
    const store = new SqliteClawBotStateStore({ dbPath: ':memory:' })
    store.setCursor('bot_1', 'BUF-9')
    store.setContextToken('bot_1', ME, { token: 'ctx-9', expires_at_ms: 10_000 })
    expect(store.cursor('bot_1')).toBe('BUF-9')
    expect(store.contextToken('bot_1', ME, 9_999)).toBe('ctx-9')
    // 过期的读不出来，而且会顺手删掉
    expect(store.contextToken('bot_1', ME, 10_001)).toBeUndefined()
    store.setContextToken('bot_1', ME, { token: 'ctx-10', expires_at_ms: 20_000 })
    store.clear('bot_1')
    expect(store.cursor('bot_1')).toBeUndefined()
    expect(store.contextToken('bot_1', ME, 1)).toBeUndefined()
    store.close()
  })
})

describe('ClawBot 真 HTTP（假 iLink，不出网）', () => {
  it('长轮询带上游标与鉴权头，回来的 uint64 id 不掉精度', async () => {
    const fake = await startFakeILink({
      updates: [
        // 原样吐的一段 JSON：这个 id 超过 Number.MAX_SAFE_INTEGER，
        // 裸 `JSON.parse` 会把它变成 …992
        `{"ret":0,"get_updates_buf":"BUF-A","msgs":[{"message_id":9007199254740993,"from_user_id":"${ME}","item_list":[]}]}`,
      ],
    })
    closers.push(fake.close)
    const transport = createHttpClawBotTransport({ base_url: fake.url, random: () => 0.3 })
    const resp = await transport.getUpdates({
      base_url: fake.url,
      token: 'tok',
      get_updates_buf: 'BUF-0',
      timeout_ms: 2000,
    })
    expect(resp.get_updates_buf).toBe('BUF-A')
    expect(resp.msgs?.[0]?.message_id).toBe('9007199254740993')

    const call = fake.calls.find((c) => c.path.startsWith('/ilink/bot/getupdates'))
    expect(call?.headers['authorization']).toBe('Bearer tok')
    expect(call?.headers['authorizationtype']).toBe('ilink_bot_token')
    expect(call?.headers['x-wechat-uin']).toBeDefined()
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ get_updates_buf: 'BUF-0' })
  })
})
