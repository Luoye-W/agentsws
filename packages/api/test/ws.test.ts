/**
 * WP33 B：WebSocket 事件流的协议逻辑（`WsSession`）。
 *
 * 传输（握手 / 帧）由宿主用 `ws` 做；这里测的是与传输无关的那一半：
 * 订阅、按岗位过滤、只推摘要、断线重连补拉、每连接限速、急停 all 只推 halt.changed。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  classify,
  parseSubprotocols,
  summarize,
  WS_BEARER_PREFIX,
  WS_CLOSE,
  WS_SUBPROTOCOL,
  type WsFrame,
  WsSession,
  type WsSink,
} from '../src/index.js'
import { harness, T0 } from './helpers.js'

/** 记下所有写出去的帧的假 socket。 */
class FakeSink implements WsSink {
  readonly frames: WsFrame[] = []
  closed: { code: number; reason: string } | undefined
  send(text: string): void {
    this.frames.push(JSON.parse(text) as WsFrame)
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  named(name: string): WsFrame[] {
    return this.frames.filter((f) => f.name === name)
  }
  clear(): void {
    this.frames.length = 0
  }
}

type H = Awaited<ReturnType<typeof harness>>

function seed(h: H, over: Partial<EventEnvelope> & { type: string }): EventEnvelope {
  return h.eventLog.append({
    schema_version: 1,
    workspace_id: h.workspace_id,
    at: T0,
    actor: { kind: 'system', id: 'sys' },
    correlation: { trace_id: 'tr_seed' },
    payload: { body: '这是正文，永远不该出现在推送里' },
    ...over,
  } as Omit<EventEnvelope, 'id'>)
}

async function connected(
  h: H,
  input: { assignment?: string; since?: string; types?: string[] } = {},
): Promise<{ session: WsSession; sink: FakeSink }> {
  const sink = new FakeSink()
  const principal = {
    person_id: h.person_id,
    workspace_id: h.workspace_id,
    kind: 'session' as const,
  }
  const session = new WsSession(h.deps, principal, sink)
  await session.handle(
    JSON.stringify({
      op: 'subscribe',
      assignment_id: input.assignment ?? h.assignment.id,
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.types === undefined ? {} : { types: input.types }),
    }),
  )
  return { session, sink }
}

describe('29 §6 帧分类与摘要', () => {
  it('四类分类对得上 AG-UI 的 TEXT / TOOL_CALL / STATE / CUSTOM', () => {
    expect(classify('text.delta')).toBe('TEXT')
    expect(classify('tool.call')).toBe('TOOL_CALL')
    expect(classify('tool.result')).toBe('TOOL_CALL')
    expect(classify('approval.decided')).toBe('STATE')
    expect(classify('change.applied')).toBe('STATE')
    expect(classify('schedule.fired')).toBe('STATE')
    expect(classify('halt.changed')).toBe('STATE')
    expect(classify('model.usage')).toBe('CUSTOM')
  })

  it('摘要里没有 payload——正文一个字节都不推', () => {
    const frame = summarize({
      id: 'evt_1',
      schema_version: 1,
      workspace_id: 'ws',
      type: 'approval.decided',
      at: T0,
      actor: { kind: 'person', id: 'per_1', run_id: 'run_1' },
      subject: { type: 'approval_item', id: 'ap_1' },
      correlation: { trace_id: 'tr_1' },
      payload: { secret: '不该出现' },
    })
    expect(frame).toEqual({
      type: 'STATE',
      id: 'evt_1',
      name: 'approval.decided',
      at: T0,
      subject: { type: 'approval_item', id: 'ap_1' },
      run_id: 'run_1',
      trace_id: 'tr_1',
    })
    expect(JSON.stringify(frame)).not.toContain('不该出现')
  })
})

