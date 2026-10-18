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
 * - WP403：订单附件——传一份补材料（multipart，字段 `file`；「等你补材料」时传 = 补上了）、取一份附件（文件流）。
 *   追加费用走卡（`service_order` 的 `stage: 'extra'`），这里没有花钱的口。
 *
 * 权限与「工作」那一组同一档（`approval.read@own`）：都是本人对自己这几单说话。
 */
import {
  type MaybePromise,
  SERVICE_ATTACHMENT_LIMITS,
  type ServiceOrderAttachment,
  type ServiceOrderMessage,
  type ServiceOrderView,
  type WorkshopServiceCatalogView,
  type WorkshopServiceOrderDetail,
  type WorkshopServiceOrdersView,
  type WorkshopServiceReplyDraft,
  type WorkshopServiceStartInput,
  type WorkshopServiceStartResult,
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
  /** WP403：传一份补材料（没装配 = 回 not_implemented）。 */
  uploadAttachment?(
    actor: WorkshopServicesActor,
    id: string,
    file: { name: string; content_type?: string; bytes: Uint8Array },
  ): MaybePromise<ServiceOrderAttachment>
  /** WP403：取一份附件的字节。 */
  attachment?(
    actor: WorkshopServicesActor,
    id: string,
    attachment_id: string,
  ): MaybePromise<{ name: string; content_type: string; sha256?: string; bytes: Uint8Array }>
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
const ATTACHMENT_PARAM: ParamSpec = {
  name: 'attachment_id',
  in: 'path',
  required: true,
  description: '附件号',
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
    route(
      {
        method: 'post',
        path: '/v1/workshop-services/orders/:id/attachments',
        operationId: 'uploadWorkshopServiceAttachment',
        summary:
          'WP403：传一份补材料（multipart，字段 file；单个 25 MB 以内；只有定制件；在「等你补材料」时传 = 补上了）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM],
        returns: 'ServiceOrderAttachment',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.uploadAttachment === undefined)
          throw new ApiError('not_implemented', '这个服务进程传不了订单附件')
        if (!(c.req.header('content-type') ?? '').includes('multipart/form-data'))
          throw new ApiError('invalid_input', '上传要用 multipart/form-data，字段名 file')
        const max = SERVICE_ATTACHMENT_LIMITS.max_bytes
        const declared = Number(c.req.header('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > max + 64 * 1024)
          throw new ApiError(
            'invalid_input',
            '文件太大了（单个最多 25 MB）。大文件放网盘，在订单里发链接。',
          )
        const form = await c.req.parseBody()
        const file = form.file
        if (!(file instanceof File)) throw new ApiError('invalid_input', 'multipart 里没有 file')
        if (file.size > max)
          throw new ApiError(
            'invalid_input',
            '文件太大了（单个最多 25 MB）。大文件放网盘，在订单里发链接。',
          )
        const out = await port.uploadAttachment(actorOf(c), idOf(param(c, 'id')), {
          name: file.name === '' ? 'file' : file.name,
          ...(file.type === '' ? {} : { content_type: file.type }),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
        return ok(c, out, 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workshop-services/orders/:id/attachments/:attachment_id',
        operationId: 'getWorkshopServiceAttachment',
        summary:
          'WP403：取一份订单附件（你补的材料 / 服务方的交付文件）：文件流，按附件下载（不在页面里直接打开）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: AUTHZ,
        params: [ID_PARAM, ATTACHMENT_PARAM],
        returns: '文件字节（没有这份 / 过了保留期 → 404）',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.attachment === undefined)
          throw new ApiError('not_implemented', '这个服务进程取不了订单附件')
        const aid = (param(c, 'attachment_id') ?? '').trim()
        if (aid === '' || aid.length > 80) throw new ApiError('invalid_input', '附件号不对')
        const got = await port.attachment(actorOf(c), idOf(param(c, 'id')), aid)
        return c.body(got.bytes as unknown as ArrayBuffer, 200, {
          'content-type': got.content_type,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(got.name)}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
          ...(got.sha256 === undefined ? {} : { 'x-content-sha256': got.sha256 }),
        })
      },
    ),
  ]
}
