/**
 * WP120（69 §4）：**角色定位**的三条路由——看、改写、还原。
 *
 * 三条都在 `/v1/personas` 下，`subject` 用两个查询参数表达（`kind` + `id`），
 * 不开 `/v1/positions/:id/persona` 与 `/v1/roles/:id/persona` 两条：
 * 岗位与职责的 persona 是**同一件东西的两层**，两条路径迟早会长出两套语义。
 *
 * 准入：
 * - **读**走自助豁免——持有这条职责（或这个岗位下任一条职责）的人看得见自己的定位。
 *   这一条抄的是 `GET /v1/roles/:id` 的先例（`org.ts` 的 `authzBypass`）：不抄的话
 *   非 owner 一律 403，而右栏面板正是给干活的人看的（36 §10.1 那个已知的坑）。
 * - **写**不豁免：改公司层 persona 要 `policy.stage`，端口里再判一次"只有 owner"。
 *   两道不是重复——tuple authz 答不出"这个人是不是 owner"，端口答得出。
 */
import type { MaybePromise, PersonaSubject, PersonaView, PersonId, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 读：与工作台面同一个准入（能读自己的队列就能看自己岗位的定位）。 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
/** 写：策略层——persona 进系统提示，改它等于改 Agent 对外说什么。 */
const WRITE = { domain: 'policy', op: 'stage', range: 'workspace', sensitivity: 'internal' } as const

export interface PersonaActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

const SUBJECT_KIND = z.enum(['position', 'role'])

const SetBody = z.object({
  kind: SUBJECT_KIND,
  id: z.string().min(1).max(200),
  /** 中英各一份；只给一边时另一边回落包里的原文。 */
  zh: z.string().max(1200).optional(),
  en: z.string().max(1200).optional(),
})

const RevertBody = z.object({ kind: SUBJECT_KIND, id: z.string().min(1).max(200) })

/** 69 §4 角色定位端口。网关只做装配与校验，逻辑在 `apps/server/src/personas.ts`。 */
export interface PersonaPort {
  /** 现在生效的那一份 + 包里的原文（「还原」按钮拿它比）。 */
  view(actor: PersonaActor, subject: PersonaSubject): MaybePromise<PersonaView>
  /** 公司层改写（只有 owner；记一条 `persona.overridden`）。 */
  set(
    actor: PersonaActor,
    subject: PersonaSubject,
    text: { zh?: string; en?: string },
  ): MaybePromise<PersonaView>
  /** 还原成包里的原文（记一条 `persona.reverted`）。 */
  revert(actor: PersonaActor, subject: PersonaSubject): MaybePromise<PersonaView>
}

function portOf(deps: GatewayDeps): PersonaPort {
  const p = deps.personas
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配角色定位面（GatewayDeps.personas）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): PersonaActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

export function personaRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/personas',
        operationId: 'getPersona',
        summary: '一个岗位 / 一条职责的角色定位（现在生效的 + 包里的原文）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'kind', in: 'query', required: true, description: 'position | role' },
          { name: 'id', in: 'query', required: true, description: '岗位模板 id 或职责 id' },
        ],
        returns: 'PersonaView',
      },
      async (c, deps) => {
        const kind = SUBJECT_KIND.safeParse(c.req.query('kind'))
        const id = c.req.query('id') ?? ''
        if (!kind.success || id === '')
          throw new ApiError('invalid_input', 'kind 只能是 position / role，id 不能为空')
        return ok(c, await portOf(deps).view(actorOf(c), { kind: kind.data, id } as PersonaSubject))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/personas',
        operationId: 'setPersona',
        summary: '公司层改写一段角色定位（包里的原文保留，随时可还原）',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SetBody,
        returns: 'PersonaView',
      },
      async (c, deps) => {
        const input = await body(c, SetBody)
        if (input.zh === undefined && input.en === undefined)
          throw new ApiError('invalid_input', '至少要改中文或英文其中一份')
        return ok(
          c,
          await portOf(deps).set(
            actorOf(c),
            { kind: input.kind, id: input.id } as PersonaSubject,
            {
              ...(input.zh === undefined ? {} : { zh: input.zh }),
              ...(input.en === undefined ? {} : { en: input.en }),
            },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/personas/revert',
        operationId: 'revertPersona',
        summary: '还原成包里的原文',
        tag: 'role',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RevertBody,
        returns: 'PersonaView',
      },
      async (c, deps) => {
        const input = await body(c, RevertBody)
        return ok(
          c,
          await portOf(deps).revert(actorOf(c), { kind: input.kind, id: input.id } as PersonaSubject),
        )
      },
    ),
  ]
}
