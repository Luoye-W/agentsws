/**
 * WP69（54）岗位面：**岗位是任务主入口**。
 *
 * 三条路由，三件事（WP241 加第四条 `GET /v1/positions/:id/work`，见下）：
 * - `GET /v1/positions/:id`：岗位实体（54 §1）——补齐 `/v1/positions` 列表的形状。
 * - `POST /v1/positions/:id/matters`：交给这个岗位一件事（54 §2 主入口）。
 * - `POST /v1/matters/:id/reroute`：手动换职责。
 *
 * **`:id` 在这三条上与别处不同，值得说清楚。** `/v1/positions/:id/cards|view|records`
 * 里的 `:id` 是 `assignment_id`（36 §3 的"岗位"= 本人持有的那一条），而这里的 `:id` 是
 * **岗位模板 id**（`web-ops`）——54 §1 的岗位实体讲的就是"公司里那个岗位"。两者不会撞：
 * 已有那几条路径后面都还有一段定值（`cards` / `view` / …），这一条是光秃秃的 `:id`。
 * 为了不让人被迫先查一次模板 id，这里**两种都收**：递进来的要是本人持有的某条分配，
 * 就先把它换算成它所属的岗位。
 *
 * 安全上这三条与别处一个标准：
 * - 仍然要 `X-Assignment`（31 §3.1 一次请求一个 Assignment）；
 * - **但路由挑出来的那条职责才是起 Run 用的那一条**——服务端替用户选，选的只能是
 *   他自己名下的（端口里判），所以岗位入口既不并集也不扩权。
 */
import type {
  MaybePromise,
  PersonId,
  PositionInstance,
  PositionWorkView,
  WorkspaceId,
} from '@agentsws/contracts'
import { fitTaskTitle, TASK_TEXT_MAX } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 与工作台面同一个准入：能读自己的队列就能看自己的岗位。 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

export interface PositionActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）；`:id` 给的是分配 id 时也用它换算岗位 */
  assignment_id: string
}

/** 岗位内路由的一条候选（拿不准时原样进选择卡）。 */
export interface RouteCandidateView {
  role_id: string
  role_name: string
  score: number
  why: string[]
}

/** WP287：岗位里问一句，当场的回答。 */
export interface PositionAnswerView {
  /** `answered` / `failed`（`failure` 是人话，可重试）/ `stopped` / `promoted`（要动手，已转成一件事） */
  outcome: 'answered' | 'failed' | 'stopped' | 'promoted'
  text: string
  /** 这次读了哪些东西（人话，最多 3 条） */
  sources: string[]
  failure?: string
}

export interface OpenAtPositionView {
  /** WP287：当场答了（`ask`，不建进行中的事）还是开了一件事（`task`）；老服务端没有这一格 */
  mode?: 'ask' | 'task'
  answer?: PositionAnswerView
  matter: { id: string; title: string; entry?: string; role_id?: string; ask?: boolean }
  picked?: { role_id: string; role_name: string; assignment_id: string }
  candidates: RouteCandidateView[]
  ambiguous: boolean
  reason: string
  approval_item_id?: string
  run_id?: string
}

const OpenBody = z.object({
  /**
   * 一句话就够（54 §2：岗位页顶部那个按钮）。WP259：一大段多行也照收——超过事项标题上限
   * 或多行就按 `fitTaskTitle` 拆（标题取第一句 / 前 40 字加「…」，完整原文进 `summary`，
   * 路由与首轮运行都用完整原文）。
   */
  title: z.string().min(1).max(TASK_TEXT_MAX),
  summary: z.string().max(TASK_TEXT_MAX).optional(),
  /** 附件 / 关联对象引用（订单、客户、文件…），原样钉在事项上 */
  pinned: z
    .array(z.object({ type: z.string().min(1), id: z.string().min(1) }))
    .max(20)
    .optional(),
  /**
   * WP84：从职责自己的 `quick_prompts` 点进来的——职责已经定了，跳过岗位内路由。
   *
   * 入口仍然是岗位入口（事项照样 `entry: 'position'`）；它只是省掉"再猜一遍"。
   * 仍然只能是**这个岗位里、本人名下**的那一条，与 `reroute` 同一把尺子（端口里判）。
   */
  role_id: z.string().min(1).optional(),
  /**
   * WP287：问还是交办。不给 / `auto` = 服务端判（判不准按问，当场答）；`task` = 一定开一件事；
   * `ask` = 一定当场答。
   */
  mode: z.enum(['auto', 'ask', 'task']).optional(),
  /**
   * WP287：不等运行跑完就回——工作台拿到事项 id 立刻进会话线程，回答在线程里出现。
   * 不给 = 跑完才回（老行为；回答在 `answer` 里）。
   */
  detach: z.boolean().optional(),
})

const RerouteBody = z.object({
  role_id: z.string().min(1),
  /** WP237：换完立刻按这件事原来那段话起一次运行（「换成 B」「走 A」按钮） */
  run: z.boolean().optional(),
})

