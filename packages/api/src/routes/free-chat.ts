/**
 * WP188「随便聊」：像 DeepSeek 网页版一样的自由对话入口。
 *
 * 三条边界，全部在这里与宿主实现（`apps/server/src/free-chat.ts`）兑现：
 * 1. **不开事项、不起岗位运行、没有任何对外动作**：模型手上只有「联网搜索」一个工具（开关开着才挂），
 *    「用公司资料回答」是回答前只读地查一次知识库，不是工具；
 * 2. **会话存本机**，和事项分开；只有本人看得见自己的会话；
 * 3. **计量照常**：每一次模型调用都过模型网关（用途 `free_chat`），积分照常扣，不另写扣费。
 *
 * 发一句（与重新生成）回的是 **SSE**（`text/event-stream`），不是统一信封——与聊天沙盒同一种写法
 * （`fetch` + `ReadableStream`，凭据在头里，不进 URL）。客户端断开 = 停；另有一条 `stop` 兜底。
 */
import type { ArchivedWorkCandidate } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

export interface FreeChatActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

export interface FreeChatSessionView {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/** 联网搜索找到的一条来源。 */
export interface FreeChatSource {
  url: string
  title?: string
}

/** 「用公司资料回答」时引到的一条资料（回答里写成 [1]、[2]）。 */
export interface FreeChatCitation {
  n: number
  fact_card_id: string
  text: string
  /** 这条资料从哪来（人话：文档名 / 谁录的）。 */
  source?: string
}

export interface FreeChatImage {
  mime: string
  /** base64，不带 `data:` 前缀。 */
  data: string
}

export interface FreeChatMessageView {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  images?: FreeChatImage[]
  /** 这条回复用的哪个模型（`provider_id/model` + 人话名字）。 */
  model?: { id: string; label: string; official: boolean }
  /** 花了多少：token 总是有；走官方积分的那条再估一个积分数（以云上账单为准）。 */
  usage?: { input_tokens: number; output_tokens: number; credits?: number }
  sources?: FreeChatSource[]
  citations?: FreeChatCitation[]
  web_search?: boolean
  knowledge?: boolean
  /** 用户中途点了停。 */
  stopped?: boolean
  /** 这一轮没答出来（人话）。 */
  error?: string
  /**
   * WP207：这一轮模型调了只读的 `find_archived_work`，找到的候选（最像的 3–5 个）。
   * 界面上是一排卡片，**人点了哪张才恢复哪张**；模型自己恢复不了任何东西。
   */
  archived_candidates?: ArchivedWorkCandidate[]
}

export interface FreeChatModelChoice {
  /** `provider_id/model`。 */
  id: string
  label: string
  /** 「Agents 工坊云（用积分）」那一条。 */
  official: boolean
  /** 能不能看图（按上一次三步验证）：`unchecked` = 没验证过，照常让贴图。 */
  vision: 'ok' | 'no' | 'unchecked'
}

export interface FreeChatModelsView {
  choices: FreeChatModelChoice[]
  /** 「设置 → 模型」里的默认模型（`provider_id/model`）；一条都没配时没有。 */
  default?: string
  web_search: {
    /** 现在搜得了吗（登录了 DeepSeek 账号或填了 DeepSeek 官方 key，且没被关掉）。 */
    available: boolean
    /** 搜不了时的一句人话。 */
    reason?: string
    /** 一轮回答最多搜几次（照 WP179 每运行上限）。 */
    max_searches: number
  }
  knowledge: { available: boolean }
}

/** SSE 的一帧。 */
export type FreeChatFrame =
  | { type: 'start'; user?: FreeChatMessageView; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'searching'; query: string }
  | { type: 'sources'; sources: FreeChatSource[] }
  | { type: 'notice'; text: string }
  /** WP207：找回归档的候选（卡片，人点选才恢复）。 */
  | { type: 'archived_candidates'; candidates: ArchivedWorkCandidate[] }
  | { type: 'done'; message: FreeChatMessageView; session: FreeChatSessionView }
  | { type: 'error'; message: string }

export interface FreeChatTurnInput {
  session_id: string
  /** 发一句时必有；重新生成时不给（用最后那句用户的话）。 */
  text?: string
  images?: FreeChatImage[]
  model?: string
  web_search?: boolean
  knowledge?: boolean
  regenerate?: boolean
}

export interface FreeChatPort {
  models(actor: FreeChatActor): Promise<FreeChatModelsView>
  sessions(actor: FreeChatActor): Promise<FreeChatSessionView[]>
  create(actor: FreeChatActor, input: { title?: string }): Promise<FreeChatSessionView>
  rename(actor: FreeChatActor, id: string, title: string): Promise<FreeChatSessionView>
  remove(actor: FreeChatActor, id: string): Promise<{ deleted: boolean }>
  messages(actor: FreeChatActor, id: string): Promise<FreeChatMessageView[]>
  /** 说一轮（或重新生成最后一轮）。一帧一帧交给 `sink`；`signal` abort = 停。 */
  turn(
    actor: FreeChatActor,
    input: FreeChatTurnInput,
    sink: (frame: FreeChatFrame) => void,
    signal: AbortSignal,
  ): Promise<void>
  /** 停这条会话正在答的那一轮（客户端断开之外的兜底）。 */
  stop(actor: FreeChatActor, id: string): Promise<{ stopped: boolean }>
}

/** 与「问 AI」同一档：能读自己的队列就能用——随便聊只给本人看，不碰任何对外的东西。 */
const AUTHZ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const TAG = 'free-chat'

/** 一张图最多 5MB（base64 约 6.7M 字符），一次最多 4 张。 */
const MAX_IMAGE_CHARS = 7_000_000
const Image = z.object({
  mime: z.string().regex(/^image\/(png|jpeg|webp|gif)$/),
  data: z.string().min(1).max(MAX_IMAGE_CHARS),
})
const TurnOptions = {
  model: z.string().min(1).max(300).optional(),
  web_search: z.boolean().optional(),
  knowledge: z.boolean().optional(),
}
const SendBody = z.object({
  text: z.string().max(20_000),
  images: z.array(Image).max(4).optional(),
  ...TurnOptions,
})
const RegenerateBody = z.object(TurnOptions)
const CreateBody = z.object({ title: z.string().max(80).optional() })
const RenameBody = z.object({ title: z.string().trim().min(1).max(80) })

const ID = [{ name: 'id', in: 'path' as const, required: true, description: '会话 id' }]

function portOf(deps: GatewayDeps): FreeChatPort {
  const port = deps.freeChat
  if (port === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配随便聊（GatewayDeps.freeChat）')
  return port
}

function actorOf(c: Parameters<Route['handler']>[0]): FreeChatActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

/**
 * 一轮回答的 SSE。宿主一帧一帧往里写；客户端断开 → `cancel` → abort（宿主把已经答出来的那部分
 * 存成"停了"的一条）。宿主跑完（不论成败）流就关。
 */
function turnStream(
  port: FreeChatPort,
  actor: FreeChatActor,
  input: FreeChatTurnInput,
  trace_id: string,
): Response {
  const encoder = new TextEncoder()
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    start(out) {
      let closed = false
      const write = (frame: FreeChatFrame): void => {
        if (closed) return
        try {
          out.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        } catch {
          // 对端先走了：cancel 会 abort，宿主自己收尾
        }
      }
      void port
        .turn(actor, input, write, controller.signal)
        .catch((e: unknown) => {
          write({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        })
        .finally(() => {
          closed = true
          try {
            out.close()
          } catch {
            // 已经关了
          }
        })
    },
    cancel() {
      controller.abort()
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

export function freeChatRoutes(): Route[] {
  const base = { tag: TAG, auth: 'bearer' as const, assignment: true, authz: AUTHZ }
  return [
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/models',
        operationId: 'getFreeChatModels',
        summary:
          '随便聊能选哪些模型（所有已配好的来源，含 Agents 工坊云）、默认哪个、联网搜索与公司资料能不能用',
        returns: 'FreeChatModelsView',
      },
      async (c, deps) => ok(c, await portOf(deps).models(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/sessions',
        operationId: 'listFreeChatSessions',
        summary: '我的随便聊会话（新的在前；只有本人的）',
        returns: 'FreeChatSessionView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).sessions(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions',
        operationId: 'createFreeChatSession',
        summary: '新对话',
        body: CreateBody,
        returns: 'FreeChatSessionView',
      },
      async (c, deps) => {
        const input = await body(c, CreateBody)
        return ok(
          c,
          await portOf(deps).create(actorOf(c), {
            ...(input.title === undefined ? {} : { title: input.title }),
          }),
          201,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'patch',
        path: '/v1/free-chat/sessions/:id',
        operationId: 'renameFreeChatSession',
        summary: '改会话名',
        params: ID,
        body: RenameBody,
        returns: 'FreeChatSessionView',
      },
      async (c, deps) => {
        const input = await body(c, RenameBody)
        return ok(c, await portOf(deps).rename(actorOf(c), param(c, 'id'), input.title))
      },
    ),
    route(
      {
        ...base,
        method: 'delete',
        path: '/v1/free-chat/sessions/:id',
        operationId: 'deleteFreeChatSession',
        summary: '删掉一条会话（连同里面的话）',
        params: ID,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).remove(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/sessions/:id/messages',
        operationId: 'listFreeChatMessages',
        summary: '这条会话里的话（按时间）',
        params: ID,
        returns: 'FreeChatMessageView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).messages(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/messages',
        operationId: 'sendFreeChatMessage',
        summary: '说一句（SSE 流式回：start / delta / searching / sources / done / error）',
        params: ID,
        body: SendBody,
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, SendBody)
        if (input.text.trim() === '' && (input.images ?? []).length === 0)
          throw new ApiError('invalid_input', '说点什么，或者贴一张图')
        return turnStream(
          portOf(deps),
          actor,
          { session_id: param(c, 'id'), ...stripUndefined(input) },
          c.get('rctx').trace_id,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/regenerate',
        operationId: 'regenerateFreeChatReply',
        summary: '重新生成最后一条回复（SSE，同上）',
        params: ID,
        body: RegenerateBody,
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, RegenerateBody)
        return turnStream(
          portOf(deps),
          actor,
          { session_id: param(c, 'id'), regenerate: true, ...stripUndefined(input) },
          c.get('rctx').trace_id,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/stop',
        operationId: 'stopFreeChatReply',
        summary: '停下正在答的那一轮（已经答出来的部分留着）',
        params: ID,
        returns: '{ stopped: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).stop(actorOf(c), param(c, 'id'))),
    ),
  ]
}

/** zod 出来的可选字段是 `T | undefined`；端口的输入不收 `undefined`（exactOptionalPropertyTypes）。 */
function stripUndefined<T extends Record<string, unknown>>(
  v: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = x
  return out as { [K in keyof T]?: Exclude<T[K], undefined> }
}
