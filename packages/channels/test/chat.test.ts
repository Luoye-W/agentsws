/**
 * 聊天渠道（WP57）：会话唯一键、去重、限流、会话门禁、随主体删除，
 * 以及"入站与邮件走同一条管线"这一条——它是整个 WP 的接线前提。
 *
 * 会话与消息两档存储跑同一份一致性套件（内存 / SQLite）。
 */
import { describe, expect, it } from 'vitest'
import {
  ChatChannelAdapter,
  ChatRateLimiter,
  ChatSessionStream,
  type ChatStore,
  chatDedupeKey,
  MemoryChatStore,
  SqliteChatStore,
  sandboxVisitorId,
  sseFrame,
} from '../src/chat/index.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { FakeClock, MemoryEventSink } from './helpers.js'

const WS = 'ws_1'
const T0 = '2026-09-09T08:00:00.000Z'

function rig(over: { store?: ChatStore } = {}) {
  const clock = new FakeClock(T0)
  const rawStore = new MemoryRawStore({ clock })
  const store = over.store ?? new MemoryChatStore()
  const adapter = new ChatChannelAdapter({ clock, store, rawStore })
  const events = new MemoryEventSink()
  const delivered: string[] = []
  const pipeline = new ChannelInboundPipeline({
    clock,
    adapters: [adapter],
    workspace_id: WS,
    events,
    rawStore,
    route: () => ({ role_id: 'dtc.live-chat', confidence: 0.9 }),
    onEvent: (e) => {
      delivered.push(e.dedupe_key)
    },
  })
  return { clock, rawStore, store, adapter, events, pipeline, delivered }
}

describe('会话唯一键与线程钉子', () => {
  it('同一 (workspace, source, external_session_id) 只有一条会话', async () => {
    const { adapter } = rig()
    const a = await adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: sandboxVisitorId('p_wang'),
    })
    const b = await adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: sandboxVisitorId('p_wang'),
    })
    expect(b.id).toBe(a.id)
  })

  it('换一个 source 就是另一条会话（沙盒与真访客不会撞）', async () => {
    const { adapter } = rig()
    const a = await adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    const b = await adapter.openSession({
      workspace_id: WS,
      source: 'widget',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    expect(b.id).not.toBe(a.id)
  })

  it('会话有一条 thread 外部 id，与邮件线程同一套钉法', async () => {
    const { adapter, store } = rig()
    const s = await adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    expect(s.thread_external_id).toBe(`chat-thread:${s.id}`)
    expect((await store.findByThread(s.thread_external_id))?.id).toBe(s.id)
  })
})

describe('入站走同一条管线', () => {
  const open = async (r: ReturnType<typeof rig>) =>
    r.adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
      visitor_display: '访客',
    })

  it('一条访客消息 → 一条 InboundEvent，正文已围栏', async () => {
    const r = rig()
    const s = await open(r)
    // 适配器把原始载荷交给管线（`receive` 里 await handler）
    r.adapter.start(async (raw) => {
      await r.pipeline.ingest('chat', raw, WS)
    })
    await r.adapter.receive({
      workspace_id: WS,
      session_id: s.id,
      external_id: 'm1',
      text: 'how much is shipping?',
    })
    const events = r.pipeline.delivered()
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e?.channel).toBe('chat')
    expect(e?.dedupe_key).toBe(chatDedupeKey(s.id, 'm1'))
    expect(e?.thread?.external_id).toBe(s.thread_external_id)
    // 18 §2.2 第一条纪律：出管线时 parts.text 已经在围栏里
    const text = e?.parts.find((p) => p.type === 'text')
    expect(text?.type === 'text' && text.text).toContain('<external_data>')
  })

  it('去重键 = 会话 + 消息 id：重投只产出一条事件', async () => {
    const r = rig()
    const s = await open(r)
    const raw = {
      session_id: s.id,
      external_id: 'm1',
      visitor_id: 'v1',
      text: 'hi',
      at: r.clock.now(),
    }
    const first = await r.pipeline.ingest('chat', raw, WS)
    const again = await r.pipeline.ingest('chat', raw, WS)
    expect(first.deduped).toBe(false)
    expect(again.deduped).toBe(true)
    expect(r.delivered).toEqual([chatDedupeKey(s.id, 'm1')])
  })

  it('两条会话的同名消息 id 不互相去重', async () => {
    const r = rig()
    const a = await open(r)
    const b = await r.adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_2',
      visitor_id: 'v2',
    })
    for (const s of [a, b]) {
      await r.pipeline.ingest(
        'chat',
        { session_id: s.id, external_id: 'm1', visitor_id: s.visitor_id, text: 'hi', at: T0 },
        WS,
      )
    }
    expect(r.delivered).toHaveLength(2)
  })

  it('卡号进来：脱敏并标 secrets_scrubbed，原文只在 raw 区', async () => {
    const r = rig()
    const s = await open(r)
    const { event } = await r.pipeline.ingest(
      'chat',
      {
        session_id: s.id,
        external_id: 'm1',
        visitor_id: 'v1',
        text: 'my card is 4111 1111 1111 1111',
        at: T0,
      },
      WS,
    )
    expect(event?.secrets_scrubbed).toBe(true)
    const text = event?.parts.find((p) => p.type === 'text')
    expect(text?.type === 'text' && text.text).not.toContain('4111 1111 1111 1111')
  })

  it('原文按访客 id 落受控区（随主体删除的那把钥匙）', async () => {
    const r = rig()
    const s = await open(r)
    await r.pipeline.ingest(
      'chat',
      { session_id: s.id, external_id: 'm1', visitor_id: 'v1', text: 'hi', at: T0 },
      WS,
    )
    const ref = r.pipeline.delivered()[0]?.raw_ref as string
    expect(await r.rawStore.get(ref)).toMatchObject({ channel: 'chat', subject_ref: 'v1' })
  })

  it('会话不存在 → 拒收，不静默建一条', async () => {
    const r = rig()
    await expect(
      r.pipeline.ingest(
        'chat',
        { session_id: 'cs_nope', external_id: 'm1', visitor_id: 'v1', text: 'hi', at: T0 },
        WS,
      ),
    ).rejects.toThrow(/没有这条会话/)
  })
})

