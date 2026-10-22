/** 05 §4 / 31 §3.1：职责分配与单个 Assignment 的有效配置。 */
import { ApiError } from '../errors.js'
import { assignmentOf, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

/** 看别人的分配 = 策略层读权限；看自己的走自助豁免。 */
const READ = { domain: 'policy', op: 'read', range: 'workspace', sensitivity: 'internal' } as const

export function assignmentRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/assignments',
        operationId: 'listAssignments',
        summary: '某人的职责分配（默认本人）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: (c, rctx) => {
          const person = c.req.query('person')
          return person === undefined || person === rctx.principal?.person_id
        },
        params: [{ name: 'person', in: 'query', description: 'person_id，默认本人' }],
        returns: 'Assignment[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const person = c.req.query('person') ?? p.person_id
        return ok(c, deps.roles.listAssignments(person, { workspace_id: p.workspace_id }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/assignments/:id/effective',
        operationId: 'getEffectiveConfig',
        summary: '单个 Assignment 的有效配置（不做跨 Assignment 并集）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: (c, rctx) => param(c, 'id') === rctx.assignment?.id,
        params: [{ name: 'id', in: 'path', required: true, description: 'assignment_id' }],
        returns: 'EffectiveConfig',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        const target = deps.roles.getAssignment(id)
        if (!target || target.workspace_id !== p.workspace_id)
          throw new ApiError('not_found', `分配不存在：${id}`)
        return ok(c, deps.roles.effectiveConfig(id))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/assignments/:id/reconfirm',
        operationId: 'reconfirmAssignment',
        summary:
          'WP462：职责升了大版本，确认这条分配接着用（只能确认自己的；就地确认卡上那个按钮）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        params: [{ name: 'id', in: 'path', required: true, description: 'assignment_id' }],
        returns: '{ assignment_id, role_id, from, to } | { assignment_id, unchanged: true }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        const target = deps.roles.getAssignment(id)
        // 只确认自己名下的：确认等于"我接着用这条职责的新版本"，替别人点不算数
        if (
          !target ||
          target.workspace_id !== p.workspace_id ||
          target.person_id !== p.person_id ||
          target.revoked_at !== undefined
        )
          throw new ApiError('not_found', `分配不存在：${id}`)
        if (deps.roles.reconfirmAssignment === undefined)
          throw new ApiError('not_implemented', '这个服务进程不支持确认职责升级')
        const out = deps.roles.reconfirmAssignment(id)
        return ok(
          c,
          out === undefined
            ? { assignment_id: id, unchanged: true }
            : { assignment_id: id, ...out },
        )
      },
    ),
  ]
}