describe('订阅与鉴权', () => {
  it('subscribe 成功 → CONTROL/ready，带订阅范围', async () => {
    const h = await harness()
    const { session, sink } = await connected(h)
    expect(session.subscribed).toBe(true)
    const ready = sink.frames[0]
    expect(ready?.type).toBe('CONTROL')
    expect(ready?.name).toBe('ready')
    expect((ready as { detail: { scope: string } }).detail.scope).toBe('workspace')
  })

  it('assignment 不属于本人 → 4403 关连接', async () => {
    const h = await harness()
    const { sink } = await connected(h, { assignment: 'asg_foreign' })
    expect(sink.closed?.code).toBe(WS_CLOSE.forbidden)
  })

  it('岗位没有 event_log 读权限 → 4403（不是「连上了但什么都不推」）', async () => {
    const h = await harness()
    const { sink } = await connected(h, { assignment: h.weakAssignment.id })
    expect(sink.closed?.code).toBe(WS_CLOSE.forbidden)
  })

  it('消息不是合法 JSON / op 不认识 → 4400', async () => {
    const h = await harness()
    const principal = {
      person_id: h.person_id,
      workspace_id: h.workspace_id,
      kind: 'session' as const,
    }
    const bad = new FakeSink()
    await new WsSession(h.deps, principal, bad).handle('{ 这不是 json')
    expect(bad.closed?.code).toBe(WS_CLOSE.invalid_input)

    const weird = new FakeSink()
    await new WsSession(h.deps, principal, weird).handle(JSON.stringify({ op: 'destroy' }))
    expect(weird.closed?.code).toBe(WS_CLOSE.invalid_input)
  })

  it('ping → pong', async () => {
    const h = await harness()
    const sink = new FakeSink()
    const session = new WsSession(
      h.deps,
      { person_id: h.person_id, workspace_id: h.workspace_id, kind: 'session' },
      sink,
    )
    await session.handle(JSON.stringify({ op: 'ping' }))
    expect(sink.frames.map((f) => f.name)).toEqual(['pong'])
  })

  it('token 从子协议头里读，不从 URL（20 §3）', () => {
    const parsed = parseSubprotocols(`${WS_SUBPROTOCOL}, ${WS_BEARER_PREFIX}sess_abc`)
    expect(parsed).toEqual({ token: 'sess_abc', accept: WS_SUBPROTOCOL })
    // 只报子协议不带 token 的（浏览器靠 cookie）
    expect(parseSubprotocols(WS_SUBPROTOCOL)).toEqual({ accept: WS_SUBPROTOCOL })
    expect(parseSubprotocols(undefined)).toEqual({})
  })
})

describe('推送', () => {
  it('新连接不补历史，只接着「现在」看——日志比一页长也一样', async () => {
    // batch 故意调小：`#tail` 要一页页翻到真正的末尾，只发一个 limit 只会停在第一页
    const h = await harness({ ws: { batch: 2 } })
    for (let i = 0; i < 5; i += 1) seed(h, { type: 'approval.created' })
    const { session, sink } = await connected(h)
    sink.clear()
    expect(await session.pump()).toBe(0)
    // 之后来的才推
    seed(h, { type: 'approval.decided', subject: { type: 'approval_item', id: h.item.id } })
    expect(await session.pump()).toBe(1)
    expect(sink.frames[0]?.name).toBe('approval.decided')
  })

  it('带 since 的重连补拉断线期间的那些（28 §4 用例 4 的 WS 版）', async () => {
    const h = await harness()
    const first = seed(h, { type: 'approval.created' })
    seed(h, { type: 'approval.decided' })
    seed(h, { type: 'change.applied' })
    const { sink } = await connected(h, { since: first.id })
    expect(sink.frames.filter((f) => f.type !== 'CONTROL').map((f) => f.name)).toEqual([
      'approval.decided',
      'change.applied',
    ])
  })

  it('不在订阅集合里的类型不推（默认集合里没有 model.*）', async () => {
    const h = await harness()
    const { session, sink } = await connected(h)
    sink.clear()
    seed(h, { type: 'model.usage' })
    seed(h, { type: 'approval.decided' })
    await session.pump()
    expect(sink.frames.map((f) => f.name)).toEqual(['approval.decided'])
  })

  it('types 是前缀：只订 approval. 就只收 approval.*', async () => {
    const h = await harness()
    const { session, sink } = await connected(h, { types: ['approval.'] })
    sink.clear()
    seed(h, { type: 'change.applied' })
    seed(h, { type: 'approval.claimed' })
    await session.pump()
    expect(sink.frames.map((f) => f.name)).toEqual(['approval.claimed'])
  })

  it('按岗位过滤：与 /v1/events 同一条规则', async () => {
    const h = await harness()
    const { session, sink } = await connected(h, { assignment: h.memberAssignment.id })
    sink.clear()
    // 本人是收件人的那张卡
    seed(h, { type: 'approval.decided', subject: { type: 'approval_item', id: h.item.id } })
    // 与本人无关的运行
    seed(h, { type: 'run.completed', actor: { kind: 'agent', id: 'agent_x' } })
    await session.pump()
    expect(sink.frames.map((f) => f.name)).toEqual(['approval.decided'])
  })

  it('岗位在连接期间被撤销 → 立刻断（05 §4 撤销后不可读）', async () => {
    const h = await harness()
    const { session, sink } = await connected(h, { assignment: h.memberAssignment.id })
    h.memberAssignment.revoked_at = T0
    seed(h, { type: 'approval.decided', subject: { type: 'approval_item', id: h.item.id } })
    expect(await session.pump()).toBe(0)
    expect(sink.closed?.code).toBe(WS_CLOSE.forbidden)
  })
})

