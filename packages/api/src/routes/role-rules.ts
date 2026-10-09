/**
 * WP284（决策 275）：**职责规矩里那几句「以后都这样」**——看、改、删。
 *
 * 规矩从哪来：卡上指导选「以后都这样」→ 策略卡 → 有人点了通过 → 宿主落一句（不走这里）。
 * 这里只管落下之后：职责规矩卡与右栏角色面板上那一列，每句能改、能删，留名字。
 *
 * 准入（与角色定位同一个口径）：
 * - **读**：能读自己队列的人都看得见（干这条活的人要知道 AI 照着哪几句在做）。
 * - **改 / 删**：豁免给「② 同事互联里的同事」与「本品牌负责人」；真正的门在端口里——
 *   ① 本人、② 谁都能改（改了同事收「知道了 / 撤回」）、③ 只有老板与管理员。
 */
import type { MaybePromise, PersonId, RoleRuleView, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'internal',
} as const

/** 写豁免：② 的同事、或者本品牌持有 `common.owner` 的人；其余落回原判（端口里再判模式）。 */
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

export interface RoleRulesActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

/** 职责规矩端口。网关只做装配与校验，逻辑在 `apps/server/src/role-rules.ts`。 */
export interface RoleRulesPort {
  /** 这个品牌里这条职责的规矩（按定下的先后）。 */
  list(actor: RoleRulesActor, role_id: string): MaybePromise<RoleRuleView[]>
  /** 改一句（留改的人名字）。 */
  update(
    actor: RoleRulesActor,
    role_id: string,
    rule_id: string,
    text: string,
  ): MaybePromise<RoleRuleView>
  /** 删一句。 */
  remove(actor: RoleRulesActor, role_id: string, rule_id: string): MaybePromise<{ removed: true }>
}

function portOf(deps: GatewayDeps): RoleRulesPort {
  const p = deps.roleRules
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配职责规矩（GatewayDeps.roleRules）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): RoleRulesActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

const TextBody = z.object({ text: z.string().trim().min(1).max(300) })

const PARAMS = [
  { name: 'id', in: 'path' as const, required: true, description: '职责 id' },
  { name: 'rule_id', in: 'path' as const, required: true, description: '规矩 id（rr_*）' },
]

export function roleRuleRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/roles/:id/rules',
        operationId: 'listRoleRules',
        summary: '这条职责的规矩（「以后都这样」批了落下的那几句）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [PARAMS[0] as (typeof PARAMS)[number]],
        returns: 'RoleRuleView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/roles/:id/rules/:rule_id',
        operationId: 'updateRoleRule',
        summary: '改一句职责规矩（① 本人 / ② 谁都能改、同事收通知可撤回 / ③ 老板与管理员）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: writeBypass,
        params: PARAMS,
        body: TextBody,
        returns: 'RoleRuleView',
      },
      async (c, deps) => {
        const input = await body(c, TextBody)
        return ok(
          c,
          await portOf(deps).update(actorOf(c), param(c, 'id'), param(c, 'rule_id'), input.text),
        )
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/roles/:id/rules/:rule_id',
        operationId: 'deleteRoleRule',
        summary: '删一句职责规矩（之后的运行不再带它）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: writeBypass,
        params: PARAMS,
        returns: '{ removed: true }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).remove(actorOf(c), param(c, 'id'), param(c, 'rule_id'))),
    ),
  ]
}
