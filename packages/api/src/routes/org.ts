/**
 * 制度面（WP28 交付 A）：05 的职责 / 岗位 / 分配 / 策略层 + 20 的成员与邀请。
 *
 * 在这之前，真实模式下一个工作区只有"所有者"一个人：建不了岗位、分不了人、
 * 邀请不了同事——公司制度这一层用户根本摸不到（38 §1）。这一组路由把它补上。
 *
 * 四条边界：
 *
 * 1. **网关里不写业务**（28 §2）：怎么存岗位、怎么展开分配、怎么建审批项，
 *    全在 `apps/server/src/org.ts`；这一层只做路由声明、权限判定与信封。
 * 2. **权限是 owner / 范围管理者的**（05 §3「策略层只有 owner 可改」）：
 *    读走 `policy.read@workspace`，写走 `policy.stage@workspace/restricted`。
 *    售后客服那条职责没有 policy 域，所以他打这些路由一律 403。
 * 3. **改职责模板与改策略层必经审批**（14 §1 `policy_change`，§13.3「只有 owner 可决」）：
 *    这两条路由不直接改任何东西，只回一张卡的 id，批了才生效。
 * 4. **一次请求一个 Assignment**（31 §3.1）：分配、撤销都是对**别人**的写，
 *    所以要显式带 `X-Assignment`，判定用完整元组，不做跨 Assignment 并集。
 *
 * 两处与派工书里的路径不同，都是因为撞车（写进交付报告）：
 * - 岗位用 `/v1/org/positions`：`/v1/positions` 已经被工作台面占了（36 §3「本人持有的岗位」）；
 * - 改分配用 `PUT /v1/assignments/:id`：路由声明层只有 get/post/put/delete，没有 patch。
 */
import type { MaybePromise, Membership, Position, RangeRef } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'org'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

export interface OrgActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 一个职责在界面上的摘要：非技术用户看的是"这个职责能看什么、能做什么"。 */
export interface RoleSummaryView {
  id: string
  name: string
  name_en: string
  description: string
  domain: string
  version: string
  /** 内置模板不给改，只能"复制一份"再改（05 §0：职责定义是配置，走版本与审批）。 */
  source: 'bundled' | 'custom'
  editable: boolean
  /** 现在有几个人在做这个职责（活跃分配数）。 */
  holders: number
  /** 05 §1.6 首页积木摘要 */
  home_blocks: { id: string; placement: string; component: string }[]
  /** 05 §1.3 允许 stage 的写操作 */
  actions: {
    id: string
    kind: string
    target: string
    route_to: string
    review_cannot_be_disabled: boolean
    /** 额度里的数字，人话（"单笔最多退 50 USD"由前端拼；这里只给键值） */
    caps: { key: string; value: string }[]
    window?: { max_count: number; per: string }
  }[]
  /** 05 §1.4 自动化上限 */
  automation: { action_id: string; ceiling: string; initial: string; hard_ceiling: boolean }[]
  connectors: { kind: string; required: boolean }[]
}

export interface RoleDetailView extends RoleSummaryView {
  scopes: { domain: string; ops: string[]; range: string; max_sensitivity: string }[]
  skills: { name: string; tier: string; load: string }[]
}

/** 05 §2 岗位模板 + "谁在做"。 */
export interface PositionView {
  id: string
  name: string
  name_en: string
  version: string
  source: 'bundled' | 'custom'
  roles: { role_id: string; name: string; default: boolean; loaded: boolean }[]
  /** 持有这个岗位的人：默认包里的职责都在他名下才算（岗位不落库，看的是分配）。 */
  holders: { person_id: string; name: string; ranges: RangeRef[] }[]
}

export interface AssignmentView {
  assignment_id: string
  person_id: string
  person_name: string
  role_id: string
  role_name: string
  role_version: string
  ranges: RangeRef[]
  granted_at: string
  revoked_at?: string
  /** 05 §4：范围为空且职责按 assigned 取数 → 这条分配现在查不到任何东西 */
  unassigned_range: boolean
}

export interface MemberView {
  person_id: string
  name: string
  email: string
  role: Membership['role']
  joined_at: string
  left_at?: string
  /** 这个人现在持有的岗位（按默认包匹配出来的） */
  positions: { id: string; name: string }[]
  assignments: AssignmentView[]
}

