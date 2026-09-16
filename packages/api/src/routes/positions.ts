/**
 * WP69（54）岗位面：**岗位是任务主入口**。
 *
 * 三条路由，三件事：
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
import type { MaybePromise, PersonId, PositionInstance, WorkspaceId } from '@agentsws/contracts'
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

export interface OpenAtPositionView {
  matter: { id: string; title: string; entry?: string; role_id?: string }
  picked?: { role_id: string; role_name: string; assignment_id: string }
  candidates: RouteCandidateView[]
  ambiguous: boolean
  reason: string
  approval_item_id?: string
  run_id?: string
}

const OpenBody = z.object({
  /** 一句话就够（54 §2：岗位页顶部那个按钮） */
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).optional(),
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
})

const RerouteBody = z.object({ role_id: z.string().min(1) })

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
  /** 手动换职责（换后新的 Run 走新职责，旧 Run 不动）。 */
  reroute(
    actor: PositionActor,
    matter_id: string,
    role_id: string,
  ): MaybePromise<{ matter: { id: string; role_id?: string }; assignment_id: string }>
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
        method: 'post',
        path: '/v1/positions/:id/matters',
        operationId: 'openMatterAtPosition',
        summary:
          '交给这个岗位一件事（54 §2 主入口）：一句话 → 开事项 → 岗位内路由挑职责 → 用那条职责的分配起 Run；拿不准出一张选择卡',
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
        returns: '{ matter, picked?, candidates, ambiguous, reason, approval_item_id?, run_id? }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).open(actorOf(c), param(c, 'id'), await body(c, OpenBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/reroute',
        operationId: 'rerouteMatter',
        summary: '换一条职责来做这件事（54 §2）：换后新的 Run 走新职责，旧 Run 不动',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'matter_id' }],
        body: RerouteBody,
        returns: '{ matter, assignment_id }',
      },
      async (c, deps) => {
        const input = await body(c, RerouteBody)
        return ok(c, await portOf(deps).reroute(actorOf(c), param(c, 'id'), input.role_id))
      },
    ),
  ]
}
