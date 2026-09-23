/**
 * 网站在线客服的 API（48 §4 L3 #11）。
 *
 * 两组，两种鉴权，刻意分开：
 *
 * | 组 | 路径 | 谁能进 | 谁在用 |
 * |---|---|---|---|
 * | 登录态（WP57） | `/v1/chat/sessions/*` | Bearer 或会话 cookie | 商家自己：聊天沙盒页、接管、教 AI |
 * | 公开访客（WP60） | `/v1/chat/public/*`、`/v1/chat/widget-config`、`/v1/chat/widget.js` | 无凭据；Origin 白名单 + 限流 + 访客令牌 | 网站聊天窗里的真访客 |
 *
 * WP57 那一版写着"公开访客端点不是还没做，是故意不做"——理由是一条不要凭据就能
 * 写进工作区的路由，放在本地单机档里没有人受益，却让每台机器多一个对外写入口。
 * **那条理由一个字没变**：它现在变成了这一组的四道门（白名单、限流、访客令牌、
 * 凭据不进 URL），而前提变了——值守起来之后这个进程本来就在公网后面
 * （云进程的 `/w/<ws>/*`），聊天窗是托管档卖的东西之一（41 §2.3）。
 *
 * 登录态那五条**一条都没动**。
 *
 * SSE 两条（登录态的 `/sessions/:id/stream` 与访客的 `/public/sessions/:id/stream`）
 * 是这里唯二不返回统一信封的：它们返回的是长连接。**凭据都不进 URL**
 * （20 §3 / 21 §5：URL 会进浏览器历史、反代日志与 Referer）——所以嵌入脚本
 * 用 `fetch` + `ReadableStream` 而不是 `EventSource`（后者塞不进 `Authorization` 头）。
 */
import type { ChatWidgetConfig, ChatWidgetPublicConfig, WorkspaceId } from '@agentsws/contracts'
import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type GatewayEnv, type Route, route } from '../route-spec.js'

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

/** owner 读回来的那一份 widget 配置（多一个"上次改是什么时候"）。 */
export interface ChatWidgetSettings extends ChatWidgetConfig {
  updated_at?: string
}

/** 建一条公开会话的结果。被限流时**不建会话**，只说多少秒之后再来。 */
export type PublicOpenResult =
  | { session_id: string; visitor_token: string }
  | { rate_limited: true; retry_after: number }

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
  /**
   * 「这一轮我说完了，现在就判」：跳过 2 秒静默窗口，立刻判这一轮。
   * 沙盒页发完一句自己点一下，不等真定时器——跳过的只有那个窗口，
   * 分类、涉钱判定、围栏与出卡一个不少。
   */
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

  // ── WP60 聊天窗托管：公开访客那一面 ──────────────────────────────────

  /** owner 读 widget 配置（含来源白名单）。 */
  widgetConfig(): ChatWidgetSettings
  /** owner 改 widget 配置。整张表一次给全（不是逐项 patch）。 */
  setWidgetConfig(input: ChatWidgetConfig): ChatWidgetSettings
  /**
   * 这个 `Origin` 放不放行；放行回原样的 origin（要写进 `Access-Control-Allow-Origin`）。
   * **空白名单 = 全拒**（契约里的默认值）。
   */
  allowedOrigin(origin: string | undefined): string | undefined
  /** 访客那一面看到的配置：**不含白名单**，放不放行由一个布尔说完。 */
  publicWidgetConfig(origin: string | undefined): ChatWidgetPublicConfig
  /** 开一条公开会话（Origin 已经验过）。 */
  openPublic(input: { origin: string }): Promise<PublicOpenResult>
  /** 这把访客令牌配不配这条会话。 */
  verifyVisitor(session_id: string, token: string | undefined): boolean
  /** 嵌入脚本本体（`GET /v1/chat/widget.js`）。 */
  widgetScript(): string

  // ── WP124 转发器：本机连三种部署的那一跳 ────────────────────────────

  /** 转发器设置。密钥只回"存没存"，值不出加密库。 */
  relaySettings(): {
    endpoint?: string
    has_pairing_token: boolean
    has_message_key: boolean
    configured: boolean
  }
  /** 存转发器设置（进本机加密库；给了密钥当场重连）。 */
  setRelaySettings(input: {
    endpoint?: string | null
    pairing_token?: string
    message_key?: string
  }): Promise<{
    endpoint?: string
    has_pairing_token: boolean
    has_message_key: boolean
    configured: boolean
  }>
  /** 测试连接：转发器通没通、本机在不在线，不通给可操作的下一步。 */
  relayTestConnection(): Promise<{ ok: boolean; detail: string; client_state: string }>
  /**
   * 本月对话数与上限。官方托管时从云侧取（取不到就说取不到，不编一个数）；
   * 自建无上限；订阅生效标 `unlimited: true`。
   */
  relayStatus(): Promise<{
    state: string
    online: boolean
    endpoint?: string
    conversations_this_month?: number
    limit?: number
    unlimited?: boolean
    subscribed?: boolean
    offline_messages?: number
  }>

  /**
   * WP66（52 O1）：**按品牌取这一面**。
   *
   * 聊天这几条路由的端口方法都不带 actor（第一个参数是 `session_id` / `person_id`），
   * 所以按 `actor.workspace_id` 分发这件事只能在这里做一次：鉴权过的那几条先
   * `scoped(principal.workspace_id)`，公开访客那几条（widget.js / widget-config /
   * public/*）没有主体可分发，照旧走进程装配的那一份——52 O5「一个值守子进程
   * 一个品牌工作区」，公开聊天窗本来就是那一档。
   *
   * 不实现 = 这个进程只装了一套（单品牌），每一条都走它。
   */
  scoped?(workspace_id: WorkspaceId): Promise<ChatPort>
}