export interface InvitationView {
  id: string
  email: string
  name?: string
  role: Membership['role']
  position_id?: string
  ranges: RangeRef[]
  created_at: string
  expires_at: string
  accepted_at?: string
  used: boolean
  /**
   * 邀请链接。**只在刚建出来那一次带上**（token 明文只出现一次）；
   * 清单里的历史邀请没有这个字段。
   */
  url?: string
  /** `link` = 本地档，链接交给 owner 自己转发；`email` = 已经发信了。 */
  delivered: 'link' | 'email'
}

/** 策略层（05 §3）在界面上的形状。 */
export interface WorkspacePolicyView {
  workspace_id: string
  mandates: Record<string, unknown>
  global_caps: Record<string, number>
  separation_of_duties: string[]
  sensitivity_overrides?: Record<string, string>
}

/**
 * 改制度的回执。14 §1：`policy_change` 只有 owner 可决，所以这里永远是"提了一张卡"，
 * 不是"已经改好了"——界面照这个字段显示「已提交审批」。
 */
export interface OrgChangeReceipt {
  status: 'pending_approval' | 'applied'
  approval_item_id?: string
  summary: string
}

export interface CopyRoleInput {
  from: string
  name?: string | undefined
}

/** 只开放这几处可改：名字、说明、每个动作的额度上限与自动化上限。 */
export interface RolePatchInput {
  name?: string | undefined
  name_en?: string | undefined
  description?: string | undefined
  actions?:
    | {
        id: string
        caps?: Record<string, number> | undefined
        window_max_count?: number | undefined
      }[]
    | undefined
  automation?: { action_id: string; ceiling: 'L1' | 'L2' | 'L3' }[] | undefined
}

export interface PositionInput {
  id?: string | undefined
  name: string
  name_en?: string | undefined
  roles: { role_id: string; default?: boolean | undefined }[]
}

export interface AssignInput {
  person_id: string
  /** 岗位模板；给了就按它的默认包展开成一组分配。 */
  position_id?: string | undefined
  /** 只想给一个职责时用它（岗位与职责二选一）。 */
  role_id?: string | undefined
  /** 岗位里 `default: false` 的可选职责，勾了才给。 */
  include?: string[] | undefined
  ranges: RangeRef[]
}

export interface UpdateAssignInput {
  ranges?: RangeRef[] | undefined
  /** 只能更紧（05 §0 不变量 2）；放宽 → 400。 */
  mandate_overrides?: Record<string, { caps?: Record<string, number> | undefined }> | undefined
}

/** 策略层能改的三处：额度覆盖、总量上限、职责分离清单。 */
export interface PolicyPatchInput {
  mandates?: Record<string, unknown> | undefined
  global_caps?: Record<string, number> | undefined
  separation_of_duties?: string[] | undefined
}

export interface InviteInput {
  email: string
  name?: string | undefined
  role?: Membership['role'] | undefined
  position_id?: string | undefined
  ranges?: RangeRef[] | undefined
}

export interface AcceptedInvitationView {
  workspace_id: string
  workspace_name: string
  email: string
  person_id: string
  /** 接受后拿到的岗位（按邀请里的岗位模板展开）。 */
  assignments: AssignmentView[]
}

// ── 离职（40 §1.2 第三条规则；WP36）────────────────────────────────────

/** 个人层 overlay 怎么处置：归档成"前员工层"只读（默认），或整个销毁。 */
export type PersonalLayerPolicy = 'archive' | 'erase'
/** 个人记忆怎么处置：工作相关的迁给接手人（经审批），其余按 21 擦除；或全擦。 */
export type MemoryPolicy = 'migrate_work' | 'erase'

export interface OffboardInput {
  handover_to?: string | undefined
  personal_layer?: PersonalLayerPolicy | undefined
  memory?: MemoryPolicy | undefined
}

export interface OffboardStepView {
  step: 'revoke' | 'handover' | 'skills' | 'memory' | 'lessons' | 'report'
  status: 'done' | 'skipped' | 'failed' | 'pending_approval'
  /** **只有数字，没有内容**（40 E1：管理员对个人数据没有「读」）。 */
  counts?: Record<string, number>
  approval_item_id?: string
  error?: string
}

