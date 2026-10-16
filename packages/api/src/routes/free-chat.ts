/**
 * WP188「随便聊」：像 DeepSeek 网页版一样的自由对话入口。
 *
 * 三条边界，全部在这里与宿主实现（`apps/server/src/free-chat.ts`）兑现：
 * 1. **不开事项、不起岗位运行、没有任何对外动作**：模型手上只有「联网搜索」一个工具（开关开着才挂），
 *    「用公司资料回答」是回答前只读地查一次知识库，不是工具；
 * 2. **会话存本机**，和事项分开；只有本人看得见自己的会话；
 * 3. **计量照常**：每一次模型调用都过模型网关（用途 `free_chat`），积分照常扣，不另写扣费。
 *
 * WP343（决策 334 / 859）：随便聊改名「我的助理」（包名 / 路由 / 事件名不动）。第 1 条边界放宽：
 * 模型手上多了四个**只读**工具（各岗位在做什么、今天要我处理的卡、最近发出去的、某件事进展）与
 * 一个**派活**工具——它不自己做，挑好岗位 / 职责、走岗位的交办入口开一件事，那个岗位去办；
 * 改外部的事照旧由那个岗位出审批，助理自己没有任何对外的写口。交出去的事有结果 / 要拍板时
 * 回到这段对话里报一句（`report`）。
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
  /** WP343：用户这句是 `@` 给谁的（「Reddit 运营 · 自家版运营」，只用来显示）。 */
  to?: string
  /** WP343：这一轮交给岗位去做的事（对话里那一行「已交给 X · Y」，点了进那件事）。 */
  dispatches?: FreeChatDispatchView[]
  /** WP343：这一条是交出去的事回来报的一句（不是模型答的，没有 `model` / `usage`）。 */
  report?: FreeChatReportView
  /** WP350：用户这句附上的文本类资料（界面只显示名字与字数；读出来的字只给模型看）。 */
  attachments?: FreeChatAttachment[]
  /** WP350：助理拆好的「我打算这样分」方案卡（人点「就这样」才派、才记）。 */
  fanout?: FreeChatFanoutView
  /** WP350：方案卡确认之后的那张汇总（派了哪几个岗位几件事、各进了几条知识）。 */
  fanout_summary?: FreeChatFanoutSummaryView
}

/** WP350：用户附上的一份文本类资料（.txt / .md / .docx / .pdf / 粘贴的长文本）。 */
export interface FreeChatAttachment {
  name: string
  /** 读出来多少字（读不出 = 0）。 */
  chars: number
  /** 读出来的字（只在服务端会话里留着、进模型时当外部资料围起来；列会话时不回给界面）。 */
  text?: string
  /** 读不出时的一句人话。 */
  unreadable?: string
  /** 像口令 / 密钥的字抹掉了几处（决策 814：只有密钥不经 AI）。 */
  redacted?: number
}

/** WP350：方案卡上的一条。 */
export interface FreeChatFanoutItemView {
  id: string
  /** `task` 要做的事 / `note` 要记住的业务口径 / `memory` 本人的偏好（进助理记忆）。 */
  kind: 'task' | 'note' | 'memory'
  text: string
  why?: string
  due?: string
  /** 原文出处（资料里那一段）。 */
  quote?: string
  position_id?: string
  position_name?: string
  role_id?: string
  duty_name?: string
  /** 要记的那条进品牌公共知识。 */
  brand?: boolean
  /** 归属待定：认不出该归哪个岗位（人在卡上挑；不挑不发）。 */
  unsure?: { reason: string }
  /** 像口令：不进知识、不进记忆。 */
  secret?: boolean
}

/** WP350：助理拆好的方案卡。 */
export interface FreeChatFanoutView {
  /** 这一批的「来源批次」：开出去的事、写进去的知识都带它。 */
  batch_id: string
  title: string
  source: { name: string; kind: 'meeting' | 'document' | 'human' }
  items: FreeChatFanoutItemView[]
  /** 改归属能挑的岗位与职责（本人的）。 */
  positions: { position_id: string; name: string; duties: { role_id: string; name: string }[] }[]
  /** `proposed` 等人点 / `sent` 派好了 / `dismissed` 人说不用了。 */
  status: 'proposed' | 'sent' | 'dismissed'
  at: string
}