describe('限流：按 (workspace, visitor)', () => {
  it('超了这一分钟的额度就拒收，且不入库', async () => {
    const clock = new FakeClock(T0)
    const store = new MemoryChatStore()
    const adapter = new ChatChannelAdapter({
      clock,
      store,
      rawStore: new MemoryRawStore({ clock }),
      rate_limit: { per_minute: 2 },
    })
    const s = await adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    for (const id of ['m1', 'm2']) {
      const out = await adapter.receive({
        workspace_id: WS,
        session_id: s.id,
        external_id: id,
        text: 'hi',
      })
      expect(out.accepted).toBe(true)
    }
    const blocked = await adapter.receive({
      workspace_id: WS,
      session_id: s.id,
      external_id: 'm3',
      text: 'hi',
    })
    expect(blocked.accepted).toBe(false)
    expect(blocked.rate.window).toBe('minute')
    expect(blocked.rate.retry_after).toBeGreaterThan(0)
    // 被挡下的消息在库里不该留下痕迹
    expect(await store.listMessages(s.id)).toHaveLength(2)
  })

  it('挡的是一个访客，不是整个工作区', () => {
    const limiter = new ChatRateLimiter({ per_minute: 1 })
    const t = Date.parse(T0)
    expect(limiter.take(WS, 'v1', t).allowed).toBe(true)
    expect(limiter.take(WS, 'v1', t).allowed).toBe(false)
    expect(limiter.take(WS, 'v2', t).allowed).toBe(true)
  })

  it('窗口滑过去就恢复', () => {
    const limiter = new ChatRateLimiter({ per_minute: 1 })
    const t = Date.parse(T0)
    limiter.take(WS, 'v1', t)
    expect(limiter.take(WS, 'v1', t + 60_001).allowed).toBe(true)
  })

  it('每小时那一档也管用', () => {
    const limiter = new ChatRateLimiter({ per_minute: 1000, per_hour: 3 })
    const t = Date.parse(T0)
    for (let i = 0; i < 3; i += 1) limiter.take(WS, 'v1', t + i * 61_000)
    const v = limiter.take(WS, 'v1', t + 4 * 61_000)
    expect(v.allowed).toBe(false)
    expect(v.window).toBe('hour')
  })
})