/** 40 §1.2 最后一步的那张「离职报告」。 */
export interface OffboardReportView {
  person_id: string
  person_name: string
  handover_to: string
  handover_to_name: string
  fallback_used: boolean
  personal_layer: PersonalLayerPolicy
  memory: MemoryPolicy
  status: 'done' | 'partial' | 'pending_approval'
  at: string
  steps: OffboardStepView[]
  summary: string
  manual: string[]
  matter_id?: string
}

/** 归档区里的一条（**只有段数，没有正文**）。 */
export interface ArchivedSkillView {
  skill: string
  owner: string
  owner_name: string
  sections: number
  base_version: string
  archived_at: string
  reason?: string
}

export interface AdoptArchivedInput {
  skill: string
  owner: string
  to_tier: 'company' | 'department'
  scope_id?: string | undefined
}

export interface AdoptReceiptView {
  status: 'pending_approval'
  approval_item_id: string
  summary: string
}

/**
 * 离职编排（业务全在 `apps/server/src/offboard.ts`）。
 *
 * 这一层只做路由与权限：三条路由都要 `policy.stage@workspace/restricted`——
 * 动别人的分配、动别人的个人数据、动公司技能层，都是 owner 级的事（14 §13.3）。
 */
export interface OffboardPort {
  offboard(
    actor: OrgActor,
    person_id: string,
    input: OffboardInput,
  ): MaybePromise<OffboardReportView>
  archivedSkills(actor: OrgActor, owner?: string): MaybePromise<ArchivedSkillView[]>
  adopt(actor: OrgActor, input: AdoptArchivedInput): MaybePromise<AdoptReceiptView>
}

export interface OrgPort {
  roles(actor: OrgActor): MaybePromise<RoleSummaryView[]>
  role(actor: OrgActor, id: string): MaybePromise<RoleDetailView | undefined>
  copyRole(actor: OrgActor, input: CopyRoleInput): MaybePromise<RoleDetailView>
  /** 14：建一张 `policy_change` 卡，批了才生效。 */
  proposeRoleChange(
    actor: OrgActor,
    id: string,
    patch: RolePatchInput,
  ): MaybePromise<OrgChangeReceipt>
  positions(actor: OrgActor): MaybePromise<PositionView[]>
  createPosition(actor: OrgActor, input: PositionInput): MaybePromise<PositionView>
  updatePosition(actor: OrgActor, id: string, input: PositionInput): MaybePromise<PositionView>
  deletePosition(actor: OrgActor, id: string): MaybePromise<void>
  assign(actor: OrgActor, input: AssignInput): MaybePromise<AssignmentView[]>
  updateAssignment(
    actor: OrgActor,
    id: string,
    input: UpdateAssignInput,
  ): MaybePromise<AssignmentView>
  revokeAssignment(
    actor: OrgActor,
    id: string,
    input: { handover_to?: string | undefined },
  ): MaybePromise<AssignmentView>
  policy(actor: OrgActor): MaybePromise<WorkspacePolicyView>
  proposePolicyChange(actor: OrgActor, input: PolicyPatchInput): MaybePromise<OrgChangeReceipt>
  members(actor: OrgActor): MaybePromise<MemberView[]>
  removeMember(actor: OrgActor, person_id: string): MaybePromise<{ revoked_assignments: number }>
  invitations(actor: OrgActor): MaybePromise<InvitationView[]>
  invite(actor: OrgActor, input: InviteInput): MaybePromise<InvitationView>
  /** **公开**：被邀请的人这会儿还没有任何凭据，只有邮件里那把 token。 */
  accept(token: string, input: { name?: string | undefined }): MaybePromise<AcceptedInvitationView>
  /** 界面上"选范围"的候选（店铺 / 账号 / 市场 / 部门），由装配方给。 */
  rangeOptions(
    actor: OrgActor,
  ): MaybePromise<{ kind: RangeRef['kind']; id: string; label: string }[]>
}

// ── 校验 ───────────────────────────────────────────────────────────────

const RANGE = z.object({
  kind: z.enum(['store', 'department', 'account', 'market']),
  id: z.string().min(1).max(128),
})

const CopyRoleBody = z.object({
  from: z.string().min(1).max(128),
  name: z.string().min(1).max(64).optional(),
})

