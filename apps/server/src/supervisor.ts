/**
 * WP174（docs/84 §11.1 第 3 条）：服务进程里 `scope_manager` 的审批落到谁。
 *
 * 规矩本身在 `@agentsws/roles` 的 `resolveScopeManager`（纯函数，模拟世界用同一个）：
 * 发起这张卡的职责所在岗位的上级 → 没设 / 是本人 / 已经不在工作区 → 老板。
 * 这里只做服务进程才做得了的三件事：
 *
 * 1. 岗位表从哪来——公司页存的那一份（`org.positions()`），装配晚于各品牌服务，所以是取值函数；
 * 2. 提议者在做哪几个岗位——按分配现算（05 §2：岗位不落库，默认包里的职责都在他名下才算）；
 * 3. 名字——卡上那一句「转给了谁、为什么」要人名，不印 id。
 *
 * 所有用到 `scope_manager` 的服务（公关、建站、社媒、SEO、投放、B2B）都只认这一个口。
 */
import type {
  Assignment,
  OrganizationMode,
  PersonId,
  Recipient,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  hasApprovalFlow,
  resolveScopeManager,
  type ScopeManagerRoute,
  type SupervisedPosition,
  scopeManagerReasonText,
} from '@agentsws/roles'

/** 一张 `scope_manager` 卡要问的三件事。 */
export interface ScopeManagerQuery {
  workspace_id: WorkspaceId
  role_id: RoleId
  /** 这张卡是谁的活儿（Agent 起草的卡也按它挂的那条分配的人算）。 */
  proposer: PersonId
}

/** 解析结果：一格收件人（带那一句为什么）+ 原始判断（进事件）。 */
export type ScopeManagerRecipient = Recipient & { route: ScopeManagerRoute }

/** 各服务拿到的那一个口。 */
export type ScopeManagerRouter = (query: ScopeManagerQuery) => Promise<ScopeManagerRecipient>

export interface ScopeManagerRouterOptions {
  /** 公司页存的岗位（带上级）。装配晚于各品牌服务：还没装好就当没有岗位。 */
  positions(): readonly SupervisedPosition[]
  /** 这个人在这个工作区的有效分配（未撤销）。 */
  assignments(person_id: PersonId, workspace_id: WorkspaceId): readonly Assignment[]
  /** 这个工作区里还在的人。 */
  activeMembers(workspace_id: WorkspaceId): Promise<readonly PersonId[]>
  owner(workspace_id: WorkspaceId): Promise<PersonId | undefined>
  personName(person_id: PersonId): Promise<string | undefined>
  /**
   * WP275（docs/95 §5）：这个品牌所在组织现在是哪种用法。只有 ③ 公司集体按「上级 → 老板」走；
   * ① 个人 / ② 同事互联一律落回提的人自己（这件事是谁的），卡上不写「转给了…」。
   * 不给按 ③（与以前一样）。
   */
  mode?(workspace_id: WorkspaceId): OrganizationMode | Promise<OrganizationMode>
}

/** WP275：① ② 里的那一格——落回提的人，收件人写 `role_holder`（是他自己的事），不带那句为什么。 */
export function ownRecipient(proposer: PersonId): ScopeManagerRecipient {
  return {
    person: proposer,
    via: 'role_holder',
    route: { person: proposer, via: 'scope_manager', reason: 'own' },
  }
}

export function createScopeManagerRouter(options: ScopeManagerRouterOptions): ScopeManagerRouter {
  return async (query) => {
    const mode = (await options.mode?.(query.workspace_id)) ?? 'company'
    if (!hasApprovalFlow(mode)) return ownRecipient(query.proposer)
    const positions = options.positions()
    const held = options.assignments(query.proposer, query.workspace_id).map((a) => a.role_id)
    const heldBy = positions
      .filter((p) => {
        const wanted = p.roles.filter((r) => r.default).map((r) => r.role)
        return wanted.length > 0 && wanted.every((r) => held.includes(r))
      })
      .map((p) => p.id)
    const active = new Set(await options.activeMembers(query.workspace_id))
    // 没有老板（不该发生）就落回提的人自己：宁可自己看见，也不要一张卡谁都看不见
    const owner = (await options.owner(query.workspace_id)) ?? query.proposer
    const route = resolveScopeManager({
      role_id: query.role_id,
      proposer: query.proposer,
      owner,
      positions,
      heldBy,
      isActive: (p) => active.has(p),
    })
    const position = positions.find((p) => p.id === route.position_id)
    const name = await options.personName(route.person)
    const reason = scopeManagerReasonText(route, {
      ...(name === undefined ? {} : { person: name }),
      ...(position?.name === undefined ? {} : { position: position.name.zh }),
    })
    return { person: route.person, via: route.via, reason, route }
  }
}

/** 进 `ledger.stage` / `approvals.create` 的那一格：去掉内部的 `route`。 */
export const recipientOf = (r: ScopeManagerRecipient): Recipient => ({
  person: r.person,
  via: r.via,
  ...(r.reason === undefined || r.reason === '' ? {} : { reason: r.reason }),
  ...(r.reconfirm === true ? { reconfirm: true } : {}),
})
