/**
 * WP276（docs/95 §4.3，决策 241 / 242）：**交给对方**——② 同事互联里把一件事（事项或待办）
 * 交给平级的同事。交出去只是「请你接」：对方收一张卡，点「接下」才换主人，也可以「不接」；
 * 没人理到点自动退回；发起人随时能撤回。
 *
 * 网关只做装配与校验，逻辑在 `@agentsws/work`（交接本身）与 `apps/server`（出卡、改派未定的卡、
 * 选接手人的岗位、通知）。准入与工作模型同一个：能读自己的队列，就能交自己的事、接给自己的事；
 * 「是不是你的」「是不是交给你的」由工作模型逐条判。
 */
import type {
  Handoff,
  Matter,
  MaybePromise,
  PersonId,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 与工作模型同一个准入（`approval.read/own`）。 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

const TAG = 'work'

export interface HandoffActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

export type HandoffKind = 'matter' | 'todo'

/** 一次交接给人看的样子（名字由服务端补，前端不猜、不印 id）。 */
export interface HandoffView {
  kind: HandoffKind
  id: string
  title: string
  handoff: Handoff
  from_label: string
  to_label: string
  /** 事项本身，或待办挂的那件事 */
  matter_id?: string
  /** 到哪了（事项摘要 / 待办备注） */
  summary?: string
  /** 截止（待办的；事项取它最早到期的那条未完待办） */
  due?: string
  /** 做到哪了：「3 条待办做完 1 条」这类一句话（服务端算好） */
  progress?: string
  status: string
}

export interface HandoffLists {
  /** 交给我、等我定的（我这边是一张卡；这里给事项页 / ⌘K 用） */
  to_me: HandoffView[]
  /** 我交出去的：还在等的 + 有了结果我还没点掉的（首页那一行通知） */
  from_me: HandoffView[]
}

/** 「交给同事」那个下拉里的一个人（带忙闲）。 */
export interface ColleagueView {
  person_id: PersonId
  name: string
  /** 手上进行中的几件 */
  in_progress: number
  /** 一句忙闲（「手上 3 件」/「空着」） */
  load: string
  /** 这一位是不是发起人（② 里只用来在团队页上标一个小字） */
  initiator?: boolean
}

export interface HandoffPort {
  /** 交出去（事项或待办）。`to` 必须是这个品牌里还在的同事。 */
  offer(
    actor: HandoffActor,
    kind: HandoffKind,
    id: string,
    input: { to: PersonId; note?: string | undefined },
  ): Promise<HandoffView>
  /** 接下（卡上点「接下」走的是审批那条路；这条给事项页上的按钮与模拟用）。 */
  accept(
    actor: HandoffActor,
    kind: HandoffKind,
    id: string,
    input: { position_id?: string | undefined },
  ): Promise<HandoffView>
  /** 不接（理由可选）。 */
  decline(
    actor: HandoffActor,
    kind: HandoffKind,
    id: string,
    input: { reason?: string | undefined },
  ): Promise<HandoffView>
  /** 撤回（只有发起人）。 */
  withdraw(actor: HandoffActor, kind: HandoffKind, id: string): Promise<HandoffView>
  /** 发起人点掉那一行通知。 */
  seen(actor: HandoffActor, kind: HandoffKind, id: string): MaybePromise<{ ok: true }>
  /** 交给我的 / 我交出去的。`all` = 连已经看过的历史（待办里「我交出去的」那一栏）。 */
  list(actor: HandoffActor, options: { all?: boolean }): Promise<HandoffLists>
  /** 同事名单（带忙闲；不含自己）。 */
  colleagues(actor: HandoffActor): Promise<ColleagueView[]>
  /**
   * WP276（docs/95 §3.6）：我参与过的事项（含时间线）与名下的待办——退出前带走一份副本。
   * 只有本人自己的那一份（事项里有他、待办是他的或他交出去的），不含凭据、不含别人的待办。
   */
  exportMine(actor: HandoffActor): MaybePromise<MyWorkExport>
  /**
   * WP276（决策 238）：② 共用一个余额，**按人显示用量**（这个月、这个品牌、本机记的模型用量），
   * 不设每人上限。只有数字与名字，没有内容。
   */
  peopleUsage?(actor: HandoffActor): MaybePromise<PersonUsageView[]>
}

export interface PersonUsageView {
  person_id: PersonId
  name: string
  /** 这个月调了几次模型 */
  calls: number
  /** 输入 + 输出 token */
  tokens: number
}

export interface MyWorkExport {
  exported_at: string
  matters: { matter: Matter; timeline: { at: string; kind: string; text: string }[] }[]
  todos: Todo[]
}

const KINDS = ['matter', 'todo'] as const

const OfferBody = z.object({
  to: z.string().min(1),
  note: z.string().max(200).optional(),
})
const AcceptBody = z.object({ position_id: z.string().min(1).optional() })
const DeclineBody = z.object({ reason: z.string().max(200).optional() })

function portOf(deps: GatewayDeps): HandoffPort {
  const p = deps.handoff
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配「交给对方」（GatewayDeps.handoff）')
  return p
}

type Ctx = Parameters<typeof param>[0]

function actorOf(c: Ctx): HandoffActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: assignmentOf(c).id }
}