const RolePatchBody = z.object({
  name: z.string().min(1).max(64).optional(),
  name_en: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(400).optional(),
  actions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        caps: z.record(z.string().min(1).max(64), z.number().min(0).max(1_000_000)).optional(),
        window_max_count: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .max(50)
    .optional(),
  automation: z
    .array(z.object({ action_id: z.string().min(1).max(64), ceiling: z.enum(['L1', 'L2', 'L3']) }))
    .max(50)
    .optional(),
})

const PositionBody = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64),
  name_en: z.string().min(1).max(64).optional(),
  roles: z
    .array(z.object({ role_id: z.string().min(1).max(128), default: z.boolean().optional() }))
    .min(1)
    .max(30),
})

const AssignBody = z.object({
  person_id: z.string().min(1).max(128),
  position_id: z.string().min(1).max(64).optional(),
  role_id: z.string().min(1).max(128).optional(),
  include: z.array(z.string().min(1).max(128)).max(30).optional(),
  ranges: z.array(RANGE).max(50).default([]),
})

const UpdateAssignBody = z.object({
  ranges: z.array(RANGE).max(50).optional(),
  mandate_overrides: z
    .record(
      z.string().min(1).max(64),
      z.object({
        caps: z.record(z.string().min(1).max(64), z.number().min(0).max(1_000_000)).optional(),
      }),
    )
    .optional(),
})

const RevokeQuery = z.object({ handover_to: z.string().min(1).max(128).optional() })

const PolicyBody = z.object({
  mandates: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  global_caps: z.record(z.string().min(1).max(64), z.number().min(0).max(100_000_000)).optional(),
  separation_of_duties: z.array(z.string().min(1).max(64)).max(50).optional(),
})

const InviteBody = z.object({
  email: z.string().min(3).max(254),
  name: z.string().min(1).max(64).optional(),
  role: z.enum(['owner', 'manager', 'member']).optional(),
  position_id: z.string().min(1).max(64).optional(),
  ranges: z.array(RANGE).max(50).optional(),
})

const AcceptBody = z.object({ name: z.string().min(1).max(64).optional() })

const OffboardBody = z.object({
  handover_to: z.string().min(1).max(128).optional(),
  personal_layer: z.enum(['archive', 'erase']).optional(),
  memory: z.enum(['migrate_work', 'erase']).optional(),
})

const AdoptBody = z.object({
  skill: z.string().min(1).max(128),
  owner: z.string().min(1).max(128),
  to_tier: z.enum(['company', 'department']),
  scope_id: z.string().min(1).max(64).optional(),
})

// ── 装配 ───────────────────────────────────────────────────────────────

function portOf(deps: GatewayDeps): OrgPort {
  const p = deps.org
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配制度面（GatewayDeps.org）')
  return p
}

function offboardOf(deps: GatewayDeps): OffboardPort {
  const p = deps.offboard
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配离职编排（GatewayDeps.offboard）')
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): OrgActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

/** 20 §3：token 绑工作区，路径里的工作区必须是同一个，跨工作区一律显式切换。 */
function sameWorkspace(c: Ctx): OrgActor {
  const actor = actorOf(c)
  if (param(c, 'id') !== actor.workspace_id) throw new ApiError('forbidden', '凭据不属于该工作区')
  return actor
}

const optional = <T>(v: T | undefined, key: string): Record<string, T> =>
  v === undefined ? {} : ({ [key]: v } as Record<string, T>)

