/**
 * 25 §5 定时与流程面。
 *
 * 三条边界：
 * - **一次请求一个 Assignment**（31 §3.1）：列表默认只回本次绑定的那个岗位；
 *   要看整个工作区的（owner 全局视图，25 §3）得显式 `scope=workspace`。
 * - **谁建的、给谁建的**决定要不要人点头（25 §5）：本人给自己岗位建的直接生效，
 *   给别人岗位建的进队列等那边点头；Agent 建的会写 / 会发的一律进队列（25 §3）。
 *   判定是 `@agentsws/schedule` 的一个纯函数，网关只负责问一句。
 * - **网关里不写业务**（28 §2）：每条路由都只是 `SchedulePort` 某个方法的投影。
 *
 * 鉴权元组沿用 `work.ts` 那一条（`approval.read/own`）：定时任务与事项、待办同一层，
 * 是**本人岗位上的一条承诺**，05 的 scopes 是对业务数据域说的，没有对应的写动作。
 * 真正会产生影响的是到点那一下，它仍然要过 17 的额度、门禁与 14 的审批；给别人岗位
 * 设定时也要那边先点头（下面 `create` 里那条 `scheduled_task` 审批项）。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { DuplicateAck, guardSimilar, recordCatalogNote, triggerKeyOf } from './catalog.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

const TriggerBody = z.union([
  z.object({ kind: z.literal('once'), at: z.string().min(1) }),
  z.object({
    kind: z.literal('interval'),
    every_ms: z.number().int().min(60_000),
    from: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1), tz: z.string().min(1) }),
  z.object({ kind: z.literal('after_event'), event: z.string().min(1) }),
])

const CreateBody = z.object({
  title: z.string().min(1).max(120),
  trigger: TriggerBody,
  /** 到点交给谁做（宿主登记过的名字）；不给就是一条只提醒的定时 */
  handler: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** 给哪个岗位建；不给就是本次绑定的这个 */
  assignment_id: z.string().min(1).optional(),
  /** 到点那一下会做什么：只看 / 要写 / 要发（25 §3 决定要不要人点头） */
  effect: z.enum(['read_only', 'writes', 'sends']).default('read_only'),
  misfire_policy: z.enum(['run_once_now', 'skip']).default('run_once_now'),
  /** 与会话绑定（13 §1.3）：从哪次对话来的 */
  conversation_id: z.string().min(1).optional(),
  /**
   * 40 §2.2「建之前先查」：不给就先查，查到像的回 `409 similar_exists` + 候选；
   * 人在选择题卡上选了"我这个不一样，仍新建"就带着理由再来一次。
   */
  duplicate_ack: DuplicateAck.optional(),
})

const PatchBody = z
  .object({
    action: z.enum(['pause', 'resume']).optional(),
    trigger: TriggerBody.optional(),
    title: z.string().min(1).max(120).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    misfire_policy: z.enum(['run_once_now', 'skip']).optional(),
  })
  .refine(
    (v) =>
      v.action !== undefined ||
      v.trigger !== undefined ||
      v.title !== undefined ||
      v.params !== undefined ||
      v.misfire_policy !== undefined,
    { message: '至少要改一样（暂停 / 恢复 / 时间 / 标题 / 参数 / 错过策略）' },
  )

const StartWorkflowBody = z.object({
  def_id: z.string().min(1),
  /** 这条流程是围着谁转的：`order:ord_1001` / `creator:c_7` */
  subject: z.string().min(3),
  conversation_id: z.string().min(1).optional(),
  duplicate_ack: DuplicateAck.optional(),
})

const SCOPES = ['position', 'mine', 'workspace'] as const

