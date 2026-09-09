/**
 * OpenAPI 3.1 文档由路由声明生成（28 §2「OpenAPI 由契约类型自动生成」）。
 * 请求体 schema 直接来自路由上的 zod（`z.toJSONSchema`），因此文档与校验永远同一份。
 */
import { z } from 'zod'
import { STATUS_BY_CODE } from './errors.js'
import type { Route } from './route-spec.js'

const ERROR_SCHEMA = {
  type: 'object',
  required: ['code', 'message', 'trace_id'],
  properties: {
    code: { type: 'string', enum: Object.keys(STATUS_BY_CODE) },
    message: { type: 'string' },
    details: {},
    trace_id: { type: 'string' },
  },
} as const

/** 28 §2 的统一成功信封。 */
const ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['data', 'trace_id'],
  properties: { data: {}, trace_id: { type: 'string' } },
  description: '统一成功信封；`data` 的形状见每条路由的 `x-returns`',
} as const

/** `/v1/approvals/:id` → `/v1/approvals/{id}` */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? '')
}

interface OpenApiParameter {
  name: string
  in: string
  required: boolean
  description: string
  schema: { type: string }
}

export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: { url: string }[]
  components: Record<string, unknown>
  paths: Record<string, Record<string, unknown>>
  /** WebSocket 那条流没法用 OpenAPI 描述，挂一段 AsyncAPI 2.6 片段（28 §2 / 29 §6）。 */
  'x-asyncapi': Record<string, unknown>
}

/** WS 帧的 schema（29 §6 的 TEXT / TOOL_CALL / STATE / CUSTOM，外加一类 CONTROL）。 */
const WS_FRAME_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      title: 'EventFrame',
      description: '**只有摘要，没有正文**：正文按本人身份去 /v1 取（19 §3 过滤下推）',
      required: ['type', 'id', 'name', 'at'],
      properties: {
        type: { type: 'string', enum: ['TEXT', 'TOOL_CALL', 'STATE', 'CUSTOM'] },
        id: { type: 'string', description: '事件日志 id（ulid）；重连时当 since' },
        name: { type: 'string', description: '事件日志里的原始类型名，如 approval.decided' },
        at: { type: 'string', format: 'date-time' },
        subject: {
          type: 'object',
          required: ['type', 'id'],
          properties: { type: { type: 'string' }, id: { type: 'string' } },
        },
        run_id: { type: 'string' },
        trace_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      title: 'ControlFrame',
      required: ['type', 'name', 'at'],
      properties: {
        type: { type: 'string', const: 'CONTROL' },
        name: { type: 'string', enum: ['ready', 'error', 'halted', 'dropped', 'pong', 'closing'] },
        at: { type: 'string', format: 'date-time' },
        detail: { type: 'object' },
      },
      additionalProperties: false,
    },
  ],
} as const

const WS_CLIENT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      title: 'Subscribe',
      required: ['op', 'assignment_id'],
      properties: {
        op: { type: 'string', const: 'subscribe' },
        assignment_id: { type: 'string', description: '31 §3.1：一次连接一个 Assignment' },
        since: { type: 'string', description: '断线重连补拉：上次收到的最后一条事件 id' },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: '事件类型前缀（approval. / change. …）；不给用默认集合',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      title: 'Ping',
      required: ['op'],
      properties: { op: { type: 'string', const: 'ping' } },
      additionalProperties: false,
    },
  ],
} as const

/**
 * `GET /v1/ws` 的 AsyncAPI 2.6 片段。
 *
 * 第三方前端只靠 `openapi.json` 就能接上事件流：这一段说清了怎么鉴权、发什么、收什么。
 */