describe('急停与限速', () => {
  it('急停 all 时只推 halt.changed', async () => {
    const h = await harness()
    const { session, sink } = await connected(h)
    sink.clear()
    h.halt.set('all', true, '演练')
    seed(h, { type: 'approval.decided', subject: { type: 'approval_item', id: h.item.id } })
    seed(h, { type: 'halt.changed' })
    seed(h, { type: 'change.applied' })
    await session.pump()
    expect(sink.frames.map((f) => f.name)).toEqual(['halt.changed'])
  })

  it('每连接限速：超限的那些合并成一帧 CONTROL/dropped，客户端据此整体重取', async () => {
    const h = await harness({ ws: { maxFramesPerSecond: 2 } })
    const { session, sink } = await connected(h)
    sink.clear()
    for (let i = 0; i < 5; i += 1) seed(h, { type: 'approval.claimed' })
    await session.pump()
    // 一秒内只放两帧
    expect(sink.frames.filter((f) => f.type !== 'CONTROL')).toHaveLength(2)
    // 下一秒补一帧 dropped，说明丢了三条
    h.clock.advance(1200)
    seed(h, { type: 'approval.claimed' })
    await session.pump()
    const dropped = sink.frames.find((f) => f.name === 'dropped')
    expect((dropped as { detail: { count: number } } | undefined)?.detail.count).toBe(3)
  })
})

describe('/v1/ws 的 HTTP 面', () => {
  it('普通 HTTP 打过来 → 426，并把怎么连说清楚', async () => {
    const h = await harness()
    const res = await h.get('/v1/ws', { assignment: null, headers: {} })
    expect(res.status).toBe(426)
    const body = (await res.json()) as { data: { protocol: string; frames: string[] } }
    expect(body.data.protocol).toBe(WS_SUBPROTOCOL)
    expect(body.data.frames).toContain('STATE')
  })

  it('openapi 里带 AsyncAPI 片段，第三方前端只看 openapi.json 就知道怎么接', async () => {
    const h = await harness()
    const doc = (await (
      await h.get('/openapi.json', { assignment: null, headers: {} })
    ).json()) as {
      'x-asyncapi': { channels: Record<string, unknown>; asyncapi: string }
      paths: Record<string, unknown>
    }
    expect(doc['x-asyncapi'].asyncapi).toBe('2.6.0')
    expect(Object.keys(doc['x-asyncapi'].channels)).toEqual(['/v1/ws'])
    expect(doc.paths['/v1/ws']).toBeDefined()
  })
})
