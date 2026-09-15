/**
 * 网关这一层的在线客服面（WP57）：路由形状、鉴权、急停、SSE，
 * 以及 **「公开访客端点不在本地档」** 这条——它是这个 WP 的边界，值得一条断言钉住。
 *
 * 判定、卡片、模型都在 `apps/server` 与 `support-core`（那边有端到端测试），
 * 这里只用一个记账用的假端口。
 */
import { describe, expect, it } from 'vitest'
import type {
  ChatFrame,
  ChatMessageView,
  ChatPort,
  ChatSessionView,
  ChatTurnView,
} from '../src/index.js'
import { CHAT_SSE_HEARTBEAT_MS, createGateway } from '../src/index.js'
import { harness } from './helpers.js'

const T0 = '2026-09-07T09:00:00.000Z'

const SESSION: ChatSessionView = {
  id: 'cs_0001',
  source: 'sandbox',
  external_session_id: 'sandbox:p_me',
  visitor_display: '沙盒访客',
  status: 'open',
  takeover: false,
  thread_external_id: 'chat-thread:cs_0001',
  created_at: T0,
  updated_at: T0,
}

const TURN: ChatTurnView = {
  session_id: 'cs_0001',
  used_model: true,
  plan: {
    action: 'answer',
    intent: 'presales_product',
    risk: 'normal',
    can_auto_reply: true,
    money_touch: false,
    missing_info: [],
    summary: '低风险问题，可以按知识与订单事实直接回复。',
    next_question: '我会按现在的商品、订单与客服知识继续帮你处理。',
  },
  reply: 'Shipping to the US is free over $50.',
}

class FakeChat implements ChatPort {
  readonly calls: string[] = []
  readonly listeners: ((frame: ChatFrame) => void)[] = []
  readonly stopped: number[] = []
  session_exists = true
  takeover = false

  async openSandbox(person_id: string): Promise<ChatSessionView> {
    this.calls.push(`openSandbox:${person_id}`)
    return SESSION
  }
  async sessions(filter: { limit?: number }): Promise<ChatSessionView[]> {
    this.calls.push(`sessions:${filter.limit ?? '-'}`)
    return [SESSION]
  }
  async session(id: string): Promise<ChatSessionView | undefined> {
    return this.session_exists && id === SESSION.id ? SESSION : undefined
  }
  async messages(session_id: string): Promise<ChatMessageView[]> {
    this.calls.push(`messages:${session_id}`)
    return [{ id: 'cm_1', role: 'visitor', text: 'hi', at: T0 }]
  }
  async send(input: { session_id: string; text: string }): Promise<ChatTurnView> {
    this.calls.push(`send:${input.text}`)
    return TURN
  }
  async advance(session_id: string): Promise<ChatTurnView> {
    this.calls.push(`advance:${session_id}`)
    return TURN
  }
  async setTakeover(_id: string, on: boolean): Promise<ChatSessionView> {
    this.calls.push(`takeover:${on}`)
    this.takeover = on
    return { ...SESSION, takeover: on, status: on ? 'human_takeover' : 'open' }
  }
  async teach(input: { instruction: string; scope: string }): Promise<{
    outcome: string
    reply?: string
    sediment: string
  }> {
    this.calls.push(`teach:${input.scope}`)
    return { outcome: 'sent', reply: 'Yes, we ship there.', sediment: 'knowledge_candidate' }
  }
  async touch(session_id: string): Promise<void> {
    this.calls.push(`touch:${session_id}`)
  }
  subscribe(_session_id: string, listener: (frame: ChatFrame) => void): () => void {
    this.listeners.push(listener)
    const index = this.listeners.length - 1
    return () => this.stopped.push(index)
  }
}

async function rig(withPort = true) {
  const h = await harness()
  const port = new FakeChat()
  const gateway = createGateway({ ...h.deps, ...(withPort ? { chat: port } : {}) })
  const call = (method: string, path: string, body?: unknown, auth = true): Promise<Response> => {
    const headers = new Headers(auth ? { Authorization: `Bearer ${h.token}` } : {})
    if (auth) headers.set('X-Assignment', h.assignment.id)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    )
  }
  const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
  return { h, port, gateway, call, data }
}