describe('出站：会话内推送 + 会话门禁', () => {
  it('推一条 AI 消息 → 落库 + 推给订阅者', async () => {
    const r = rig()
    const s = await r.adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    const frames: unknown[] = []
    const sub = r.adapter.stream.subscribe(s.id, (f) => frames.push(f))
    await r.adapter.send(
      { external_id: s.thread_external_id },
      [{ type: 'text', text: '免邮。' }],
      {
        connect_token: '',
        idempotency_key: 'idem_1',
      },
    )
    sub.stop()
    expect(frames).toHaveLength(1)
    expect(await r.store.listMessages(s.id)).toMatchObject([{ role: 'agent', text: '免邮。' }])
  })

  it('同一幂等键推两次只有一条消息', async () => {
    const r = rig()
    const s = await r.adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    const send = () =>
      r.adapter.send({ external_id: s.thread_external_id }, [{ type: 'text', text: 'hi' }], {
        connect_token: '',
        idempotency_key: 'idem_1',
      })
    const a = await send()
    const b = await send()
    expect(b.external_id).toBe(a.external_id)
    expect(await r.store.listMessages(s.id)).toHaveLength(1)
  })

  it('会话门禁：模型编一个会话 id 推不出去', async () => {
    const r = rig()
    await expect(
      r.adapter.send({ external_id: 'chat-thread:cs_forged' }, [{ type: 'text', text: 'hi' }], {
        connect_token: '',
        idempotency_key: 'idem_1',
      }),
    ).rejects.toMatchObject({ code: 'authorization_check_failed' })
  })

  it('出站脱敏：正文里的凭据形态串发不出去', async () => {
    const r = rig()
    const s = await r.adapter.openSession({
      workspace_id: WS,
      source: 'sandbox',
      external_session_id: 'ext_1',
      visitor_id: 'v1',
    })
    await r.adapter.send(
      { external_id: s.thread_external_id },
      [{ type: 'text', text: 'use sk_abcdefghijklmnop1234 to check' }],
      { connect_token: '', idempotency_key: 'idem_1' },
    )
    const [message] = await r.store.listMessages(s.id)
    expect(message?.text).not.toContain('sk_abcdefghijklmnop1234')
  })

  it('没有订阅者时推送不报错（消息已经落库了）', async () => {
    const stream = new ChatSessionStream()
    expect(stream.publish('cs_1', { type: 'typing', session_id: 'cs_1', on: true })).toBe(0)
    expect(sseFrame({ type: 'typing', session_id: 'cs_1', on: true })).toMatch(/^data: \{.*\}\n\n$/)
  })
})

describe('会话与消息两档存储的一致性', () => {
  const cases: { name: string; make: () => ChatStore }[] = [
    { name: '内存档', make: () => new MemoryChatStore() },
    { name: 'SQLite 档', make: () => new SqliteChatStore() },
  ]

  for (const { name, make } of cases) {
    describe(name, () => {
      it('ensureSession 幂等', async () => {
        const store = make()
        const input = {
          workspace_id: WS,
          source: 'sandbox' as const,
          external_session_id: 'ext_1',
          visitor_id: 'v1',
          at: T0,
        }
        expect((await store.ensureSession(input)).id).toBe((await store.ensureSession(input)).id)
        store.close?.()
      })

      it('同一 external_id 的消息只留一条', async () => {
        const store = make()
        const s = await store.ensureSession({
          workspace_id: WS,
          source: 'sandbox',
          external_session_id: 'ext_1',
          visitor_id: 'v1',
          at: T0,
        })
        const msg = {
          session_id: s.id,
          workspace_id: WS,
          role: 'visitor' as const,
          text: 'hi',
          at: T0,
          external_id: 'm1',
        }
        await store.appendMessage(msg)
        await store.appendMessage(msg)
        expect(await store.listMessages(s.id)).toHaveLength(1)
        store.close?.()
      })

      it('patchSession：null 清空求助钟点，undefined 不动', async () => {
        const store = make()
        const s = await store.ensureSession({
          workspace_id: WS,
          source: 'sandbox',
          external_session_id: 'ext_1',
          visitor_id: 'v1',
          at: T0,
        })
        await store.patchSession(s.id, {
          assist_requested_at: T0,
          status: 'assist_requested',
          at: T0,
        })
        const armed = await store.getSession(s.id)
        expect(armed?.assist_requested_at).toBe(T0)
        await store.patchSession(s.id, { takeover: true, at: T0 })
        expect((await store.getSession(s.id))?.assist_requested_at).toBe(T0)
        await store.patchSession(s.id, { assist_requested_at: null, at: T0 })
        expect((await store.getSession(s.id))?.assist_requested_at).toBeUndefined()
        expect((await store.getSession(s.id))?.takeover).toBe(true)
        store.close?.()
      })

      it('21 §4 随主体删除：这个访客的会话与消息一起没了', async () => {
        const store = make()
        const s = await store.ensureSession({
          workspace_id: WS,
          source: 'sandbox',
          external_session_id: 'ext_1',
          visitor_id: 'v1',
          at: T0,
        })
        await store.appendMessage({
          session_id: s.id,
          workspace_id: WS,
          role: 'visitor',
          text: 'hi',
          at: T0,
          external_id: 'm1',
        })
        expect(await store.eraseVisitor('v1')).toBeGreaterThan(0)
        expect(await store.getSession(s.id)).toBeUndefined()
        expect(await store.listMessages(s.id)).toHaveLength(0)
        store.close?.()
      })

      it('listSessions 按状态过滤', async () => {
        const store = make()
        for (const [i, status] of ['open', 'closed'].entries()) {
          const s = await store.ensureSession({
            workspace_id: WS,
            source: 'sandbox',
            external_session_id: `ext_${i}`,
            visitor_id: `v${i}`,
            at: T0,
          })
          await store.patchSession(s.id, { status, at: T0 })
        }
        expect(await store.listSessions(WS, { status: ['open'] })).toHaveLength(1)
        expect(await store.listSessions(WS)).toHaveLength(2)
        store.close?.()
      })
    })
  }
})
