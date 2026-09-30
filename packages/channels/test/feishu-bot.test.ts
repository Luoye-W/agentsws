/**
 * 飞书机器人适配器（WP211）。
 *
 * 官方 SDK 是注入的：这里用一个**内存替身**（`FakeFeishu`）实现 `FeishuTransport`，
 * 能往回推事件、切连接状态、记下回复——私聊、群 @、不是 @ 我、机器人自己发的、
 * 断线重连、凭据错误给人话都真的走了一遍状态机，CI 一行网都不出。
 */
import { describe, expect, it } from 'vitest'
import {
  FEISHU_BOT_CHANNEL,
  FeishuBotAdapter,
  type FeishuConnState,
  type FeishuMessageEvent,
  type FeishuTransport,
  feishuDedupeKey,
  feishuErrorToHuman,
  feishuPipelineAdapter,
  feishuReplyBody,
  isAddressedToFeishuBot,
  textOfFeishu,
} from '../src/feishu-bot/index.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { FakeClock, waitFor } from './helpers.js'

const WS = 'ws_1'
const BOT = 'ou_bot'

class FakeFeishu implements FeishuTransport {
  started: { app_id: string; app_secret: string; domain: string }[] = []
  replies: { message_id: string; text: string }[] = []
  stopped = 0
  failReply = false
  #onEvent: ((e: FeishuMessageEvent) => void) | undefined
  #onState: ((s: FeishuConnState, d?: string) => void) | undefined

  async start(input: Parameters<FeishuTransport['start']>[0]): Promise<void> {
    this.started.push({ app_id: input.app_id, app_secret: input.app_secret, domain: input.domain })
    this.#onEvent = input.onEvent
    this.#onState = input.onState
    input.onState('connecting')
  }
  async stop(): Promise<void> {
    this.stopped += 1
  }
  async reply(input: { message_id: string; text: string }): Promise<void> {
    if (this.failReply) throw new Error('HTTP 500')
    this.replies.push(input)
  }
  async botOpenId(): Promise<string | undefined> {
    return BOT
  }
  push(e: FeishuMessageEvent): void {
    this.#onEvent?.(e)
  }
  state(s: FeishuConnState, d?: string): void {
    this.#onState?.(s, d)
  }
}

function msg(over: {
  id?: string
  chat_type?: 'p2p' | 'group'
  text?: string
  from?: string
  sender_type?: string
  mentions?: FeishuMessageEvent['message'] extends infer M
    ? M extends { mentions?: infer X }
      ? X
      : never
    : never
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: over.from ?? 'ou_zhang' },
      sender_type: over.sender_type ?? 'user',
    },
    message: {
      message_id: over.id ?? 'om_1',
      chat_id: 'oc_chat',
      chat_type: over.chat_type ?? 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: over.text ?? '这周谁在管退款？' }),
      ...(over.mentions === undefined ? {} : { mentions: over.mentions }),
    },
  }
}

function rig(
  creds: { app_id: string; app_secret: string } | null = { app_id: 'cli_a', app_secret: 'SEC-1' },
) {
  const clock = new FakeClock()
  const fake = new FakeFeishu()
  const errors: unknown[] = []
  let calls = 0
  const adapter = new FeishuBotAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    workspace_id: WS,
    credentials: () => {
      calls += 1
      return creds ?? undefined
    },
    transport: () => fake,
    on_error: (e) => errors.push(e),
  })
  const seen: FeishuMessageEvent[] = []
  const start = () =>
    adapter.start(async (e) => {
      seen.push(e)
    })
  return { adapter, fake, errors, seen, start, calls: () => calls, clock }
}

