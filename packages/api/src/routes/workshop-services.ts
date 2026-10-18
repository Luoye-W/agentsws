/**
 * WP390（docs/105 §4 / §5 / §7）：**工坊服务**的本机 HTTP 投影（`/v1/workshop-services/*`）。
 *
 * 本机只是转手：服务目录是云上 `GET /v1/services` 的本机缓存；下单 / 验收 / 交换联系方式**都走卡**（`service_order`，
 * 永远 L1——批卡走 `/v1/approvals/:id/decide`，这里一个花钱的口都没有）。这里管的是：
 *
 * - 列服务（账号菜单「工坊服务」、岗位页「这个岗位能用的服务」）；
 * - 「看看」/「交给工坊办」：出价目单，或者让 AI 在对话里问清需求；推荐卡上的「不用」（30 天不推）；
 * - 订单面板：我的订单、一单的全貌（进度、在等你的事、消息、本机账本）、发消息、AI 起草回复（不替你答应加钱或改范围）、
 *   接单之前取消（已付的原路全退）。
 *
 * 权限与「工作」那一组同一档（`approval.read@own`）：都是本人对自己这几单说话。
 */
import type {
  MaybePromise,
  ServiceOrderMessage,
  ServiceOrderView,
  WorkshopServiceCatalogView,
  WorkshopServiceOrderDetail,
  WorkshopServiceOrdersView,
  WorkshopServiceReplyDraft,
  WorkshopServiceStartInput,
  WorkshopServiceStartResult,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type ParamSpec, type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const AUTHZ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

const TAG = 'workshop-services'

export interface WorkshopServicesActor {
  workspace_id: string
  person_id: string
  /** X-Assignment（有就带：卡的收件职责、岗位）。 */
  assignment_id?: string
  role_id?: string
}

export interface WorkshopServicesApiPort {
  catalog(actor: WorkshopServicesActor, refresh: boolean): MaybePromise<WorkshopServiceCatalogView>
  start(
    actor: WorkshopServicesActor,
    input: WorkshopServiceStartInput,
  ): MaybePromise<WorkshopServiceStartResult>
  decline(actor: WorkshopServicesActor, service_id: string): MaybePromise<{ until: string }>
  orders(
    actor: WorkshopServicesActor,
    status: 'open' | 'all',
  ): MaybePromise<WorkshopServiceOrdersView>
  order(actor: WorkshopServicesActor, id: string): MaybePromise<WorkshopServiceOrderDetail>
  postMessage(
    actor: WorkshopServicesActor,
    id: string,
    text: string,
  ): MaybePromise<ServiceOrderMessage>
  draftReply(actor: WorkshopServicesActor, id: string): MaybePromise<WorkshopServiceReplyDraft>
  cancel(actor: WorkshopServicesActor, id: string): MaybePromise<ServiceOrderView>
}

const ServiceId = z.string().min(1).max(120)
const StartBody = z.object({
  service_id: ServiceId,
  matter_id: z.string().min(1).max(80).optional(),
  position_id: z.string().min(1).max(80).optional(),
  from_card: z.string().min(1).max(80).optional(),
})
const DeclineBody = z.object({ service_id: ServiceId })
const MessageBody = z.object({ text: z.string().min(1).max(4000) })

const ID_PARAM: ParamSpec = {
  name: 'id',
  in: 'path',
  required: true,
  description: '订单号',
  schema: { type: 'string' },
}
const REFRESH_PARAM: ParamSpec = {
  name: 'refresh',
  in: 'query',
  description: '`1` = 现在就去云上取一次（不用本机缓存）',
  schema: { type: 'string' },
}
const STATUS_PARAM: ParamSpec = {
  name: 'status',
  in: 'query',
  description: '`open`（默认，没结束的）/ `all`（最近的全部）',
  schema: { type: 'string' },
}

function portOf(deps: GatewayDeps): WorkshopServicesApiPort {
  const p = deps.workshopServices
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配工坊服务（GatewayDeps.workshopServices）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): WorkshopServicesActor {
  const p = principalOf(c)
  const a = c.get('rctx').assignment
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    ...(a === undefined ? {} : { assignment_id: a.id, role_id: a.role_id }),
  }
}

