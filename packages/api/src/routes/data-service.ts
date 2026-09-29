/**
 * WP192（docs/83 §4、docs/75）：官方数据接口统一能力口的 HTTP 投影（本机）。
 *
 * 本机只认**能力**，不认上游：`/v1/data-service/*` 把请求按这项能力的数据来源路由
 * （设置里 `data_source_routing` 的 `data.<能力>`，默认只有「Agents 工坊（用积分）」一级）
 * 转给云上的 `/v1/data/*`，扣的是组织的积分。
 *
 * 权限：看有哪些能力挂 `store_config.read@workspace`（与搜索数据设置那一行同一档）；
 * 真去查 / 提交任务挂 `analytics.read@own`（与搜索数据查询同一档：公开数据、不读写本地记录）。
 * 哪些岗位该接这条来源（B2B 找客户、红人发现、选品、SEO 外链）另排，见 WP192 报告。
 */
import type {
  DataCallResult,
  DataCapabilityList,
  DataTaskItemsPage,
  DataTaskView,
  MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type ParamSpec, type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const QUERY = {
  domain: 'analytics',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

const TAG = 'data-service'

export interface DataServiceActor {
  workspace_id: string
  person_id: string
}

export interface DataServiceApiPort {
  capabilities(actor: DataServiceActor): MaybePromise<DataCapabilityList>
  call(
    actor: DataServiceActor,
    capability: string,
    input: { input: Record<string, unknown>; fresh?: boolean },
  ): MaybePromise<DataCallResult>
  submit(
    actor: DataServiceActor,
    input: {
      capability: string
      input: Record<string, unknown>
      max_items?: number
      idempotency_key?: string
    },
  ): MaybePromise<DataTaskView>
  task(actor: DataServiceActor, id: string): MaybePromise<DataTaskView>
  items(actor: DataServiceActor, id: string, cursor?: string): MaybePromise<DataTaskItemsPage>
  cancel(actor: DataServiceActor, id: string): MaybePromise<DataTaskView>
}

const Capability = z.string().min(1).max(80)
const Input = z.record(z.string(), z.unknown())
const CallBody = z.object({ input: Input, fresh: z.boolean().optional() })
const SubmitBody = z.object({
  capability: Capability,
  input: Input,
  max_items: z.number().int().min(1).max(10_000).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
})

const CAPABILITY_PARAM: ParamSpec = {
  name: 'capability',
  in: 'path',
  required: true,
  description: '能力（如 serp.google）',
  schema: { type: 'string' },
}
const ID_PARAM: ParamSpec = {
  name: 'id',
  in: 'path',
  required: true,
  description: '任务号',
  schema: { type: 'string' },
}
const CURSOR_PARAM: ParamSpec = {
  name: 'cursor',
  in: 'query',
  description: '上一页回的 next_cursor；不给就从头取',
  schema: { type: 'string' },
}

function portOf(deps: GatewayDeps): DataServiceApiPort {
  const p = deps.dataService
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配数据能力口（GatewayDeps.dataService）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): DataServiceActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

function capabilityOf(raw: string | undefined): string {
  const parsed = Capability.safeParse((raw ?? '').trim())
  if (!parsed.success) throw new ApiError('invalid_input', '能力名不对')
  return parsed.data
}

function idOf(raw: string | undefined): string {
  const id = (raw ?? '').trim()
  if (id === '' || id.length > 80) throw new ApiError('invalid_input', '任务号不对')
  return id
}

export function dataServiceRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/data-service/capabilities',
        operationId: 'getDataCapabilities',
        summary:
          'WP192：Agents 工坊官方数据接口能用哪些能力（同步 / 异步、单价、上限、开没开通；不收钱）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'DataCapabilityList',
      },
      async (c, deps) => ok(c, await portOf(deps).capabilities(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/data-service/call/:capability',
        operationId: 'callDataCapability',
        summary:
          'WP192：同步调用一项数据能力（查一次就回）。走官方数据接口时先预扣，命中共享缓存照价收，失败 / 0 条不收',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        params: [CAPABILITY_PARAM],
        body: CallBody,
        returns: 'DataCallResult',
      },
      async (c, deps) => {
        const capability = capabilityOf(param(c, 'capability'))
        const input = await body(c, CallBody)
        return ok(
          c,
          await portOf(deps).call(actorOf(c), capability, {
            input: input.input,
            ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/data-service/tasks',
        operationId: 'submitDataTask',
        summary:
          'WP192：提交一个异步数据任务（按上限条数预扣，跑完按实际条数结算、多扣的退回，失败 / 超时全退）。带同一个 idempotency_key 重发拿回同一个任务',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        body: SubmitBody,
        returns: 'DataTaskView',
      },
      async (c, deps) => {
        const input = await body(c, SubmitBody)
        return ok(
          c,
          await portOf(deps).submit(actorOf(c), {
            capability: input.capability,
            input: input.input,
            ...(input.max_items === undefined ? {} : { max_items: input.max_items }),
            ...(input.idempotency_key === undefined
              ? {}
              : { idempotency_key: input.idempotency_key }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/data-service/tasks/:id',
        operationId: 'getDataTask',
        summary: 'WP192：看一个异步数据任务现在怎么样',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        params: [ID_PARAM],
        returns: 'DataTaskView',
      },
      async (c, deps) => ok(c, await portOf(deps).task(actorOf(c), idOf(param(c, 'id')))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/data-service/tasks/:id/items',
        operationId: 'getDataTaskItems',
        summary: 'WP192：分页取一个异步数据任务的结果（每页最多 100 条；cursor 用上一页回的）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        params: [ID_PARAM, CURSOR_PARAM],
        returns: 'DataTaskItemsPage',
      },
      async (c, deps) => {
        const cursor = c.req.query('cursor')
        return ok(
          c,
          await portOf(deps).items(
            actorOf(c),
            idOf(param(c, 'id')),
            cursor === undefined || cursor === '' ? undefined : cursor,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/data-service/tasks/:id/cancel',
        operationId: 'cancelDataTask',
        summary: 'WP192：取消一个异步数据任务（已经拿到的那几条照收，其余退回）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: QUERY,
        params: [ID_PARAM],
        returns: 'DataTaskView',
      },
      async (c, deps) => ok(c, await portOf(deps).cancel(actorOf(c), idOf(param(c, 'id')))),
    ),
  ]
}
