/**
 * WP323（docs/102 §5，决策 665 / 666 / 667）：**发出记录**与**记录去处** `/v1/outbound/*`。
 *
 * - 发出记录（固定能力）：查、导出（CSV / JSON）、挂后续、对方删了原话。
 * - 记录去处（通用机制）：列出、停 / 开、补写、删。**新建与改不在这里**——用户在岗位里用说话交代，
 *   AI 用工具读表头、出「定规矩」卡，人点「记下」才生效（卡在卡片流里决定，不另设按钮）。
 *
 * 准入：读与「能读自己队列」同一个口径；动去处（停 / 开 / 补写 / 删）给本品牌负责人与 ② 的同事。
 * 逻辑在 `apps/server/src/outbound/`。
 */
import type {
  MaybePromise,
  OutboundRecord,
  OutboundStatus,
  PersonId,
  RecordSinkView,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'internal',
} as const

/** 动去处：② 的同事、或者本品牌持有 `common.owner` 的人。 */
const writeBypass = (
  _c: Parameters<typeof principalOf>[0],
  rctx: { principal?: { person_id: PersonId; workspace_id: WorkspaceId } },
  deps: GatewayDeps,
): boolean => {
  const p = rctx.principal
  if (p === undefined) return false
  if (deps.peerAccess?.(p.workspace_id) === true) return true
  return deps.roles
    .listAssignments(p.person_id, { workspace_id: p.workspace_id })
    .some((a) => a.role_id === 'common.owner' && a.revoked_at === undefined)
}

export interface OutboundActor {
  workspace_id: WorkspaceId
  person_id: PersonId
}

export interface OutboundListQuery {
  channel?: string
  status?: OutboundStatus
  since?: string
  until?: string
  limit?: number
}

export interface OutboundExportView {
  filename: string
  content: string
  count: number
}

export interface OutboundFollowUpInput {
  parent_external_id: string
  author?: string
  text?: string
  url?: string
  external_id?: string
  at?: string
}

/** 发出记录端口。网关只做装配与校验。 */
export interface OutboundPort {
  list(actor: OutboundActor, query: OutboundListQuery): MaybePromise<OutboundRecord[]>
  export(
    actor: OutboundActor,
    format: 'csv' | 'json',
    query: OutboundListQuery,
  ): MaybePromise<OutboundExportView>
  addFollowUp(
    actor: OutboundActor,
    input: OutboundFollowUpInput,
  ): MaybePromise<OutboundRecord | null>
  counterpartDeleted(actor: OutboundActor, external_id: string): MaybePromise<{ rows: number }>
  sinks(actor: OutboundActor): MaybePromise<RecordSinkView[]>
  pauseSink(actor: OutboundActor, id: string): MaybePromise<RecordSinkView>
  resumeSink(actor: OutboundActor, id: string): MaybePromise<RecordSinkView>
  retrySink(
    actor: OutboundActor,
    id: string,
  ): MaybePromise<{ written: number; sink: RecordSinkView }>
  removeSink(actor: OutboundActor, id: string): MaybePromise<{ removed: true }>
}

function portOf(deps: GatewayDeps): OutboundPort {
  const p = deps.outbound
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配发出记录（GatewayDeps.outbound）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): OutboundActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const STATUSES = ['sent', 'failed', 'deleted'] as const

function queryOf(c: Parameters<typeof principalOf>[0]): OutboundListQuery {
  const channel = c.req.query('channel')?.trim()
  const status = c.req.query('status')?.trim()
  const since = c.req.query('since')?.trim()
  const until = c.req.query('until')?.trim()
  const limit = intParam(c, 'limit')
  if (status !== undefined && status !== '' && !(STATUSES as readonly string[]).includes(status))
    throw new ApiError('invalid_input', 'status 只能是 sent / failed / deleted')
  return {
    ...(channel === undefined || channel === '' ? {} : { channel }),
    ...(status === undefined || status === '' ? {} : { status: status as OutboundStatus }),
    ...(since === undefined || since === '' ? {} : { since }),
    ...(until === undefined || until === '' ? {} : { until }),
    ...(limit === undefined ? {} : { limit: Math.min(limit, 5000) }),
  }
}

