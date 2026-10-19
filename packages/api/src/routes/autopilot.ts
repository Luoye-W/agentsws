/**
 * WP428（决策 1244 改）：**全自动**——够条件 → 建议开；人点了才开，随时能关（通用积木）。
 *
 * - `GET /v1/autopilot`：这条岗位（`X-Assignment`）有哪几类能交给 AI 全自动、开没开、够不够条件；
 * - `PUT /v1/autopilot/:scope`：开 / 关。开要够条件（最近 N 张同类卡都原样批了、没出事），关随时。
 *
 * 判定在 `@agentsws/roles` 的 `evaluateAutopilot`，接线在 `apps/server/src/autopilot.ts`。
 * 门：看自己队列的人就能看、能开关**自己这条岗位**的全自动——开要够条件，而条件就是他自己一张张批出来的。
 */
import type { MaybePromise, PersonId, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const OWN = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

export interface AutopilotActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
  role_id: string
}

/** 一类能全自动的事，在这条岗位上的样子。 */
export interface AutopilotScopeView {
  scope_id: string
  title: string
  /** 开了之后 AI 能多做什么。 */
  grants: string
  /** 开了也不变的（花钱的照旧归额度管）。 */
  keeps: string
  on: boolean
  since?: string
  /** 够不够条件（最近 `needed` 张同类卡都原样批了、没出事）。 */
  eligible: boolean
  streak: number
  needed: number
  /** 一句人话：凭什么 / 还差什么。 */
  why: string
}

export interface AutopilotPort {
  status(actor: AutopilotActor): MaybePromise<AutopilotScopeView[]>
  set(actor: AutopilotActor, scope_id: string, on: boolean): MaybePromise<AutopilotScopeView>
}

function portOf(deps: GatewayDeps): AutopilotPort {
  const p = deps.autopilot
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配全自动（GatewayDeps.autopilot）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): AutopilotActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const SetBody = z.object({ on: z.boolean() })

export function autopilotRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/autopilot',
        operationId: 'getAutopilot',
        summary: '这条岗位有哪几类能交给 AI 全自动、开没开、够不够条件（WP428）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: OWN,
        returns: 'AutopilotScopeView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).status(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/autopilot/:scope',
        operationId: 'setAutopilot',
        summary: '开 / 关这一类的全自动（开要够条件，关随时）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: OWN,
        params: [
          {
            name: 'scope',
            in: 'path',
            required: true,
            description: '哪一类（如 kol.advance_stage）',
          },
        ],
        body: SetBody,
        returns: 'AutopilotScopeView',
      },
      async (c, deps) => {
        const input = await body(c, SetBody)
        try {
          return ok(c, await portOf(deps).set(actorOf(c), param(c, 'scope'), input.on))
        } catch (e) {
          if (e instanceof ApiError) throw e
          throw new ApiError('conflict', e instanceof Error ? e.message : String(e))
        }
      },
    ),
  ]
}