/** WP350：方案卡确认之后的汇总。 */
export interface FreeChatFanoutSummaryView {
  batch_id: string
  title: string
  /** 按岗位：几件事（开出来的那几件）、几条知识。 */
  groups: {
    position_id: string
    name: string
    tasks: { matter_id: string; title: string }[]
    notes: number
  }[]
  brand_notes: number
  memories: number
  /** 没发的：勾掉的 / 归属待定的 / 像口令的。 */
  skipped: { dropped: number; unsure: number; secret: number }
  /** 要记的那几条等人确认的那张卡（有要记的才有）。 */
  knowledge_card_id?: string
  /** 开事项 / 写知识里没成的（人话）。 */
  failed?: string[]
  at: string
}

/** WP350：人在方案卡上对一条的改动。 */
export interface FreeChatFanoutEditInput {
  id: string
  drop?: boolean
  position_id?: string
  role_id?: string
  brand?: boolean
  text?: string
}

/** WP343：助理交给岗位的一件事。 */
export interface FreeChatDispatchView {
  matter_id: string
  /** 事项标题。 */
  title: string
  position_id: string
  position_name: string
  /** 判准了职责才有（岗位里还没分的时候没有）。 */
  role_id?: string
  duty_name?: string
  at: string
  /** WP350：同一张方案卡派出去的带同一个来源批次。 */
  batch_id?: string
}

/** WP343：交出去的事回来报一句——做完了 / 要你拍板 / 没做成。 */
export interface FreeChatReportView {
  matter_id: string
  kind: 'done' | 'decide' | 'failed'
  position_name: string
  duty_name?: string
  /** `decide` 那一张卡。 */
  approval_item_id?: string
  /** WP350：这件事是哪一批派出去的（界面按批次聚在一起）。 */
  batch_id?: string
  batch_title?: string
}

/** WP343：输入框下面的一个快捷问题（按当前状态生成，不写死）。 */
export interface AssistantSuggestionView {
  text: string
  /** `cards` 有卡要处理 / `position` 某岗位今天做了什么 / `dispatch` 派活例句 / `create_position` 去建岗位 */
  kind: 'cards' | 'position' | 'dispatch' | 'create_position'
  /** 点了不发话、直接去这一页（`create_position`）。 */
  href?: string
}

/** WP343：输入框里 `@` 能选的一个岗位（与它下面本人持有的职责）。 */
export interface AssistantTargetView {
  position_id: string
  name: string
  duties: { role_id: string; name: string }[]
}

/** WP343：「我的助理」这一层记的一条（本人的，只在助理对话里用；AI 记的可删，删了不再记回来）。 */
export interface AssistantMemoryView {
  id: string
  text: string
  at: string
  written_by: 'ai' | 'person'
}