export function asyncApiFragment(version: string): Record<string, unknown> {
  return {
    asyncapi: '2.6.0',
    info: {
      title: 'agentsws 事件流',
      version,
      description:
        'WebSocket，路径 `/v1/ws`，子协议 `agentsws.v1`。鉴权与 REST 同一套：同源浏览器靠 HttpOnly ' +
        '会话 cookie（握手请求自带），其他调用方用 `Sec-WebSocket-Protocol: agentsws.v1, ' +
        'agentsws.bearer.<token>`——**token 一次都不进 URL**（20 §3 / 21 §5）。' +
        '连上后先发一帧 subscribe，服务端回 `CONTROL/ready`，之后按 workspace + assignment 推摘要。' +
        '急停 all 期间只推 `halt.changed`。每连接限速，超限合并成一帧 `CONTROL/dropped { count }`，' +
        '客户端据此整体重取。',
    },
    servers: {
      local: { url: '127.0.0.1:4317', protocol: 'ws', description: '本地档只听回环口' },
    },
    channels: {
      '/v1/ws': {
        description: '可见性与 `GET /v1/events` 完全一致：非 owner 只看得到与本岗位相关的。',
        publish: {
          operationId: 'wsSubscribe',
          summary: '客户端 → 服务端',
          message: { name: 'ClientMessage', payload: WS_CLIENT_SCHEMA },
        },
        subscribe: {
          operationId: 'wsFrames',
          summary: '服务端 → 客户端',
          message: { name: 'Frame', payload: WS_FRAME_SCHEMA },
        },
      },
    },
  }
}

export function buildOpenApi(routes: Route[], version: string): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const { spec } of routes) {
    const key = toOpenApiPath(spec.path)
    const parameters: OpenApiParameter[] = []

    for (const name of pathParamNames(spec.path)) {
      const declared = spec.params?.find((p) => p.in === 'path' && p.name === name)
      parameters.push({
        name,
        in: 'path',
        required: true,
        description: declared?.description ?? name,
        schema: { type: declared?.schema?.type ?? 'string' },
      })
    }
    for (const p of spec.params ?? []) {
      if (p.in === 'path') continue
      parameters.push({
        name: p.name,
        in: p.in,
        required: p.required ?? false,
        description: p.description,
        schema: { type: p.schema?.type ?? 'string' },
      })
    }
    if (spec.auth === 'bearer' && spec.assignment)
      parameters.push({
        name: 'X-Assignment',
        in: 'header',
        required: true,
        description: '本次请求绑定的 Assignment（31 §3.1：一次请求一个 Assignment）',
        schema: { type: 'string' },
      })
    if (spec.method === 'post')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: '幂等键；24h 内同键重放原响应（28 §2）',
        schema: { type: 'string' },
      })

    // 成功信封与错误信封都走 `$ref`：一百来条路由 × 六个状态码，内联一份就是几百个副本，
    // 生成出来的 openapi.json 会大到没法读也没法 diff。
    const responses: Record<string, unknown> = {
      '200': {
        description: spec.returns,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
        },
      },
    }
    const errorStatuses = new Set<number>([400, 500])
    if (spec.auth === 'bearer') {
      errorStatuses.add(401)
      errorStatuses.add(429)
    }
    if (spec.authz) errorStatuses.add(403)
    if (spec.path.includes(':')) errorStatuses.add(404)
    if (spec.method === 'post') errorStatuses.add(409)
    if (spec.outbound || spec.auth === 'bearer') errorStatuses.add(503)
    for (const status of [...errorStatuses].sort((a, b) => a - b))
      responses[String(status)] = {
        description: '统一错误信封（28 §2）',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      }

    const operation: Record<string, unknown> = {
      operationId: spec.operationId,
      summary: spec.summary,
      tags: [spec.tag],
      parameters,
      responses,
      ...(spec.auth === 'bearer' ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      ...(spec.authz
        ? {
            'x-authz': spec.authz,
          }
        : {}),
      ...(spec.outbound ? { 'x-halt-scope': 'outbound' } : {}),
      'x-returns': spec.returns,
    }
    if (spec.body)
      operation.requestBody = {
        required: true,
        content: {
          'application/json': { schema: z.toJSONSchema(spec.body, { io: 'input' }) },
        },
      }

    paths[key] = { ...(paths[key] ?? {}), [spec.method]: operation }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'agentsws API',
      version,
      description:
        '唯一入口（28 §2）。所有路径在 /v1 之下；错误统一 { code, message, details, trace_id }。',
    },
    servers: [{ url: 'http://127.0.0.1:4317' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: '会话 / API key / 内部凭据' },
      },
      schemas: {
        Envelope: ENVELOPE_SCHEMA,
        Error: ERROR_SCHEMA,
        WsFrame: WS_FRAME_SCHEMA,
        WsClientMessage: WS_CLIENT_SCHEMA,
      },
    },
    paths,
    'x-asyncapi': asyncApiFragment(version),
  }
}