function idOf(raw: string | undefined): string {
  const id = (raw ?? '').trim()
  if (id === '' || id.length > 120) throw new ApiError('invalid_input', '订单号不对')
  return id
}

export function workshopServicesRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/workshop-services',
        operationId: 'listWorkshopServices',
        summary:
          'WP390：工坊服务目录（云上 /v1/services 的本机缓存；云上改了刷新一次，断网用上一份；没关联 / 要重新登录照实说）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [REFRESH_PARAM],
        returns: 'WorkshopServiceCatalogView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).catalog(actorOf(c), c.req.query('refresh') === '1')),
    ),
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/start',
        operationId: 'startWorkshopService',
        summary:
          'WP390：「看看」/「交给工坊办」——标准件出价目单；定制件让 AI 在对话里问清需求（或出需求单）。只出卡，不下单',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        body: StartBody,
        returns: 'WorkshopServiceStartResult',
      },
      async (c, deps) => {
        const input = await body(c, StartBody)
        return ok(
          c,
          await portOf(deps).start(actorOf(c), {
            service_id: input.service_id,
            ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
            ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
            ...(input.from_card === undefined ? {} : { from_card: input.from_card }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/decline',
        operationId: 'declineWorkshopService',
        summary: 'WP390：推荐卡上点「不用」——这项服务在这个品牌 30 天不主动推（记进记忆）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        body: DeclineBody,
        returns: '{ until: string }',
      },
      async (c, deps) => {
        const input = await body(c, DeclineBody)
        return ok(c, await portOf(deps).decline(actorOf(c), input.service_id))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workshop-services/orders',
        operationId: 'listWorkshopServiceOrders',
        summary: 'WP390：我的工坊服务订单（先看一遍云上，报价 / 交付 / 消息顺手出卡、记账）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [STATUS_PARAM],
        returns: 'WorkshopServiceOrdersView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).orders(actorOf(c), c.req.query('status') === 'all' ? 'all' : 'open'),
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/workshop-services/orders/:id',
        operationId: 'getWorkshopServiceOrder',
        summary: 'WP390：一张订单的全貌（进度、在等你的事、消息、本机账本）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM],
        returns: 'WorkshopServiceOrderDetail',
      },
      async (c, deps) => ok(c, await portOf(deps).order(actorOf(c), idOf(param(c, 'id')))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/orders/:id/messages',
        operationId: 'postWorkshopServiceMessage',
        summary:
          'WP390：在订单里说一句（定制件；在「等你补材料」时说话 = 补上了）。标准件没有消息串',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM],
        body: MessageBody,
        returns: 'ServiceOrderMessage',
      },
      async (c, deps) => {
        const input = await body(c, MessageBody)
        return ok(c, await portOf(deps).postMessage(actorOf(c), idOf(param(c, 'id')), input.text))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/orders/:id/draft-reply',
        operationId: 'draftWorkshopServiceReply',
        summary:
          'WP390：AI 帮读懂对方在问什么、起草一句回复（你改了再发；**不替你答应加钱或改范围**）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM],
        returns: 'WorkshopServiceReplyDraft',
      },
      async (c, deps) => ok(c, await portOf(deps).draftReply(actorOf(c), idOf(param(c, 'id')))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/orders/:id/cancel',
        operationId: 'cancelWorkshopServiceOrder',
        summary: 'WP390：接单之前取消（已付的原路全退；接了单只能验收或申请退款）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM],
        returns: 'ServiceOrderView',
      },
      async (c, deps) => ok(c, await portOf(deps).cancel(actorOf(c), idOf(param(c, 'id')))),
    ),
  ]
}