const SendBody = z.object({ text: z.string().min(1).max(4000) })
const TakeoverBody = z.object({ on: z.boolean() })
/**
 * widget 设置。**整张表一次给全**（不是逐项 patch）：这张表小，又是一个
 * "现在到底谁能嵌我"的快照，一次给全才能在界面上看见全貌，也不会因为
 * 两个标签页各改一项而互相覆盖（与 49 M2 的能力开关同一条理由）。
 */
/**
 * WP124：转发器设置。密钥进本机加密库，界面上只回"存没存"；
 * `endpoint` 给 `null` 表示清除（切回"不转发"）。
 */
const RelaySettingsBody = z.object({
  endpoint: z.string().min(1).max(500).nullish(),
  pairing_token: z.string().min(8).max(200).optional(),
  message_key: z.string().min(8).max(200).optional(),
})

const WidgetBody = z.object({
  allowed_origins: z.array(z.string().min(1).max(255)).max(50),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '主色要写成 #RRGGBB')
    .optional(),
  greeting: z.string().max(200).optional(),
})

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

/**
 * widget 设置的元组。
 *
 * 与聊天会话那一格（`customer.*@assigned`）**不同**，这是有意的：
 * "允许哪些网站嵌我们的聊天窗"是工作区级的配置，不是某一条会话上的权限——
 * 一个只管自己那几条会话的客服，不该能把一个新域名加进白名单。
 * 所以它与 49 M2 的能力开关、40 的数据后端共用同一格（读 `store_config`、
 * 写 `policy`）。
 */
const WIDGET_READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WIDGET_WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

function portOf(deps: { chat?: ChatPort }): ChatPort {
  if (deps.chat === undefined) {
    throw new ApiError('not_implemented', '这个服务进程没有装在线客服（48 §4 #11）')
  }
  return deps.chat
}

/**
 * WP66：鉴权过的那几条一律经这里取端口——**这是本文件里唯一一处按品牌分发的地方**。
 *
 * 装了多品牌就取这次请求那个品牌的；没装（单品牌）就是原来那一份，一行行为不变。
 */