export function scheduleRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/schedules',
        operationId: 'listSchedules',
        summary: '定时任务列表（默认本岗位；scope=mine 本人全部、workspace 整个工作区）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'scope', in: 'query', description: SCOPES.join(' | ') },
          { name: 'conversation', in: 'query', description: '只看这次对话设的定时（13 §1.3）' },
          { name: 'state', in: 'query', description: '逗号分隔的状态过滤' },
        ],
        returns: 'ScheduledTask[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const port = portOf(deps)
        const scope = c.req.query('scope') ?? 'position'
        if (!(SCOPES as readonly string[]).includes(scope)) {
          throw new ApiError('invalid_input', 'scope 只能是 position / mine / workspace')
        }
        const conversation = c.req.query('conversation')
        const state = c.req.query('state')
        return ok(
          c,
          await port.list({
            workspace_id: p.workspace_id,
            person_id: p.person_id,
            assignment_id: assignment.id,
            scope: scope as 'position' | 'mine' | 'workspace',
            ...(conversation === undefined ? {} : { conversation_id: conversation }),
            ...(state === undefined || state.trim() === ''
              ? {}
              : { state: state.split(',').map((s) => s.trim()) }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/schedules',
        operationId: 'createSchedule',
        summary: '建一条定时任务（本人给自己岗位建的直接生效，给别人建的走审批）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CreateBody,
        returns: 'ScheduledTask',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const port = portOf(deps)
        const input = await body(c, CreateBody)
        // 40 §2.2：保存前先查。触发器是三把钥匙之一——同一个 cron 上挂两条一样的活最常见
        const trigger = triggerKeyOf(input.trigger)
        const guard = await guardSimilar(deps, {
          workspace_id: p.workspace_id,
          kind: 'schedule',
          title: input.title,
          ...(trigger === undefined ? {} : { trigger }),
          ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
        })
        const created = await port.create({
          workspace_id: p.workspace_id,
          person_id: p.person_id,
          assignment_id: assignment.id,
          title: input.title,
          trigger: input.trigger,
          effect: input.effect,
          misfire_policy: input.misfire_policy,
          ...(input.handler === undefined ? {} : { handler: input.handler }),
          ...(input.params === undefined ? {} : { params: input.params }),
          ...(input.assignment_id === undefined
            ? {}
            : { target_assignment_id: input.assignment_id }),
          ...(input.conversation_id === undefined
            ? {}
            : { conversation_id: input.conversation_id }),
        })
        await recordCatalogNote(deps, {
          workspace_id: p.workspace_id,
          entry_id: `schedule:${created.id}`,
          guard,
        })
        return ok(c, created, 201)
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/schedules/:id',
        operationId: 'patchSchedule',
        summary: '暂停 / 恢复 / 改时间（25 §3「人看得见管得了」）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '定时任务 id' }],
        body: PatchBody,
        returns: 'ScheduledTask',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const port = portOf(deps)
        const input = await body(c, PatchBody)
        return ok(
          c,
          await port.update(
            { workspace_id: p.workspace_id, person_id: p.person_id },
            param(c, 'id'),
            input,
          ),
        )
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/schedules/:id',
        operationId: 'deleteSchedule',
        summary: '删掉一条定时任务（记录留着看历史，不再触发）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '定时任务 id' }],
        returns: 'ScheduledTask',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(
          c,
          await portOf(deps).cancel(
            { workspace_id: p.workspace_id, person_id: p.person_id },
            param(c, 'id'),
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/schedules/:id/run-now',
        operationId: 'runScheduleNow',
        summary: '立即运行一次（不动原来的排期）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 到点那一下可能往外发，所以算 send 类：`AGENTSWS_HALT=outbound` 时 503
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '定时任务 id' }],
        returns: '{ task, ok, result?, error? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(
          c,
          await portOf(deps).runNow(
            { workspace_id: p.workspace_id, person_id: p.person_id },
            param(c, 'id'),
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workflows',
        operationId: 'startWorkflow',
        summary: '开一条流程实例（25 §5 `POST /workflows/{def}/start`）；建之前先查',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 流程里可能有 `action` / 发信步骤：`AGENTSWS_HALT=outbound` 时 503
        outbound: true,
        body: StartWorkflowBody,
        returns: 'WorkflowInstance',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const port = portOf(deps)
        if (port.startWorkflow === undefined)
          throw new ApiError('not_implemented', '这个进程没有装流程引擎')
        const input = await body(c, StartWorkflowBody)
        const [type, ...rest] = input.subject.split(':')
        const id = rest.join(':')
        if (type === undefined || type === '' || id === '')
          throw new ApiError('invalid_input', 'subject 要写成 `type:id`')
        const def = await port.workflowDefinition?.(input.def_id)
        // 40 §2.2：流程也走"建之前先查"——同一个定义、同一个对象上开两条是最典型的撞车
        const guard = await guardSimilar(deps, {
          workspace_id: p.workspace_id,
          kind: 'workflow',
          title: def?.name ?? input.def_id,
          trigger: `workflow:${input.def_id}`,
          target: `${type}:${id}`,
          ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
        })
        const started = await port.startWorkflow(
          { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: assignment.id },
          {
            def_id: input.def_id,
            subject: { type, id },
            ...(input.conversation_id === undefined
              ? {}
              : { conversation_id: input.conversation_id }),
          },
        )
        await recordCatalogNote(deps, {
          workspace_id: p.workspace_id,
          entry_id: `workflow:${input.def_id}`,
          guard,
        })
        return ok(c, started, 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workflows',
        operationId: 'listWorkflows',
        summary: '流程实例列表（25 §5 `GET /workflows/instances?subject=&state=`）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'def', in: 'query', description: '流程定义 id' },
          { name: 'state', in: 'query', description: '逗号分隔的状态过滤' },
          { name: 'subject', in: 'query', description: '`type:id`，例如 `order:ord_1001`' },
        ],
        returns: 'WorkflowInstance[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const def = c.req.query('def')
        const state = c.req.query('state')
        const subject = c.req.query('subject')
        let ref: { type: string; id: string } | undefined
        if (subject !== undefined && subject.trim() !== '') {
          const [type, ...rest] = subject.split(':')
          const id = rest.join(':')
          if (type === undefined || type === '' || id === '') {
            throw new ApiError('invalid_input', 'subject 要写成 `type:id`')
          }
          ref = { type, id }
        }
        return ok(
          c,
          await portOf(deps).workflows({
            workspace_id: p.workspace_id,
            ...(def === undefined ? {} : { def_id: def }),
            ...(state === undefined || state.trim() === ''
              ? {}
              : { state: state.split(',').map((s) => s.trim()) }),
            ...(ref === undefined ? {} : { subject: ref }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workflows/:id',
        operationId: 'getWorkflow',
        summary: '一个流程实例（走到哪一步、在等什么、历史）',
        tag: 'schedule',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '实例 id' }],
        returns: 'WorkflowInstance',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const found = await portOf(deps).workflow(
          { workspace_id: p.workspace_id, person_id: p.person_id },
          param(c, 'id'),
        )
        if (found === undefined) throw new ApiError('not_found', '流程实例不存在')
        return ok(c, found)
      },
    ),
  ]
}

/** 没装调度器的发行版：这几条路由回 `not_implemented`，其余照常。 */
function portOf(deps: GatewayDeps) {
  if (deps.schedules === undefined) {
    throw new ApiError('not_implemented', '这个进程没有装调度器')
  }
  return deps.schedules
}
