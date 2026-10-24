/**
 * WP510（决策 1515，WP459-T2）：**同事 / 公司模式的收件箱**那几条路。
 *
 * - `POST /v1/inbox/presence`：我现在开着哪一件（心跳），回别人开着哪几件——「X 在看」；
 * - `GET /v1/inbox/team`：收件箱分工（每只邮箱的负责人、多少天没上线算不在、不在时交给谁、同事和上次在线）；
 * - `PUT /v1/inbox/team`：改一项（② 谁都能改；③ 老板 / 管理员）。
 *
 * ① 个人里：心跳什么都不记、回空；分工那一格照实回 `mode: 'solo'`（界面上不出入口）。
 * 逻辑在服务进程（`apps/server/src/team-inbox.ts`），这里只做校验与转交。
 */
import type {
  InboxPresenceView,
  MaybePromise,
  OrganizationMode,
  OwnerRoute,
  PersonId,
  TeamInboxPatch,
  TeamInboxView,
  TeamMember,
} from '@agentsws/contracts'
import { TEAM_INBOX_AWAY_DAYS_MAX, TEAM_INBOX_AWAY_DAYS_MIN } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps, WorkstationActor } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = { ...READ, op: 'stage' } as const

/** 收件箱团队那一面的端口（服务进程按品牌装配）。 */
export interface TeamInboxPort {
  /** 这个品牌现在是哪种用法、有哪些同事（名字、是不是管理员、上次在线）。 */
  team(actor: WorkstationActor): MaybePromise<{ mode: OrganizationMode; members: TeamMember[] }>
  /**
   * 一只邮箱现在该给谁（负责人；都不在 → 兜底的人）。没指定负责人回 `to: []`。
   * `role_id` 给了、兜底是「同岗位的同事」时按它找人。
   */
  ownersOf(actor: WorkstationActor, account: string, role_id?: string): MaybePromise<OwnerRoute>
  view(actor: WorkstationActor): MaybePromise<TeamInboxView>
  update(actor: WorkstationActor, patch: TeamInboxPatch): MaybePromise<TeamInboxView>
  /** 心跳：我开着哪一件；回别人开着哪几件（不含自己）。① 里回空。 */
  presence(actor: WorkstationActor, item: string | null): MaybePromise<InboxPresenceView>
  /** 懒扫：还没定的催促卡按邮箱负责人改派（负责人不在交给兜底的人）。只在 ② / ③ 做事。 */
  sweep?(actor: WorkstationActor): MaybePromise<void>
}

const PresenceBody = z.object({
  item: z.string().min(1).max(300).nullable(),
})

const PatchBody = z
  .object({
    away_days: z
      .number()
      .int()
      .min(TEAM_INBOX_AWAY_DAYS_MIN)
      .max(TEAM_INBOX_AWAY_DAYS_MAX)
      .optional(),
    fallback: z.enum(['admins', 'position']).optional(),
    mailbox: z
      .object({
        account: z.string().min(3).max(320),
        owners: z.array(z.string().min(1).max(120)).max(50),
      })
      .optional(),
  })
  .refine((v) => v.away_days !== undefined || v.fallback !== undefined || v.mailbox !== undefined, {
    message: '至少改一项',
  })

const portOf = (deps: GatewayDeps): TeamInboxPort => {
  if (deps.teamInbox === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配收件箱的团队那一面')
  return deps.teamInbox
}

const actorOf = (c: Parameters<typeof principalOf>[0]): WorkstationActor => {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id as PersonId }
}

export function teamInboxRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/inbox/presence',
        operationId: 'inboxPresence',
        summary:
          '收件箱「谁在看」：我现在开着哪一件（心跳，5 秒一跳、20 秒没跳算离开），回别人开着哪几件（WP510；① 个人回空）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: PresenceBody,
        returns: 'InboxPresenceView',
      },
      async (c, deps) => {
        const input = await body(c, PresenceBody)
        return ok(c, await portOf(deps).presence(actorOf(c), input.item))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/inbox/team',
        operationId: 'getInboxTeam',
        summary:
          '收件箱分工：每只邮箱的负责人、多少天没上线算不在、不在时交给谁、同事与上次在线（WP510，决策 1515）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'TeamInboxView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/inbox/team',
        operationId: 'setInboxTeam',
        summary:
          '改收件箱分工的一项：某只邮箱的负责人 / 多少天没上线算不在 / 不在时交给谁（② 谁都能改，③ 老板 / 管理员；① 个人回 409）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: PatchBody,
        returns: 'TeamInboxView',
      },
      async (c, deps) => {
        const input = await body(c, PatchBody)
        const patch: TeamInboxPatch = {
          ...(input.away_days === undefined ? {} : { away_days: input.away_days }),
          ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
          ...(input.mailbox === undefined ? {} : { mailbox: input.mailbox }),
        }
        return ok(c, await portOf(deps).update(actorOf(c), patch))
      },
    ),
  ]
}