async function scopedPortOf(
  deps: { chat?: ChatPort },
  c: Parameters<typeof principalOf>[0],
): Promise<ChatPort> {
  const port = portOf(deps)
  return (await port.scoped?.(principalOf(c).workspace_id)) ?? port
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
        return ok(c, await (await scopedPortOf(deps, c)).openSandbox(p.person_id), 201)
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
        return ok(
          c,
          await (await scopedPortOf(deps, c)).sessions(limit === undefined ? {} : { limit }),
        )
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
        const port = await scopedPortOf(deps, c)
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
        const port = await scopedPortOf(deps, c)
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
        const port = await scopedPortOf(deps, c)
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
        const port = await scopedPortOf(deps, c)
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
        const port = await scopedPortOf(deps, c)
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
        const port = await scopedPortOf(deps, c)
        const id = param(c, 'id')
        await requireSession(port, id)
        return sseResponse(port, id, c.get('rctx').trace_id)
      },
    ),

    /* ── WP60 聊天窗托管：商家配置那一面 ──────────────────────────── */

    route(
      {
        method: 'get',
        path: '/v1/chat/widget/settings',
        operationId: 'getChatWidgetSettings',
        summary: '网站聊天窗的设置：允许嵌入的网站、主色、欢迎语',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        // 与 49 M2 的能力开关同一格：**这不是一条会话上的权限**，
        // 是"这个工作区允许哪些网站嵌我们的聊天窗"——工作区级的配置，归所有者
        authz: WIDGET_READ,
        returns: 'ChatWidgetSettings',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, (await scopedPortOf(deps, c)).widgetConfig())
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/chat/widget/settings',
        operationId: 'setChatWidgetSettings',
        summary: '改聊天窗设置（整张表一次给全；空的"允许的网站"= 谁都不放行）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: WIDGET_WRITE,
        body: WidgetBody,
        returns: 'ChatWidgetSettings',
      },
      async (c, deps) => {
        principalOf(c)
        const input = await body(c, WidgetBody)
        return ok(
          c,
          (await scopedPortOf(deps, c)).setWidgetConfig({
            allowed_origins: input.allowed_origins,
            ...(input.accent === undefined ? {} : { accent: input.accent }),
            ...(input.greeting === undefined ? {} : { greeting: input.greeting }),
          }),
        )
      },
    ),

    /* ── WP124 转发器：官方托管 / 自建 / 托管实例三选一 ─────────────── */

    route(
      {
        method: 'get',
        path: '/v1/chat/relay/settings',
        operationId: 'getChatRelaySettings',
        summary: '转发器设置（密钥只回存没存，值不出加密库）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: WIDGET_READ,
        returns: '{ endpoint?, has_pairing_token, has_message_key, configured }',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, (await scopedPortOf(deps, c)).relaySettings())
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/chat/relay/settings',
        operationId: 'setChatRelaySettings',
        summary: '存转发器设置（进本机加密库；填了密钥当场重连）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: WIDGET_WRITE,
        body: RelaySettingsBody,
        returns: '{ endpoint?, has_pairing_token, has_message_key, configured }',
      },
      async (c, deps) => {
        principalOf(c)
        const input = await body(c, RelaySettingsBody)
        return ok(
          c,
          await (await scopedPortOf(deps, c)).setRelaySettings({
            ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
            ...(input.pairing_token === undefined ? {} : { pairing_token: input.pairing_token }),
            ...(input.message_key === undefined ? {} : { message_key: input.message_key }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/relay/test',
        operationId: 'testChatRelay',
        summary: '测试连接：转发器通没通、本机在不在线',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: WIDGET_READ,
        returns: '{ ok, detail, client_state }',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, await (await scopedPortOf(deps, c)).relayTestConnection())
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/relay/status',
        operationId: 'getChatRelayStatus',
        summary: '本月对话数与上限、本机在线状态（官方托管的数字从云侧取）',
        tag: 'chat',
        auth: 'bearer',
        assignment: true,
        authz: WIDGET_READ,
        returns: '{ state, online, endpoint?, conversations_this_month?, limit?, unlimited? }',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, await (await scopedPortOf(deps, c)).relayStatus())
      },
    ),

    /* ── WP60 聊天窗托管：公开访客那一面 ──────────────────────────── */

    route(
      {
        method: 'get',
        path: '/v1/chat/widget.js',
        operationId: 'chatWidgetScript',
        summary: '网站聊天窗的嵌入脚本（公开；vanilla JS，无依赖）',
        tag: 'chat',
        auth: 'public',
        returns: 'text/javascript',
      },
      async (_c, deps) =>
        new Response(portOf(deps).widgetScript(), {
          status: 200,
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'public, max-age=300',
            // 脚本本身谁都能拉（它是公开资源）；能不能建会话由 Origin 白名单说了算
            'access-control-allow-origin': '*',
          },
        }),
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/widget-config',
        operationId: 'chatWidgetPublicConfig',
        summary: '聊天窗的主色与欢迎语（公开；来源不在白名单里就 enabled: false）',
        tag: 'chat',
        auth: 'public',
        returns: 'ChatWidgetPublicConfig',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const origin = port.allowedOrigin(c.req.header('Origin'))
        const view = port.publicWidgetConfig(c.req.header('Origin'))
        return corsJson(c, view, origin)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/public/sessions',
        operationId: 'openPublicChatSession',
        summary: '网站访客开一条会话（公开；Origin 白名单 + 限流，回一把访客令牌）',
        tag: 'chat',
        auth: 'public',
        returns: '{ session_id, visitor_token }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const origin = requireOrigin(port, c.req.header('Origin'))
        const out = await port.openPublic({ origin })
        if ('rate_limited' in out)
          throw new ApiError('budget_exhausted', '有点太快了，稍等一下再试。', {
            status: 429,
            headers: {
              'Retry-After': String(out.retry_after),
              'Access-Control-Allow-Origin': origin,
            },
          })
        return corsJson(c, out, origin, 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/chat/public/sessions/:id/messages',
        operationId: 'sendPublicChatMessage',
        summary: '网站访客说一句（公开；访客令牌走 Authorization 头，不进 URL）',
        tag: 'chat',
        auth: 'public',
        // 这一条会让 AI 对外说话：急停 outbound 时它必须停
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        body: SendBody,
        returns: '{ accepted, retry_after? }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const origin = requireOrigin(port, c.req.header('Origin'))
        const id = requireVisitor(port, c)
        const input = await body(c, SendBody)
        const turn = await port.send({ session_id: id, text: input.text })
        /*
         * 访客只拿到"收到了没有"。
         *
         * **不回 plan、不回 approval_item_id、不回 blocked 的细节**：那几样是
         * 内部判定（这一轮涉不涉钱、要不要转人工、出了哪张卡），端给访客
         * 等于把客服的内心活动播给客户看。回复本身走 SSE 那条流。
         */
        return corsJson(
          c,
          {
            accepted: turn.blocked !== 'rate_limited',
            ...(turn.blocked === 'rate_limited' ? { retry_after: 60 } : {}),
          },
          origin,
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/chat/public/sessions/:id/stream',
        operationId: 'streamPublicChatSession',
        summary: '网站访客这条会话的实时推送（公开 + 访客令牌；SSE）',
        tag: 'chat',
        auth: 'public',
        params: [{ name: 'id', in: 'path', required: true, description: '会话 id' }],
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const origin = requireOrigin(port, c.req.header('Origin'))
        const id = requireVisitor(port, c)
        const res = sseResponse(port, id, c.get('rctx').trace_id, visitorFrame)
        res.headers.set('Access-Control-Allow-Origin', origin)
        res.headers.set('Vary', 'Origin')
        return res
      },
    ),
  ]
}