describe('会话与消息', () => {
  it('开一条会话 → 201；重复开拿回同一条（幂等在下游）', async () => {
    const r = await rig()
    const res = await r.call('POST', '/v1/chat/sessions')
    expect(res.status).toBe(201)
    expect(await r.data<ChatSessionView>(res)).toMatchObject({ id: 'cs_0001' })
  })

  it('列会话；limit 不是正整数 → 400', async () => {
    const r = await rig()
    expect((await r.call('GET', '/v1/chat/sessions?limit=5')).status).toBe(200)
    expect(r.port.calls).toContain('sessions:5')
    const bad = await r.call('GET', '/v1/chat/sessions?limit=0')
    expect(bad.status).toBe(400)
  })

  it('读消息：一起给会话与消息', async () => {
    const r = await rig()
    const res = await r.call('GET', '/v1/chat/sessions/cs_0001/messages')
    const out = await r.data<{ session: ChatSessionView; messages: ChatMessageView[] }>(res)
    expect(out.session.id).toBe('cs_0001')
    expect(out.messages).toHaveLength(1)
  })

  it('会话不存在 → 404（不静默建一条）', async () => {
    const r = await rig()
    r.port.session_exists = false
    expect((await r.call('GET', '/v1/chat/sessions/cs_0001/messages')).status).toBe(404)
    expect(
      (await r.call('POST', '/v1/chat/sessions/cs_0001/messages', { text: 'hi' })).status,
    ).toBe(404)
  })
})

describe('一轮：发消息与推进', () => {
  it('发一句 → 回这一轮的计划与回复', async () => {
    const r = await rig()
    const res = await r.call('POST', '/v1/chat/sessions/cs_0001/messages', { text: '运费多少' })
    expect(res.status).toBe(201)
    const turn = await r.data<ChatTurnView>(res)
    expect(turn.plan?.action).toBe('answer')
    expect(turn.reply).toContain('free over $50')
  })

  it('空正文 / 超长 → 400', async () => {
    const r = await rig()
    expect((await r.call('POST', '/v1/chat/sessions/cs_0001/messages', { text: '' })).status).toBe(
      400,
    )
    const long = { text: 'x'.repeat(4001) }
    expect((await r.call('POST', '/v1/chat/sessions/cs_0001/messages', long)).status).toBe(400)
  })

  it('静默窗口到了：沙盒页自己点 advance，不等真定时器', async () => {
    const r = await rig()
    expect((await r.call('POST', '/v1/chat/sessions/cs_0001/advance')).status).toBe(200)
    expect(r.port.calls).toContain('advance:cs_0001')
  })
})

describe('人工接管与教 AI', () => {
  it('接管开关', async () => {
    const r = await rig()
    const res = await r.call('PUT', '/v1/chat/sessions/cs_0001/takeover', { on: true })
    expect(await r.data<ChatSessionView>(res)).toMatchObject({
      takeover: true,
      status: 'human_takeover',
    })
  })

  it('教 AI：scope 不给按「只管这一条回复」', async () => {
    const r = await rig()
    const res = await r.call('POST', '/v1/chat/sessions/cs_0001/teach', {
      instruction: '巴西我们发的，走 DHL。',
    })
    expect(res.status).toBe(200)
    expect(r.port.calls).toContain('teach:single_reply')
  })

  it('教 AI：指导太长 → 400', async () => {
    const r = await rig()
    const res = await r.call('POST', '/v1/chat/sessions/cs_0001/teach', {
      instruction: '好'.repeat(2001),
    })
    expect(res.status).toBe(400)
  })
})

