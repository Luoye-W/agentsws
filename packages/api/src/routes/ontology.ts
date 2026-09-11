/**
 * 47 J1 本体登记表的读面：**这条岗位能查什么、能做什么**。
 *
 * 三条边界：
 *
 * 1. **只读**：登记表是生成物（`packages/ontology/ontology.json`），没有写口。
 *    这条路由不碰任何存储，也不返回任何业务数据——它回的是一张目录。
 * 2. **网关里不写业务**（28 §2）：裁剪规则在 `@agentsws/ontology`，
 *    这里只把 05 §4 的 `EffectiveConfig` 递进去（与 `/v1/blocks` 递 deck 投影同一个路子）。
 * 3. **按岗位**：路径上的 id 就是 assignment_id；看自己的那条走自助豁免，
 *    看别人的要策略层读权限（与 `/v1/assignments/:id/effective` 同一套判定）。
 */
import { ontologyFor } from '@agentsws/ontology'
import { ApiError } from '../errors.js'
import { assignmentOf, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const READ = { domain: 'policy', op: 'read', range: 'workspace', sensitivity: 'internal' } as const

export function ontologyRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/ontology',
        operationId: 'getPositionOntology',
        summary: '这条岗位的数据地图：能查什么对象（真源 / 新鲜度 / 范围）、能做什么动作',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: (c, rctx) => param(c, 'id') === rctx.assignment?.id,
        params: [{ name: 'id', in: 'path', required: true, description: 'assignment_id' }],
        returns: 'TailoredOntology',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        const target = deps.roles.getAssignment(id)
        if (!target || target.workspace_id !== p.workspace_id)
          throw new ApiError('not_found', `分配不存在：${id}`)
        const config = deps.roles.effectiveConfig(id)
        return ok(
          c,
          ontologyFor({
            assignment_id: config.assignment_id,
            role_id: config.role_id,
            scopes: config.scopes,
            actions: config.actions ?? [],
          }),
        )
      },
    ),
  ]
}
