/**
 * 网站在线客服的本地 API（48 §4 L3 #11 的本地部分，WP57）。
 *
 * **五条路由全部只对已登录用户开放**。公开访客端点（无凭据、按 Origin 白名单放行、
 * 公网限流）属于托管档（B 期），不在本包——这不是"还没做"，是**故意不做**：
 * 一条不需要凭据就能写进工作区的路由，放在本地单机档里没有任何人受益，
 * 却让每一台跑着 agentsws 的机器多一个对外的写入口。
 *
 * 所以本地档的访客是谁？是**商家自己**：工作台的「聊天沙盒」页在这里开一条会话，
 * 左边扮演访客发消息，右边看 AI 的计划、回复、出的卡与人工接管开关。
 * 真访客要等托管档把 widget 与公网端点接上，那时这几条路由的形状不变，
 * 只是前面多一层 Origin 白名单与匿名会话签发。
 *
 * SSE 那条（`GET /v1/chat/sessions/:id/stream`）是这几条里唯一不返回统一信封的：
 * 它返回的是一条长连接。鉴权与其余路由完全一样（Bearer 或会话 cookie），
 * **凭据不进 URL**（20 §3 / 21 §5：URL 会进浏览器历史、反代日志与 Referer）。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

/** 一条会话在 API 上的样子（比库里的窄：不端 `visitor_id` 这类内部 id 之外的东西）。 */
export interface ChatSessionView {
  id: string
  source: string
  external_session_id: string
  visitor_display?: string
  status: string
  takeover: boolean
  thread_external_id: string
  created_at: string
  updated_at: string
  assist_requested_at?: string
}

export interface ChatMessageView {
  id: string
  role: string
  text: string
  at: string
  plan_action?: string
}

/** 一轮判完之后端给沙盒页看的东西。 */
export interface ChatTurnView {
  session_id: string
  plan?: {
    action: string
    intent: string
    risk: string
    can_auto_reply: boolean
    money_touch: boolean
    missing_info: string[]
    summary: string
    next_question: string
  }
  reply?: string
  approval_item_id?: string
  used_model: boolean
  blocked?: string
}

/** SSE 的一帧（与 `@agentsws/channels` 的 `ChatStreamFrame` 同形）。 */
export type ChatFrame = { type: string } & Record<string, unknown>

/**
 * 聊天面的端口。没装配时这几条路由回 `not_implemented`——
 * 在线客服是一条职责，不是工作台的前提。
 */
export interface ChatPort {
  openSandbox(person_id: string): Promise<ChatSessionView>
  sessions(filter: { limit?: number }): Promise<ChatSessionView[]>
  session(id: string): Promise<ChatSessionView | undefined>
  messages(session_id: string, limit?: number): Promise<ChatMessageView[]>
  /** 访客说一句（沙盒里就是商家自己扮演访客）。 */
  send(input: { session_id: string; text: string }): Promise<ChatTurnView>
  /** 静默窗口到了：把这一轮判完。沙盒页按 `2s` 自己点，不必等真定时器。 */
  advance(session_id: string): Promise<ChatTurnView>
  /** 人工接管开关。 */
  setTakeover(session_id: string, on: boolean): Promise<ChatSessionView>
  /** 商家用中文教 AI 该怎么答。 */
  teach(input: {
    session_id: string
    instruction: string
    scope: 'single_reply' | 'similar_cases' | 'global_rule'
    taught_by: string
  }): Promise<{ outcome: string; reply?: string; sediment: string }>
  /** 访客还在页面上（SSE 挂着时的心跳）。 */
  touch(session_id: string): Promise<void>
  /** 订阅这条会话的推送；返回一个停订阅的函数。 */
  subscribe(session_id: string, listener: (frame: ChatFrame) => void): () => void
}

const SendBody = z.object({ text: z.string().min(1).max(4000) })
const TakeoverBody = z.object({ on: z.boolean() })
const TeachBody = z.object({
  instruction: z.string().min(1).max(2000),
  scope: z.enum(['single_reply', 'similar_cases', 'global_rule']).default('single_reply'),
})

/**
 * 客服岗位读写聊天会话。
 *
 * 域是 `customer`、范围是 `assigned`，与 `dtc.aftersales` 里那条
 * `{ domain: customer, ops: [read, stage], range: assigned }` 同一格——
 * 聊天窗里坐着的就是客户，一条会话落在这条岗位负责的范围里。
 * 写那几条（接管、教 AI）用 `stage`：它们改的是"这条会话之后怎么走"。
 */