function kindOf(c: Ctx): HandoffKind {
  const raw = param(c, 'kind')
  if (!(KINDS as readonly string[]).includes(raw))
    throw new ApiError('invalid_input', 'kind 只能是 matter / todo')
  return raw as HandoffKind
}

const PARAMS = [
  { name: 'kind', in: 'path', required: true, description: 'matter / todo' },
  { name: 'id', in: 'path', required: true, description: '事项或待办 id' },
] as const

export function handoffRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/handoffs/:kind/:id',
        operationId: 'offerHandoff',
        summary: 'WP276 交给对方：把事项或待办交给同事（对方点接下才换主人；3 天没人理自动退回）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [...PARAMS],
        body: OfferBody,
        returns: '{ handoff: HandoffView }',
      },
      async (c, deps) => {
        const input = await body(c, OfferBody)
        const out = await portOf(deps).offer(actorOf(c), kindOf(c), param(c, 'id'), input)
        return ok(c, { handoff: out }, 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/handoffs/:kind/:id/accept',
        operationId: 'acceptHandoff',
        summary: 'WP276 接下（选用自己哪个岗位做；只有一个就不用给）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [...PARAMS],
        body: AcceptBody,
        returns: '{ handoff: HandoffView }',
      },
      async (c, deps) => {
        const input = await body(c, AcceptBody)
        return ok(c, {
          handoff: await portOf(deps).accept(actorOf(c), kindOf(c), param(c, 'id'), input),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/handoffs/:kind/:id/decline',
        operationId: 'declineHandoff',
        summary: 'WP276 不接（退回发起人，理由可选）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [...PARAMS],
        body: DeclineBody,
        returns: '{ handoff: HandoffView }',
      },
      async (c, deps) => {
        const input = await body(c, DeclineBody)
        return ok(c, {
          handoff: await portOf(deps).decline(actorOf(c), kindOf(c), param(c, 'id'), input),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/handoffs/:kind/:id/withdraw',
        operationId: 'withdrawHandoff',
        summary: 'WP276 撤回（只有发起人；对方那张卡一起收掉）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [...PARAMS],
        returns: '{ handoff: HandoffView }',
      },
      async (c, deps) =>
        ok(c, { handoff: await portOf(deps).withdraw(actorOf(c), kindOf(c), param(c, 'id')) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/handoffs/:kind/:id/seen',
        operationId: 'seenHandoff',
        summary: 'WP276 发起人看过结果了（首页那一行通知不再出）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [...PARAMS],
        returns: '{ ok: true }',
      },
      async (c, deps) => ok(c, await portOf(deps).seen(actorOf(c), kindOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/handoffs',
        operationId: 'listHandoffs',
        summary: 'WP276 交给我的 / 我交出去的（all=1 连看过的历史）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'all', in: 'query', description: '1 = 连已经看过的历史' }],
        returns: 'HandoffLists',
      },
      async (c, deps) => {
        const all = c.req.query('all')
        return ok(c, await portOf(deps).list(actorOf(c), { all: all === '1' || all === 'true' }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/work/mine/export',
        operationId: 'exportMyWork',
        summary: 'WP276 导出我自己的那一份（参与过的事项与时间线、名下的待办）——退出前带走副本',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MyWorkExport',
      },
      async (c, deps) => ok(c, await portOf(deps).exportMine(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/usage/people',
        operationId: 'listPeopleUsage',
        summary: 'WP276 ② 每个人这个月的用量（共用一个余额，按人只显示，不设上限）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ people: PersonUsageView[] }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.peopleUsage === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有按人记用量')
        return ok(c, { people: await port.peopleUsage(actorOf(c)) })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/work/colleagues',
        operationId: 'listColleagues',
        summary: 'WP276 同事名单（带忙闲；不含自己）——「交给同事」的下拉与团队页',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ colleagues: ColleagueView[] }',
      },
      async (c, deps) => ok(c, { colleagues: await portOf(deps).colleagues(actorOf(c)) }),
    ),
  ]
}