/**
 * 37 / 54 岗位面端口。网关只做装配与校验，逻辑在 `apps/server/src/positions.ts`。
 */
export interface PositionEntryPort {
  /** 岗位实体；`id` 可以是岗位模板 id，也可以是本人持有的一条分配 id。 */
  instance(actor: PositionActor, id: string): MaybePromise<PositionInstance>
  /** 本人持有的岗位（首页只列它们）。 */
  mine(actor: PositionActor): MaybePromise<PositionInstance[]>
  /** 交给这个岗位一件事：开事项 → 岗位内路由 → 用那条职责的分配起 Run。 */
  open(
    actor: PositionActor,
    id: string,
    input: z.infer<typeof OpenBody>,
  ): MaybePromise<OpenAtPositionView>
  /**
   * 手动换职责（换后新的 Run 走新职责，旧 Run 不动）。
   * WP237：`options.run` = 换完立刻起一次运行（回 `run_id`）；还挂着的选择卡跟着定掉。
   */
  reroute(
    actor: PositionActor,
    matter_id: string,
    role_id: string,
    options?: { run?: boolean },
  ): MaybePromise<{
    matter: { id: string; role_id?: string }
    assignment_id: string
    run_id?: string
  }>
  /**
   * WP241（docs/54 §7）：岗位页「工作」——本岗位的事项 + 本人的待办 + 定时 + 排期合成一份。
   * `id` 两种都收（同 `instance`）。可选：没装就是 `not_implemented`，老装配照旧。
   */
  work?(actor: PositionActor, id: string): MaybePromise<PositionWorkView>
  /** WP287：岗位里问的一句「转成一件事」。可选：没装就是 `not_implemented`。 */
  promote?(
    actor: PositionActor,
    matter_id: string,
  ): MaybePromise<{ matter: { id: string; title: string } }>
}

function portOf(deps: GatewayDeps): PositionEntryPort {
  const p = deps.positions
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配岗位面（GatewayDeps.positions）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): PositionActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

export function positionEntryRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/positions/:id',
        operationId: 'getPosition',
        summary:
          '岗位实体（54 §1）：谁在做、展开了哪几条职责（各自的分配）、下面有多少事项与待审卡、岗位层记忆一句话',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: '岗位模板 id（web-ops）；给本人持有的 assignment_id 也认',
          },
        ],
        returns: 'PositionInstance',
      },
      async (c, deps) => ok(c, await portOf(deps).instance(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/work',
        operationId: 'getPositionWork',
        summary:
          '岗位页「工作」（WP241）：本岗位的事项 + 本人的待办 + 定时 + 排期合成一份；每项带所属职责、分组（进行中 / 排着的 / 等别人 / 已完成）、截止或下次时间、最近一句进展、等你的卡',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: '岗位模板 id；给本人持有的 assignment_id 也认',
          },
        ],
        returns: 'PositionWorkView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.work === undefined)
          throw new ApiError('not_implemented', '这个服务进程的岗位面没有装「工作」视图')
        return ok(c, await port.work(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/positions/:id/matters',
        operationId: 'openMatterAtPosition',
        summary:
          '交给这个岗位一件事（54 §2 主入口）：一句话 → 岗位内路由挑职责（WP287 起不再出选择卡）→ 用那条职责的分配起 Run；是问一句的当场答（`mode: ask` + `answer`，不建进行中的事）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: '岗位模板 id；给本人持有的 assignment_id 也认',
          },
        ],
        body: OpenBody,
        returns:
          '{ mode?, answer?, matter, picked?, candidates, ambiguous, reason, approval_item_id?, run_id? }',
      },
      async (c, deps) => {
        const raw = await body(c, OpenBody)
        // WP259：空白拦下（说人话）；超长 / 多行拆成标题 + 完整原文
        if (raw.title.trim() === '')
          throw new ApiError('invalid_input', '说一句要办的事再交出去（现在是空的）')
        const input = fitTaskTitle({ ...raw, title: raw.title.trim() })
        return ok(c, await portOf(deps).open(actorOf(c), param(c, 'id'), input), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/reroute',
        operationId: 'rerouteMatter',
        summary:
          '换一条职责来做这件事（54 §2）：换后新的 Run 走新职责，旧 Run 不动；`run: true` 换完立刻按原话起一次运行（WP237）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        body: RerouteBody,
        returns: '{ matter, assignment_id, run_id? }',
      },
      async (c, deps) => {
        const input = await body(c, RerouteBody)
        return ok(
          c,
          await portOf(deps).reroute(
            actorOf(c),
            param(c, 'id'),
            input.role_id,
            input.run === true ? { run: true } : undefined,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/promote',
        operationId: 'promoteAskMatter',
        summary: '岗位里问的一句「转成一件事」（WP287）：之后它就是一件普通的事，进「进行中」',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        returns: '{ matter: { id, title } }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.promote === undefined)
          throw new ApiError('not_implemented', '这个服务进程转不了（岗位面没有 promote）')
        return ok(c, await port.promote(actorOf(c), param(c, 'id')))
      },
    ),
  ]
}
