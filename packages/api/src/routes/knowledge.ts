/** 19 §6 知识 API（读侧；写只经审批项）。检索按身份过滤下推，网关只转发 actor。 */
import type { DataDomain, FactCard, KnowledgeLayer } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayActor, GatewayDeps, RequestContext } from '../types.js'

const READ = {
  domain: 'knowledge',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const LAYERS = ['fact', 'phrasing', 'policy'] as const
const STATUSES = ['proposed', 'active', 'retired'] as const

const SearchBody = z.object({
  text: z.string().min(1),
  domains: z.array(z.string().min(1)).optional(),
  scope: z
    .array(
      z.object({
        kind: z.enum(['store', 'department', 'account', 'market']),
        id: z.string().min(1),
      }),
    )
    .optional(),
  layers: z.array(z.enum(LAYERS)).optional(),
  k: z.number().int().positive().max(50).optional(),
  precheck: z.boolean().optional(),
})

/** 19 §3：授权（grants / ranges）来自本次 Assignment 的 EffectiveConfig，不做并集。 */
function actorOf(
  deps: GatewayDeps,
  rctx: Required<Pick<RequestContext, 'principal' | 'assignment'>>,
): GatewayActor {
  const config = deps.roles.effectiveConfig(rctx.assignment.id)
  return {
    person_id: rctx.principal.person_id,
    workspace_id: rctx.principal.workspace_id,
    assignment_id: rctx.assignment.id,
    role_id: rctx.assignment.role_id,
    grants: config.scopes,
    ranges: config.ranges,
  }
}

export function knowledgeRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/knowledge/search',
        operationId: 'searchKnowledge',
        summary: '事实卡检索（19 §3 过滤下推）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: SearchBody,
        returns: '{ hits, relevant, matched, missing }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, SearchBody)
        return ok(
          c,
          await deps.knowledge.search({
            text: input.text,
            actor: actorOf(deps, { principal: p, assignment: a }),
            ...(input.domains === undefined
              ? {}
              : { domains: input.domains as (DataDomain | 'company')[] }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.layers === undefined ? {} : { layers: [...input.layers] }),
            ...(input.k === undefined ? {} : { k: input.k }),
            ...(input.precheck === undefined ? {} : { precheck: input.precheck }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/cards',
        operationId: 'listKnowledgeCards',
        summary: '事实卡列表',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'domain', in: 'query', description: '数据域' },
          { name: 'layer', in: 'query', description: 'fact | phrasing | policy' },
          { name: 'status', in: 'query', description: 'proposed | active | retired' },
        ],
        returns: 'FactCard[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const domain = c.req.query('domain')
        const layer = c.req.query('layer')
        const status = c.req.query('status')
        if (layer !== undefined && !(LAYERS as readonly string[]).includes(layer))
          throw new ApiError('invalid_input', 'layer 不合法')
        if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 不合法')
        return ok(
          c,
          await deps.knowledge.cards(
            {
              workspace_id: p.workspace_id,
              ...(domain === undefined ? {} : { domain }),
              ...(layer === undefined ? {} : { layer: layer as KnowledgeLayer }),
              ...(status === undefined ? {} : { status: status as FactCard['status'] }),
            },
            actorOf(deps, { principal: p, assignment: a }),
          ),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/cards/:id',
        operationId: 'getKnowledgeCard',
        summary: '事实卡详情（无权 → 404，不返回脱敏后的存在性）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '事实卡 id' }],
        returns: 'FactCard',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const card = await deps.knowledge.card(
          param(c, 'id'),
          actorOf(deps, { principal: p, assignment: a }),
        )
        if (!card || card.workspace_id !== p.workspace_id)
          throw new ApiError('not_found', '事实卡不存在')
        return ok(c, card)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/health',
        operationId: 'knowledgeHealth',
        summary: '知识健康度（总量 / 沉默 / 过期 / 冲突）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ total, silent, stale, conflicts }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(c, await deps.knowledge.health(p.workspace_id))
      },
    ),
  ]
}