/** WP343：「我的助理」这一页的状态：快捷问题（≤ 4）与 `@` 能选的岗位。 */
export interface AssistantStateView {
  suggestions: AssistantSuggestionView[]
  targets: AssistantTargetView[]
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
  /** WP343：交给了一个岗位（对话里马上出那一行）。 */
  | { type: 'dispatched'; dispatch: FreeChatDispatchView }
  /** WP350：方案卡摆出来了（人点「就这样」才派）。 */
  | { type: 'fanout'; fanout: FreeChatFanoutView }
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
  /** WP343：输入框里 `@` 选的岗位 / 职责——这句话直接交给它（不经模型挑）。 */
  target?: { position_id: string; role_id?: string; label?: string }
  /** WP350：附上的文本类资料（`data` 是 base64；服务端按扩展名读字）。 */
  files?: { name: string; data: string }[]
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
  /** WP343：快捷问题与 `@` 能选的岗位。可选：没装就是 `not_implemented`。 */
  assistant?(actor: FreeChatActor): Promise<AssistantStateView>
  /** WP343：助理这一层的记忆（本人的）。可选。 */
  memories?(actor: FreeChatActor): Promise<AssistantMemoryView[]>
  /** WP343：删一条助理记忆（只能删自己的；删了 AI 不再记回来）。可选。 */
  forget?(actor: FreeChatActor, id: string): Promise<{ deleted: boolean }>
  /**
   * WP350：方案卡上点了「就这样」（带人改过的几条）→ 扇出：要做的事按岗位各开一件（同一来源批次），
   * 要记的以 `proposed` 写进对应岗位 / 品牌知识库（出处 = 这份资料），个人偏好进助理记忆；
   * 回方案那一条（状态已变）与汇总那一条。`dismiss` = 不用了（什么都不发）。可选。
   */
  fanout?(
    actor: FreeChatActor,
    session_id: string,
    batch_id: string,
    input: { items?: FreeChatFanoutEditInput[]; dismiss?: boolean },
  ): Promise<{ plan: FreeChatMessageView; summary?: FreeChatMessageView }>
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
/** WP350：一份资料最多 5MB（base64 约 6.7M 字符），一次最多 3 份。 */
const FileBody = z.object({
  name: z.string().trim().min(1).max(200),
  data: z.string().min(1).max(MAX_IMAGE_CHARS),
})
const FanoutBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(20),
        drop: z.boolean().optional(),
        position_id: z.string().min(1).max(200).optional(),
        role_id: z.string().min(1).max(200).optional(),
        brand: z.boolean().optional(),
        text: z.string().max(600).optional(),
      }),
    )
    .max(60)
    .optional(),
  dismiss: z.boolean().optional(),
})
const SendBody = z.object({
  text: z.string().max(20_000),
  images: z.array(Image).max(4).optional(),
  /** WP350：附上的文本类资料（.txt / .md / .docx / .pdf）。 */
  files: z.array(FileBody).max(3).optional(),
  ...TurnOptions,
  /** WP343：`@` 选的岗位 / 职责（直接派给它）。 */
  target: z
    .object({
      position_id: z.string().min(1).max(200),
      role_id: z.string().min(1).max(200).optional(),
      label: z.string().min(1).max(120).optional(),
    })
    .optional(),
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
        path: '/v1/free-chat/assistant',
        operationId: 'getAssistantState',
        summary:
          '「我的助理」（WP343）：输入框下面的快捷问题（按状态生成，最多 4 个）与 `@` 能选的岗位 / 职责（本人的）',
        returns: 'AssistantStateView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.assistant === undefined)
          throw new ApiError('not_implemented', '这个服务进程的随便聊没有装「我的助理」')
        return ok(c, await port.assistant(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/memory',
        operationId: 'listAssistantMemory',
        summary: '「我的助理」这一层的记忆（WP343；本人的，AI 记的标出来）',
        returns: 'AssistantMemoryView[]',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.memories === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「我的助理」没有记忆')
        return ok(c, await port.memories(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'delete',
        path: '/v1/free-chat/memory/:id',
        operationId: 'forgetAssistantMemory',
        summary: '删一条「我的助理」记忆（只能删自己的；删了 AI 不再记回来，除非你又明说）',
        params: [{ name: 'id', in: 'path' as const, required: true, description: '记忆 id' }],
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.forget === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「我的助理」没有记忆')
        return ok(c, await port.forget(actorOf(c), param(c, 'id')))
      },
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
        if (
          input.text.trim() === '' &&
          (input.images ?? []).length === 0 &&
          (input.files ?? []).length === 0
        )
          throw new ApiError('invalid_input', '说点什么，或者贴一张图')
        const { target, ...rest } = input
        return turnStream(
          portOf(deps),
          actor,
          {
            session_id: param(c, 'id'),
            ...stripUndefined(rest),
            ...(target === undefined
              ? {}
              : {
                  target: {
                    position_id: target.position_id,
                    ...(target.role_id === undefined ? {} : { role_id: target.role_id }),
                    ...(target.label === undefined ? {} : { label: target.label }),
                  },
                }),
          },
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
        path: '/v1/free-chat/sessions/:id/fanout/:batch',
        operationId: 'confirmAssistantFanout',
        summary:
          '「我的助理」方案卡（WP350）：点「就这样」= 按（改过的）方案扇出——要做的事按岗位各开一件（同一来源批次），要记的以待确认写进岗位 / 品牌知识库（出处 = 这份资料），个人偏好进助理记忆；`dismiss` = 不用了',
        params: [
          ...ID,
          { name: 'batch', in: 'path' as const, required: true, description: '方案卡的来源批次' },
        ],
        body: FanoutBody,
        returns: '{ plan: FreeChatMessageView; summary?: FreeChatMessageView }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.fanout === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「我的助理」不能拆成多份')
        const input = await body(c, FanoutBody)
        return ok(
          c,
          await port.fanout(actorOf(c), param(c, 'id'), param(c, 'batch'), {
            ...(input.items === undefined
              ? {}
              : { items: input.items.map((i) => stripUndefined(i) as FreeChatFanoutEditInput) }),
            ...(input.dismiss === undefined ? {} : { dismiss: input.dismiss }),
          }),
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