const QUERY_PARAMS = [
  { name: 'channel', in: 'query' as const, required: false, description: '只看这个渠道' },
  { name: 'status', in: 'query' as const, required: false, description: 'sent / failed / deleted' },
  { name: 'since', in: 'query' as const, required: false, description: '这之后（ISO 时间）' },
  { name: 'until', in: 'query' as const, required: false, description: '这之前（ISO 时间）' },
  { name: 'limit', in: 'query' as const, required: false, description: '最多几条（默认 200）' },
]
const SINK_PARAM = [{ name: 'id', in: 'path' as const, required: true, description: '去处 id' }]

const FollowUpBody = z.object({
  parent_external_id: z.string().trim().min(1).max(200),
  author: z.string().max(200).optional(),
  text: z.string().max(4000).optional(),
  url: z.string().max(2000).optional(),
  external_id: z.string().max(200).optional(),
  at: z.string().max(40).optional(),
})
const DeletedBody = z.object({ external_id: z.string().trim().min(1).max(200) })

/** 把 zod 出来的可选字段收成 exactOptionalPropertyTypes 认的形状。 */
const defined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export function outboundRoutes(): Route[] {
  const sinkAction = (
    verb: 'pause' | 'resume' | 'retry',
    operationId: string,
    summary: string,
    returns: string,
  ): Route =>
    route(
      {
        method: 'post',
        path: `/v1/outbound/sinks/:id/${verb}`,
        operationId,
        summary,
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: writeBypass,
        params: SINK_PARAM,
        returns,
      },
      async (c, deps) => {
        const port = portOf(deps)
        const id = param(c, 'id')
        const actor = actorOf(c)
        if (verb === 'pause') return ok(c, await port.pauseSink(actor, id))
        if (verb === 'resume') return ok(c, await port.resumeSink(actor, id))
        return ok(c, await port.retrySink(actor, id))
      },
    )
  return [
    route(
      {
        method: 'get',
        path: '/v1/outbound/records',
        operationId: 'listOutboundRecords',
        summary: '发出记录（工坊替你发出去的每一条；新的在前）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: QUERY_PARAMS,
        returns: 'OutboundRecord[]',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c), queryOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/outbound/records/export',
        operationId: 'exportOutboundRecords',
        summary: '导出发出记录（CSV 带 BOM，Excel 直接打开；或 JSON）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'format',
            in: 'query' as const,
            required: false,
            description: 'csv（默认）/ json',
          },
          ...QUERY_PARAMS,
        ],
        returns: '{ filename: string; content: string; count: number }',
      },
      async (c, deps) => {
        const format = c.req.query('format') === 'json' ? 'json' : 'csv'
        return ok(c, await portOf(deps).export(actorOf(c), format, queryOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/outbound/follow-ups',
        operationId: 'addOutboundFollowUp',
        summary: '对方回了我们发出去的某一条（按平台 id 挂到那一行下面；收件箱读取用）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: FollowUpBody,
        returns: 'OutboundRecord | null',
      },
      async (c, deps) => {
        const input = defined(await body(c, FollowUpBody)) as OutboundFollowUpInput
        return ok(c, await portOf(deps).addFollowUp(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/outbound/counterpart-deleted',
        operationId: 'outboundCounterpartDeleted',
        summary: '对方删了原话：我们这边也清掉存的原话，只留「对方已删」（决策 667）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: DeletedBody,
        returns: '{ rows: number }',
      },
      async (c, deps) => {
        const input = await body(c, DeletedBody)
        return ok(c, await portOf(deps).counterpartDeleted(actorOf(c), input.external_id))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/outbound/sinks',
        operationId: 'listRecordSinks',
        summary: '记录去处（你交代过的那几张表：在不在记、写了几条、待补写几条）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RecordSinkView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).sinks(actorOf(c))),
    ),
    sinkAction('pause', 'pauseRecordSink', '停：之后发的不再写进这个去处', 'RecordSinkView'),
    sinkAction('resume', 'resumeRecordSink', '开：接着写', 'RecordSinkView'),
    sinkAction(
      'retry',
      'retryRecordSink',
      '补写：把待补写的再写一次',
      '{ written: number; sink: RecordSinkView }',
    ),
    route(
      {
        method: 'delete',
        path: '/v1/outbound/sinks/:id',
        operationId: 'deleteRecordSink',
        summary: '删一个记录去处（连带清掉它排着的写入；已经写进表里的不动）',
        tag: 'outbound',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: writeBypass,
        params: SINK_PARAM,
        returns: '{ removed: true }',
      },
      async (c, deps) => ok(c, await portOf(deps).removeSink(actorOf(c), param(c, 'id'))),
    ),
  ]
}