/**
 * 公开路由的 CORS 回头。
 *
 * `Access-Control-Allow-Origin` 写**原样的 origin**而不是 `*`：这一组带
 * `Authorization` 头，而 `*` 与带凭据的请求在浏览器那边是互斥的。
 * `Vary: Origin` 是给中间缓存看的——少了它，一个来源的响应会被喂给另一个来源。
 */
function corsJson(
  c: Context<GatewayEnv>,
  data: unknown,
  origin: string | undefined,
  status = 200,
): Response {
  const res = ok(c, data, status as 200)
  if (origin !== undefined) {
    res.headers.set('Access-Control-Allow-Origin', origin)
    res.headers.set('Vary', 'Origin')
  }
  return res
}

/** 来源不在白名单里：403 + 一句人话。**空白名单 = 全拒**（不是全放）。 */
function requireOrigin(port: ChatPort, raw: string | undefined): string {
  const origin = port.allowedOrigin(raw)
  if (origin === undefined)
    throw new ApiError(
      'forbidden',
      '这个网站还没被允许嵌入这个聊天窗。去工作台的连接页把它加进"允许的网站"。',
    )
  return origin
}

/** 访客令牌对不上：401。与"会话不存在"回同一句话——不给探测 session_id 的口。 */
function requireVisitor(port: ChatPort, c: Context<GatewayEnv>): string {
  const id = param(c, 'id')
  const raw = c.req.header('Authorization')
  const token =
    raw === undefined ? undefined : raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim()
  if (!port.verifyVisitor(id, token))
    throw new ApiError('unauthenticated', '这条会话不认识你。刷新页面重新开一条。')
  return id
}

/**
 * 推给访客的那一帧要不要放行。
 *
 * 只放 `message`（而且只放不是访客自己说的那几条）与 `typing`。
 * **`session` 帧不放**：它带的是"人工接管开关翻了没有"——访客不该知道
 * 现在回他的是 AI 还是人，那是商家的内部安排。
 */
function visitorFrame(frame: ChatFrame): ChatFrame | undefined {
  if (frame.type === 'typing') return frame
  if (frame.type !== 'message') return undefined
  const message = frame.message as { role?: string } | undefined
  if (message?.role === 'visitor') return undefined
  return frame
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
export function sseResponse(
  port: ChatPort,
  session_id: string,
  trace_id: string,
  /** 访客那条流要过滤掉内部帧；商家那条不给这个参数（全都看得到）。 */
  filter?: (frame: ChatFrame) => ChatFrame | undefined,
): Response {
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
        const out = filter === undefined ? frame : filter(frame)
        if (out === undefined) return
        write(`data: ${JSON.stringify(out)}\n\n`)
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