const LIVE_CHAT = {
  domain: 'customer',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const

function portOf(deps: { chat?: ChatPort }): ChatPort {
  if (deps.chat === undefined) {
    throw new ApiError('not_implemented', '这个服务进程没有装在线客服（48 §4 #11）')
  }
  return deps.chat
}

async function requireSession(port: ChatPort, id: string): Promise<ChatSessionView> {
  const session = await port.session(id)
  if (session === undefined) throw new ApiError('not_found', `没有这条会话：${id}`)
  return session
}

export function chatRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/chat/sessions',
        operationId: 'openChatSession',
        summary: '开一条聊天沙盒会话（本人；公开访客端点属于托管档）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        returns: 'ChatSessionView',
      },
      async (c, deps) => {
        const p = principalOf(c)
        // 同一个人重复开只拿回同一条（唯一键 `(workspace, source, external_session_id)`）
        return ok(c, await portOf(deps).openSandbox(p.person_id), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/sessions',
        operationId: 'listChatSessions',
        summary: '这个工作区的聊天会话',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        params: [
          { name: 'limit', in: 'query', description: '最多回几条', schema: { type: 'integer' } },
        ],
        returns: 'ChatSessionView[]',
      },
      async (c, deps) => {
        principalOf(c)
        const raw = c.req.query('limit')
        const limit = raw === undefined ? undefined : Number(raw)
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new ApiError('invalid_input', 'limit 必须是正整数')
        }
        return ok(c, await portOf(deps).sessions(limit === undefined ? {} : { limit }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/sessions/:id/messages',
        operationId: 'listChatMessages',
        summary: '一条会话的消息',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        returns: '{ session, messages }',
      },
      async (c, deps) => {
        principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        const session = await requireSession(port, id)
        return ok(c, { session, messages: await port.messages(id) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/sessions/:id/messages',
        operationId: 'sendChatMessage',
        summary: '访客说一句（沙盒里是本人扮演访客）；回这一轮的计划与回复',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        // 这一条会让 AI 对外说话：急停 outbound 时它必须停
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        body: SendBody,
        returns: 'ChatTurnView',
      },
      async (c, deps) => {
        principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        await requireSession(port, id)
        const input = await body(c, SendBody)
        return ok(c, await port.send({ session_id: id, text: input.text }), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/sessions/:id/advance',
        operationId: 'advanceChatTurn',
        summary: '静默窗口到了：把这一轮判完（沙盒页自己点，不等真定时器）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        returns: 'ChatTurnView',
      },
      async (c, deps) => {
        principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        await requireSession(port, id)
        return ok(c, await port.advance(id))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/chat/sessions/:id/takeover',
        operationId: 'setChatTakeover',
        summary: '人工接管开关（开着的时候 AI 一句都不答）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: { ...LIVE_CHAT, op: 'stage' },
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        body: TakeoverBody,
        returns: 'ChatSessionView',
      },
      async (c, deps) => {
        principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        await requireSession(port, id)
        const input = await body(c, TakeoverBody)
        return ok(c, await port.setTakeover(id, input.on))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/sessions/:id/teach',
        operationId: 'teachChatSession',
        summary: '用中文告诉 AI 这种问题该怎么答（对客消息 + 沉淀成知识候选）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: { ...LIVE_CHAT, op: 'stage' },
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        body: TeachBody,
        returns: '{ outcome, reply?, sediment }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        await requireSession(port, id)
        const input = await body(c, TeachBody)
        return ok(
          c,
          await port.teach({
            session_id: id,
            instruction: input.instruction,
            scope: input.scope,
            taught_by: p.person_id,
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/sessions/:id/stream',
        operationId: 'streamChatSession',
        summary: '这条会话的实时推送（SSE；鉴权与其余路由一样，凭据不进 URL）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: LIVE_CHAT,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        principalOf(c)
        const port = portOf(deps)
        const id = param(c, 'id')
        await requireSession(port, id)
        return sseResponse(port, id, c.get('rctx').trace_id)
      },
    ),
  ]
}

/** SSE 心跳周期：15 秒。反向代理的空闲超时通常是 30–60 秒，一条注释行就够把它顶开。 */
export const CHAT_SSE_HEARTBEAT_MS = 15_000

/**
 * 一条 SSE 长连接。
 *
 * 三件事：
 * - 挂上就先推一帧 `ready`，客户端据此知道"订阅生效了"而不是"连上了但还没订上"；
 * - 每 15 秒推一行注释当心跳，顺手把访客标成"还在页面上"（求助超时的 T+3 要它）；
 * - 客户端断开 → `cancel` → 停订阅、清定时器。**不清的话每开一次沙盒页就漏一个订阅者**。
 */
export function sseResponse(port: ChatPort, session_id: string, trace_id: string): Response {
  const encoder = new TextEncoder()
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // 已经关了：`cancel` 还没跑到而对端先走了，忽略即可
        }
      }
      write(`data: ${JSON.stringify({ type: 'ready', session_id })}\n\n`)
      stop = port.subscribe(session_id, (frame) => {
        write(`data: ${JSON.stringify(frame)}\n\n`)
      })
      timer = setInterval(() => {
        void port.touch(session_id)
        write(': keepalive\n\n')
      }, CHAT_SSE_HEARTBEAT_MS)
      timer.unref?.()
    },
    cancel() {
      stop?.()
      stop = undefined
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'X-Trace-Id': trace_id,
    },
  })
}
