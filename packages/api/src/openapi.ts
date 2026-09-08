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

    const responses: Record<string, unknown> = {
      '200': {
        description: spec.returns,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['data', 'trace_id'],
              properties: { data: {}, trace_id: { type: 'string' } },
            },
          },
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
        content: { 'application/json': { schema: ERROR_SCHEMA } },
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
      schemas: { Error: ERROR_SCHEMA },
    },
    paths,
  }
}
