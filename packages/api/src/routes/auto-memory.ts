/**
 * WP320：「设置 → 通用」的「自动记忆」开关。
 *
 * - `GET /v1/settings/auto-memory`：`{ enabled }`（默认开）；
 * - `PUT /v1/settings/auto-memory`：改。关了之后 AI 只在人明确说「记住…」时才记。
 *
 * 每个人在每个品牌里一份（AI 是替这个人记的），所以谁都能改自己的那一份。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { AutoMemoryPort, GatewayDeps } from '../types.js'

const READ = { domain: 'skill', op: 'read', range: 'workspace', sensitivity: 'internal' } as const

const TAG = 'settings'

const Body = z.object({ enabled: z.boolean() })

function portOf(deps: GatewayDeps): AutoMemoryPort {
  const p = deps.autoMemory
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配自动记忆（GatewayDeps.autoMemory）')
  return p
}

export function autoMemoryRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/auto-memory',
        operationId: 'getAutoMemory',
        summary: 'WP320「自动记忆」开关（本人在这个品牌里的那一份；默认开）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 改的是本人自己的偏好：谁都能看 / 改自己那一份
        authzBypass: () => true,
        returns: '{ enabled }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(
          c,
          await portOf(deps).get({ person_id: p.person_id, workspace_id: p.workspace_id }),
        )
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/auto-memory',
        operationId: 'putAutoMemory',
        summary: 'WP320 开 / 关「自动记忆」（关了只在人明确说「记住」时记）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        body: Body,
        returns: '{ enabled }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, Body)
        return ok(
          c,
          await portOf(deps).set(
            { person_id: p.person_id, workspace_id: p.workspace_id },
            input.enabled,
          ),
        )
      },
    ),
  ]
}