describe('SSE', () => {
  it('挂上先推一帧 ready，之后转发会话里的推送', async () => {
    const r = await rig()
    const res = await r.call('GET', '/v1/chat/sessions/cs_0001/stream')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decode = async (): Promise<string> =>
      new TextDecoder().decode((await reader.read()).value)
    expect(await decode()).toContain('"type":"ready"')

    r.port.listeners[0]?.({ type: 'message', message: { id: 'cm_2', text: 'hi' } })
    expect(await decode()).toContain('"type":"message"')

    // 断开 → 停订阅（不停的话每开一次沙盒页漏一个订阅者）
    await reader.cancel()
    expect(r.port.stopped).toEqual([0])
  })

  it('心跳周期比常见反代空闲超时短', () => {
    expect(CHAT_SSE_HEARTBEAT_MS).toBeLessThan(30_000)
  })
})

describe('边界', () => {
  it('没装在线客服 → 501，工作台照常能用', async () => {
    const r = await rig(false)
    const res = await r.call('GET', '/v1/chat/sessions')
    expect(res.status).toBe(501)
  })

  it('**没有公开访客端点**：这几条一律要凭据（公网端点属于托管档 B 期）', async () => {
    const r = await rig()
    for (const [method, path] of [
      ['POST', '/v1/chat/sessions'],
      ['GET', '/v1/chat/sessions'],
      ['GET', '/v1/chat/sessions/cs_0001/messages'],
      ['POST', '/v1/chat/sessions/cs_0001/messages'],
      ['GET', '/v1/chat/sessions/cs_0001/stream'],
    ] as const) {
      const res = await r.call(method, path, method === 'POST' ? { text: 'hi' } : undefined, false)
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  /**
   * WP60 之后 `/v1/chat` 下面有两组，**各自的鉴权写死在这里**：
   *
   * - 登录态那几条（会话、接管、教 AI、widget 设置）一律 `bearer` + Assignment；
   * - 公开访客那几条（建会话、发一句、SSE、widget 配置与脚本）一律 `public`
   *   ——它们的门是 Origin 白名单 + 限流 + 访客令牌，不是工作区凭据。
   *
   * 这条断言的价值在于**一条新路由加错组就红**：把访客那条写成 bearer，
   * widget 就永远连不上；把商家那条写成 public，白名单就成了摆设。
   */
  it('OpenAPI 里每条 /v1/chat 路由的鉴权分组都对得上', async () => {
    const r = await rig()
    const chat = r.gateway.specs.filter((s) => s.path.startsWith('/v1/chat'))
    const grouped = Object.fromEntries(chat.map((s) => [`${s.method} ${s.path}`, s.auth]))
    expect(grouped).toEqual({
      'post /v1/chat/sessions': 'bearer',
      'get /v1/chat/sessions': 'bearer',
      'get /v1/chat/sessions/:id/messages': 'bearer',
      'post /v1/chat/sessions/:id/messages': 'bearer',
      'post /v1/chat/sessions/:id/advance': 'bearer',
      'put /v1/chat/sessions/:id/takeover': 'bearer',
      'post /v1/chat/sessions/:id/teach': 'bearer',
      'get /v1/chat/sessions/:id/stream': 'bearer',
      'get /v1/chat/widget/settings': 'bearer',
      'put /v1/chat/widget/settings': 'bearer',
      'get /v1/chat/widget.js': 'public',
      'get /v1/chat/widget-config': 'public',
      'post /v1/chat/public/sessions': 'public',
      'post /v1/chat/public/sessions/:id/messages': 'public',
      'get /v1/chat/public/sessions/:id/stream': 'public',
    })
    expect(chat.every((s) => s.auth === 'public' || s.assignment === true)).toBe(true)
  })

  it('会让 AI 对外说话的那几条过出站急停', async () => {
    const r = await rig()
    r.h.halt.set('outbound', true, 'test')
    const res = await r.call('POST', '/v1/chat/sessions/cs_0001/messages', { text: 'hi' })
    expect(res.status).toBe(503)
    // 读那几条不受影响：停机时还要看得见发生过什么
    expect((await r.call('GET', '/v1/chat/sessions/cs_0001/messages')).status).toBe(200)
  })
})
