/**
 * WP483（决策 1660）：岗位上的「发之前让我看一眼」（默认关）。
 *
 * - `GET /v1/write-review`：这条岗位（`X-Assignment` 所在的岗位）开没开；
 * - `PUT /v1/write-review`：开 / 关。
 *
 * 关着：要批的卡批了，工坊在 ego 里填好就直接点发送、读回、记「已发 · 已记录」；
 * 开着：工坊在 ego 里只填好、把页面留给人点发送。门同全自动：看自己队列的人就能开关自己这条岗位。
 */
import type { MaybePromise, PersonId, WorkspaceId, WriteReviewSetting } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const OWN = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

export interface WriteReviewActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
  role_id: string
}

export interface WriteReviewPort {
  get(actor: WriteReviewActor): MaybePromise<WriteReviewSetting>
  set(actor: WriteReviewActor, on: boolean): MaybePromise<WriteReviewSetting>
}

function portOf(deps: GatewayDeps): WriteReviewPort {
  const p = deps.writeReview
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配「发之前让我看一眼」（GatewayDeps.writeReview）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): WriteReviewActor {
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

export function writeReviewRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/write-review',
        operationId: 'getWriteReview',
        summary: '这条岗位开没开「发之前让我看一眼」（WP483）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: OWN,
        returns: 'WriteReviewSetting',
      },
      async (c, deps) => ok(c, await portOf(deps).get(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/write-review',
        operationId: 'setWriteReview',
        summary: '开 / 关「发之前让我看一眼」（开了：工坊在 ego 里只填好，人自己点发送）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: OWN,
        body: SetBody,
        returns: 'WriteReviewSetting',
      },
      async (c, deps) => {
        const input = await body(c, SetBody)
        try {
          return ok(c, await portOf(deps).set(actorOf(c), input.on))
        } catch (e) {
          if (e instanceof ApiError) throw e
          throw new ApiError('conflict', e instanceof Error ? e.message : String(e))
        }
      },
    ),
  ]
}