export function orgRoutes(): Route[] {
  return [
    // ── 职责（05 §1）───────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/roles',
        operationId: 'listRoleDefinitions',
        summary: '职责清单（内置模板 + 本工作区的自定义副本）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RoleSummaryView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).roles(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/roles',
        operationId: 'copyRoleDefinition',
        summary: '从内置模板复制一份自定义职责（复制出来还没人做，所以直接生效）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: CopyRoleBody,
        returns: 'RoleDetailView',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, CopyRoleBody)
        const created = await portOf(deps).copyRole(actor, {
          from: input.from,
          ...optional(input.name, 'name'),
        })
        return ok(c, created, 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/roles/:id',
        operationId: 'getRoleDefinition',
        summary: '一个职责的完整定义（权限、动作、额度、积木）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'role_id' }],
        returns: 'RoleDetailView',
      },
      async (c, deps) => {
        const found = await portOf(deps).role(actorOf(c), param(c, 'id'))
        if (found === undefined) throw new ApiError('not_found', `没有这个职责：${param(c, 'id')}`)
        return ok(c, found)
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/roles/:id',
        operationId: 'proposeRoleChange',
        summary: '改职责模板 → 建一张 policy_change 卡（14 §1；批了才生效）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: 'role_id' }],
        body: RolePatchBody,
        returns: 'OrgChangeReceipt（status 永远是 pending_approval）',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const patch = await body(c, RolePatchBody)
        return ok(c, await portOf(deps).proposeRoleChange(actor, param(c, 'id'), patch))
      },
    ),

    // ── 岗位（05 §2）───────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/org/positions',
        operationId: 'listOrgPositions',
        summary: '岗位清单（岗位 = 职责的默认包 + 谁在做）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PositionView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).positions(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/org/positions',
        operationId: 'createPosition',
        summary: '新建岗位',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: PositionBody,
        returns: 'PositionView',
      },
      async (c, deps) => {
        const input = await body(c, PositionBody)
        return ok(c, await portOf(deps).createPosition(actorOf(c), input), 201)
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/org/positions/:id',
        operationId: 'updatePosition',
        summary: '改岗位（加减职责）；不影响已分配的人（05 §2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '岗位 id' }],
        body: PositionBody,
        returns: 'PositionView',
      },
      async (c, deps) => {
        const input = await body(c, PositionBody)
        return ok(c, await portOf(deps).updatePosition(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/org/positions/:id',
        operationId: 'deletePosition',
        summary: '删岗位（还有人在做就 409）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '岗位 id' }],
        returns: '{ deleted: true }',
      },
      async (c, deps) => {
        await portOf(deps).deletePosition(actorOf(c), param(c, 'id'))
        return ok(c, { deleted: true })
      },
    ),

    // ── 分配（05 §3）───────────────────────────────────────────────────
    route(
      {
        method: 'post',
        path: '/v1/assignments',
        operationId: 'createAssignments',
        summary: '把岗位（或单个职责）分给某位成员',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: AssignBody,
        returns: 'AssignmentView[]（一个岗位展开成一组分配）',
      },
      async (c, deps) => {
        const input = await body(c, AssignBody)
        return ok(c, await portOf(deps).assign(actorOf(c), input), 201)
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/assignments/:id',
        operationId: 'updateAssignment',
        summary: '改一条分配的范围 / 收紧额度（只能更紧）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: 'assignment_id' }],
        body: UpdateAssignBody,
        returns: 'AssignmentView',
      },
      async (c, deps) => {
        const input = await body(c, UpdateAssignBody)
        return ok(c, await portOf(deps).updateAssignment(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/assignments/:id',
        operationId: 'revokeAssignment',
        summary: '撤销一条分配（撤销即失效：token 判定、查询、队列同时没了）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: 'assignment_id' },
          { name: 'handover_to', in: 'query', description: '接手人 person_id（05 handover）' },
        ],
        returns: 'AssignmentView',
      },
      async (c, deps) => {
        const parsed = RevokeQuery.safeParse({ handover_to: c.req.query('handover_to') })
        if (!parsed.success) throw new ApiError('invalid_input', 'handover_to 不合法')
        return ok(
          c,
          await portOf(deps).revokeAssignment(actorOf(c), param(c, 'id'), {
            ...optional(parsed.data.handover_to, 'handover_to'),
          }),
        )
      },
    ),

    // ── 策略层（05 §3）─────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/workspaces/:id/policy',
        operationId: 'getWorkspacePolicy',
        summary: '工作区策略层（额度覆盖、总量上限、职责分离）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        returns: 'WorkspacePolicyView',
      },
      async (c, deps) => ok(c, await portOf(deps).policy(sameWorkspace(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/workspaces/:id/policy',
        operationId: 'proposeWorkspacePolicyChange',
        summary: '改策略层 → 建一张 policy_change 卡（14 §13.3 只有 owner 可决）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        body: PolicyBody,
        returns: 'OrgChangeReceipt',
      },
      async (c, deps) => {
        const actor = sameWorkspace(c)
        const input = await body(c, PolicyBody)
        return ok(c, await portOf(deps).proposePolicyChange(actor, input))
      },
    ),

    // ── 成员与邀请（20 §1 §5）──────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/workspaces/:id/members',
        operationId: 'listMembers',
        summary: '成员清单（每人持有的岗位与范围）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        returns: 'MemberView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).members(sameWorkspace(c))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/workspaces/:id/members/:person_id',
        operationId: 'removeMember',
        summary: '移出成员：撤销他的全部分配，token 立刻失效（20 §4）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: '工作区 id' },
          { name: 'person_id', in: 'path', required: true, description: '成员 person_id' },
        ],
        returns: '{ revoked_assignments }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).removeMember(sameWorkspace(c), param(c, 'person_id'))),
    ),
    // ── 离职（40 §1.2；WP36）──────────────────────────────────────────
    // 路径里的 `offboard` 是定值段，排在 `:person_id` 的 DELETE 之外，不与它撞。
    route(
      {
        method: 'post',
        path: '/v1/workspaces/:id/members/:person_id/offboard',
        operationId: 'offboardMember',
        summary:
          '离职：撤权限 → 在办事项 / 未完待办 / 定时任务真转接手人 → 个人层归档或销毁 → 个人记忆迁移或擦除 → 出一份离职报告（owner；可重跑）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: '工作区 id' },
          { name: 'person_id', in: 'path', required: true, description: '走的人 person_id' },
        ],
        body: OffboardBody,
        returns: 'OffboardReportView（**只有数字，没有个人数据正文**）',
      },
      async (c, deps) => {
        const actor = sameWorkspace(c)
        const input = await body(c, OffboardBody)
        return ok(c, await offboardOf(deps).offboard(actor, param(c, 'person_id'), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workspaces/:id/archived-skills',
        operationId: 'listArchivedSkills',
        summary: '前员工层：归档的技能改动清单（只有段数，没有正文）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: '工作区 id' },
          { name: 'owner', in: 'query', description: '只看某位前员工的' },
        ],
        returns: 'ArchivedSkillView[]',
      },
      async (c, deps) => {
        const actor = sameWorkspace(c)
        const owner = c.req.query('owner')
        return ok(c, await offboardOf(deps).archivedSkills(actor, owner === '' ? undefined : owner))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workspaces/:id/archived-skills/adopt',
        operationId: 'adoptArchivedSkill',
        summary: '把前员工层的那几段采纳进部门 / 公司层：建一张 policy_change 卡，批了才落',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        body: AdoptBody,
        returns: 'AdoptReceiptView',
      },
      async (c, deps) => {
        const actor = sameWorkspace(c)
        const input = await body(c, AdoptBody)
        return ok(c, await offboardOf(deps).adopt(actor, input), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/workspaces/:id/invitations',
        operationId: 'listInvitations',
        summary: '邀请清单（不含 token）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        returns: 'InvitationView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).invitations(sameWorkspace(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/workspaces/:id/invitations',
        operationId: 'inviteMember',
        summary: '邀请同事：生成一次性链接（24h）；本地档把链接直接给 owner 转发',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        body: InviteBody,
        returns: 'InvitationView（**只有这一次**带 url）',
      },
      async (c, deps) => {
        const actor = sameWorkspace(c)
        const input = await body(c, InviteBody)
        return ok(c, await portOf(deps).invite(actor, input), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/invitations/:token/accept',
        operationId: 'acceptInvitation',
        summary: '接受邀请（公开：被邀请的人这会儿还没有凭据）',
        tag: TAG,
        auth: 'public',
        params: [{ name: 'token', in: 'path', required: true, description: '邀请 token' }],
        body: AcceptBody,
        returns: 'AcceptedInvitationView（接受后用邮箱走 magic-link 登录）',
      },
      async (c, deps) => {
        const input = await body(c, AcceptBody)
        return ok(
          c,
          await portOf(deps).accept(param(c, 'token'), { ...optional(input.name, 'name') }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/org/ranges',
        operationId: 'listRangeOptions',
        summary: '分配向导里"选范围"的候选（店铺 / 账号 / 市场 / 部门）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ kind, id, label }[]',
      },
      async (c, deps) => ok(c, await portOf(deps).rangeOptions(actorOf(c))),
    ),
  ]
}

/** 岗位模板（契约 `Position`）→ 界面形状；两边都要用，所以放在这一层。 */
export function positionName(position: Position, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en' ? position.name.en : position.name.zh
}