describe('飞书：收什么、不收什么', () => {
  it('私聊一律收；凭据现取，Secret 交给 SDK 之后适配器不留', async () => {
    const r = rig()
    await r.start()
    expect(r.calls()).toBe(1)
    expect(r.fake.started[0]).toEqual({ app_id: 'cli_a', app_secret: 'SEC-1', domain: 'feishu' })
    expect(JSON.stringify(r.adapter)).not.toContain('SEC-1')
    r.fake.state('connected')
    r.fake.push(msg({}))
    await waitFor(() => r.seen.length === 1, '私聊收到')
    expect(r.adapter.received).toBe(1)
    expect(r.adapter.health()).toEqual({ ok: true })
  })

  it('群里：@ 了机器人才收；@ 别人、@所有人、没 @ 都不收', async () => {
    const r = rig()
    await r.start()
    r.fake.push(msg({ id: 'g0', chat_type: 'group' }))
    r.fake.push(
      msg({
        id: 'g1',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_li' } }],
      }),
    )
    r.fake.push(msg({ id: 'g2', chat_type: 'group', mentions: [{ key: '@_all', id: 'all' }] }))
    r.fake.push(
      msg({
        id: 'g3',
        chat_type: 'group',
        text: '@_user_1 这周谁在管退款？',
        mentions: [{ key: '@_user_1', id: { open_id: BOT } }],
      }),
    )
    await waitFor(() => r.seen.length === 1, '群 @ 收到')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(r.seen.map((e) => e.message?.message_id)).toEqual(['g3'])
    // 占位符不进问题
    expect(textOfFeishu(r.seen[0] as FeishuMessageEvent)).toBe('这周谁在管退款？')
  })

  it('机器人 / 应用自己发的不理（免得两个机器人对聊）', async () => {
    const r = rig()
    await r.start()
    r.fake.push(msg({ sender_type: 'app' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(r.seen).toHaveLength(0)
  })

  it('还没拿到机器人 open_id 时，群里有 @ 某人就算（只开 @ 权限时飞书本来只推 @ 我的）', () => {
    const e = msg({ chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' } }] })
    expect(isAddressedToFeishuBot(e, undefined)).toBe(true)
    expect(isAddressedToFeishuBot(e, BOT)).toBe(false)
    expect(isAddressedToFeishuBot(msg({ chat_type: 'group' }), undefined)).toBe(false)
  })

  it('富文本（post）也读得出字；别的类型回空串', () => {
    const post: FeishuMessageEvent = {
      message: {
        message_id: 'p1',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '周报',
            content: [
              [
                { tag: 'at', user_id: 'x' },
                { tag: 'text', text: '退款 ' },
                { tag: 'text', text: '多少' },
              ],
            ],
          },
        }),
      },
    }
    expect(textOfFeishu(post)).toBe('周报\n退款 多少')
    expect(textOfFeishu({ message: { message_type: 'image', content: '{"image_key":"k"}' } })).toBe(
      '',
    )
    expect(textOfFeishu({ message: { message_type: 'text', content: 'not json' } })).toBe('')
  })
})

describe('飞书：回复、重连、凭据错误', () => {
  it('回复挂在原消息上；未知消息与发送失败都说得清', async () => {
    const r = rig()
    await r.start()
    r.fake.push(msg({ id: 'om_9' }))
    await waitFor(() => r.seen.length === 1, '收到')
    expect(await r.adapter.reply('feishu:nope', 'x')).toEqual({
      sent: false,
      reason: 'unknown_message',
    })
    r.fake.failReply = true
    expect(await r.adapter.reply('feishu:om_9', '答')).toEqual({
      sent: false,
      reason: 'send_failed',
    })
    r.fake.failReply = false
    expect(await r.adapter.reply('feishu:om_9', '答')).toEqual({ sent: true })
    expect(r.fake.replies).toEqual([{ message_id: 'om_9', text: '答' }])
    expect(feishuReplyBody('答')).toEqual({ msg_type: 'text', content: '{"text":"答"}' })
  })

  it('断线重连：状态跟着 SDK 走，重连之后照样收', async () => {
    const r = rig()
    await r.start()
    r.fake.state('connected')
    r.fake.state('reconnecting')
    expect(r.adapter.connected).toBe(false)
    expect(r.adapter.health().ok).toBe(false)
    expect(r.adapter.reconnects).toBe(1)
    r.fake.state('connected')
    r.fake.push(msg({ id: 'after' }))
    await waitFor(() => r.seen.length === 1, '重连后收到')
    expect(r.adapter.health()).toEqual({ ok: true })
  })

  it('凭据错了：给一句人话、停下不空转；原始错误串不给人看', async () => {
    const r = rig()
    await r.start()
    r.fake.state('failed', 'pullConnectConfig failed: code=514, msg=auth failed')
    await waitFor(() => r.fake.stopped === 1, '停下')
    expect(r.adapter.state).toBe('failed')
    expect(r.adapter.lastError?.code).toBe('bad_credentials')
    expect(r.adapter.lastError?.message).toContain('App Secret')
    expect(r.adapter.lastError?.message).not.toContain('pullConnectConfig')
    expect(r.adapter.health().detail).toContain('App ID')
    expect(r.errors).toHaveLength(1)
  })

  it('别的失败也翻成人话', () => {
    expect(feishuErrorToHuman('pullConnectConfig failed: code=403, msg=x').code).toBe('not_enabled')
    expect(feishuErrorToHuman('code=1000040350').code).toBe('too_many_connections')
    expect(feishuErrorToHuman('ECONNRESET').code).toBe('unreachable')
  })

  it('没配凭据就不连', async () => {
    const r = rig(null)
    await r.start()
    expect(r.fake.started).toHaveLength(0)
    expect(r.adapter.health()).toEqual({ ok: false, detail: '没有在连' })
  })
})

describe('飞书：接进 18 §2 管线', () => {
  it('去重键 = message_id；重推同一条只进一次；正文脱敏', async () => {
    const clock = new FakeClock()
    const raw = new MemoryRawStore({ clock })
    const r = rig()
    const events: unknown[] = []
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [feishuPipelineAdapter(r.adapter)],
      workspace_id: WS,
      rawStore: raw,
      route: () => ({ role_id: 'common.member', confidence: 1 }),
      onEvent: async (e) => {
        events.push(e)
      },
    })
    const e = msg({ id: 'om_dup', text: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz0123' })
    expect(feishuDedupeKey(e)).toBe('feishu:om_dup')
    await pipeline.ingest(FEISHU_BOT_CHANNEL, e, WS)
    const again = await pipeline.ingest(FEISHU_BOT_CHANNEL, e, WS)
    expect(again.deduped).toBe(true)
    await waitFor(() => events.length === 1, '进了一次')
    expect(JSON.stringify(events)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
  })
})
