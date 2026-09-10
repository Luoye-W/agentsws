/**
 * 41 §1 秘书 Agent 的网关面：`/v1/me/*`（我的秘书）与 `/v1/people/*`（别人的秘书）。
 *
 * 三条边界：
 * - **网关里不写业务**：公开级别怎么过滤、这句话在问什么、时段撞不撞、这件事该谁做，
 *   全在 `@agentsws/secretary` 里；这里只做校验与转发。
 * - **准入沿工作台面的做法**：能读自己的审批队列就能用秘书面。真正的写仍然只经审批项
 *   （路由出的是一张认领卡，不是一个动作）。
 * - **越权判定不在这一层**：问方看得到什么由被问者的公开级别决定，网关不认识那张表——
 *   它只把"问方是谁"如实交给端口。
 *
 * 契约建议见交付报告 §4：`PersonProfile` / `Disclosure` / `MeetProposal` 进契约，
 * `secretary.answered` / `secretary.routed` / `meet.*` 进 `KnownEventType`。
 */
import type { CalendarItem, MaybePromise, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type GatewayEnv, type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 读自己的队列就能用秘书面（与 `routes/workstation.ts` / `routes/meetings.ts` 同一档）。 */
const ACCESS = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

/** 改自己的 profile / 发一张卡：`stage`（提议）那一档，`common.member` 就有。 */
const WRITE = {
  domain: 'approval',
  op: 'stage',
  range: 'own',
  sensitivity: 'internal',
} as const

export interface SecretaryActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

/* ── 视图（网关只做序列化；字段由 `@agentsws/secretary` 定形）────────────── */

export type DisclosureLevelName = 'self' | 'colleagues' | 'workspace'

export type ProfileFieldName =
  | 'positions'
  | 'ranges'
  | 'in_progress'
  | 'availability'
  | 'agenda_detail'
  | 'skills'
  | 'contact'

/** 一张公开级别补丁：每一格都可以不给。 */
export type DisclosurePatchView = { [K in ProfileFieldName]?: DisclosureLevelName | undefined }

export const PROFILE_FIELD_NAMES = [
  'positions',
  'ranges',
  'in_progress',
  'availability',
  'agenda_detail',
  'skills',
  'contact',
] as const

export interface ProfileSkillView {
  name: string
  source: 'skill' | 'memory' | 'self'
  hidden?: boolean | undefined
}

export interface AvailabilityView {
  rules: { days: number[]; from: string; to: string }[]
  default_minutes: number
  max_meetings_per_day?: number | undefined
}

/** `PUT /v1/me/profile` 里的那半份：每一格都可以不给（`exactOptionalPropertyTypes`）。 */
export interface AvailabilityPatchView {
  rules?: { days: number[]; from: string; to: string }[] | undefined
  default_minutes?: number | undefined
  max_meetings_per_day?: number | undefined
}

export interface ProfilePositionView {
  position_id: string
  role_id: string
  role_name: string
  ranges: { kind: string; id: string }[]
}

/** 本人那一份（设置页照着它画）。 */
export interface MyProfileView {
  person_id: PersonId
  name: string
  positions: ProfilePositionView[]
  ranges: { kind: string; id: string }[]
  skills: ProfileSkillView[]
  contact_policy: { prefer: 'secretary' | 'direct'; note?: string }
  availability: AvailabilityView
  disclosure: Record<ProfileFieldName, DisclosureLevelName>
  updated_at: string
}

/** 别人那一份（已按公开级别过滤；藏起来的字段只留名字进 `hidden_fields`）。 */
export interface VisibleProfileView {
  person_id: PersonId
  name: string
  relation: 'self' | 'colleague' | 'outsider'
  positions?: ProfilePositionView[]
  ranges?: { kind: string; id: string }[]
  skills?: ProfileSkillView[]
  availability?: AvailabilityView
  contact_policy?: { prefer: 'secretary' | 'direct'; note?: string }
  hidden_fields: ProfileFieldName[]
  disclosure?: Record<ProfileFieldName, DisclosureLevelName>
}

export interface PersonCardView {
  person_id: PersonId
  name: string
  positions: { role_id: string; role_name: string }[]
  /** 手上进行中的条数（同事可见级；藏了就没有这个键） */
  in_progress?: number
}

export interface AskView {
  answer: string
  kind: string
  fields: ProfileFieldName[]
  refused: boolean
  refer_to?: { role_id: string; role_name: string; person_id?: string }
  run_id: string
}

/** "谁问过我"：正文只回给本人（41 §1.2）。 */
export interface AskedView {
  id: string
  asked_by: PersonId
  asked_by_label?: string
  at: string
  kind: string
  question: string
  answer: string
  fields: ProfileFieldName[]
  refused: boolean
}

export interface AgendaCheckView {
  ok: boolean
  conflicts: { id: string; title: string; start: string; end?: string }[]
  reasons: string[]
  alternatives: { start: string; end: string }[]
}

export interface MeetView {
  id: string
  from: PersonId
  from_label?: string
  to: PersonId
  to_label?: string
  title: string
  duration_minutes: number
  candidates: { start: string; end: string }[]
  state: 'proposed' | 'accepted' | 'declined' | 'expired'
  accepted?: { start: string; end: string }
  alternatives: { start: string; end: string }[]
  approval_item_id?: string
  meeting_id?: string
  decline_reason?: string
  created_at: string
  decided_at?: string
}

export interface MeetingBriefView {
  meeting_id: string
  title: string
  start: string
  end: string
  participants: string[]
  agenda: string[]
  matters: { id: string; title: string; summary: string; status: string }[]
  open_items: { title: string; owner: string; owner_label?: string }[]
}

export interface RouteView {
  kind: 'task' | 'question'
  role_id?: string
  role_name?: string
  position_id?: string
  owner?: string
  owner_label?: string
  confidence: number
  reason: string
  existing_tools: { id: string; title: string; kind: string; similarity: number }[]
  similar_in_progress: {
    id: string
    title: string
    owner: string
    owner_label?: string
    similarity: number
  }[]
  claim_item_id?: string
  todo_id?: string
  run_id: string
}

/** 41 §1 秘书面；没装配时这几条路由回 `not_implemented`。 */
export interface SecretaryPort {
  /** 本人那一份（含公开级别） */
  myProfile(actor: SecretaryActor): MaybePromise<MyProfileView>
  updateProfile(
    actor: SecretaryActor,
    patch: {
      skills?: ProfileSkillView[] | undefined
      contact_policy?:
        | { prefer?: 'secretary' | 'direct' | undefined; note?: string | undefined }
        | undefined
      availability?: AvailabilityPatchView | undefined
      disclosure?: DisclosurePatchView | undefined
    },
  ): MaybePromise<MyProfileView>
  /** 别人那一份（按问方身份 + 公开级别过滤） */
  profileOf(actor: SecretaryActor, person_id: PersonId): MaybePromise<VisibleProfileView>
  /** 公司页成员 → 点人：一份能点进去的名单 */
  people(actor: SecretaryActor): MaybePromise<PersonCardView[]>
  /** 代答：对方秘书以对方权限跑一次单轮 */
  ask(actor: SecretaryActor, person_id: PersonId, question: string): MaybePromise<AskView>
  /** "谁问过我"（只有本人） */
  asked(actor: SecretaryActor, limit?: number): MaybePromise<AskedView[]>
  /** 合并日程：外部日历 + 排期待办 + 定时任务 + 会议 */
  agenda(actor: SecretaryActor, range: { from: string; to: string }): MaybePromise<CalendarItem[]>
  /** 冲突检测 + 替代时段 */
  checkAgenda(
    actor: SecretaryActor,
    slot: { start: string; end: string },
  ): MaybePromise<AgendaCheckView>
  /** 约时间：向对方秘书发一张 `claim` 形态的卡 */
  meet(
    actor: SecretaryActor,
    person_id: PersonId,
    input: {
      title: string
      candidates: { start: string; end: string }[]
      duration?: number | undefined
    },
  ): MaybePromise<MeetView>
  /** 等我点头的那几张 */
  meets(actor: SecretaryActor): MaybePromise<MeetView[]>
  decideMeet(
    actor: SecretaryActor,
    id: string,
    input:
      | { action: 'accept'; slot?: { start: string; end: string } | undefined }
      | { action: 'decline'; reason?: string | undefined },
  ): MaybePromise<MeetView>
  /** 会前简报：相关事项摘要成议程 */
  brief(actor: SecretaryActor, meeting_id: string): MaybePromise<MeetingBriefView>
  /** 任务路由：判断该谁做 → 认领卡 */
  route(
    actor: SecretaryActor,
    input: {
      text?: string | undefined
      inbound_ref?: string | undefined
      meeting_output_ref?: string | undefined
    },
  ): MaybePromise<RouteView>
}

/* ── 校验 ─────────────────────────────────────────────────────────────── */

const LEVEL = z.enum(['self', 'colleagues', 'workspace'])
const SLOT = z.object({ start: z.string().min(1), end: z.string().min(1) })

const ProfileBody = z.object({
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        source: z.enum(['skill', 'memory', 'self']).default('self'),
        hidden: z.boolean().optional(),
      }),
    )
    .max(50)
    .optional(),
  contact_policy: z
    .object({
      prefer: z.enum(['secretary', 'direct']).optional(),
      note: z.string().max(200).optional(),
    })
    .optional(),
  availability: z
    .object({
      rules: z
        .array(
          z.object({
            days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
            from: z.string().regex(/^\d{1,2}:\d{2}$/),
            to: z.string().regex(/^\d{1,2}:\d{2}$/),
          }),
        )
        .max(14)
        .optional(),
      default_minutes: z.number().int().min(5).max(480).optional(),
      max_meetings_per_day: z.number().int().min(0).max(50).optional(),
    })
    .optional(),
  /**
   * 逐字段可选——不能写成 `z.record(z.enum(...), LEVEL)`：zod 的 record 在 key 是枚举时
   * 要求**每个键都给**，而这里是一张补丁（只改改过的那一格）。
   */
  disclosure: z
    .object({
      positions: LEVEL.optional(),
      ranges: LEVEL.optional(),
      in_progress: LEVEL.optional(),
      availability: LEVEL.optional(),
      agenda_detail: LEVEL.optional(),
      skills: LEVEL.optional(),
      contact: LEVEL.optional(),
    })
    .optional(),
})

const AskBody = z.object({ question: z.string().min(1).max(500) })

const MeetBody = z.object({
  title: z.string().min(1).max(120),
  candidates: z.array(SLOT).min(1).max(10),
  duration: z.number().int().min(5).max(480).optional(),
})

const DecideBody = z.union([
  z.object({ action: z.literal('accept'), slot: SLOT.optional() }),
  z.object({ action: z.literal('decline'), reason: z.string().max(200).optional() }),
])

const RouteBody = z
  .object({
    text: z.string().min(1).max(4000).optional(),
    inbound_ref: z.string().min(1).max(128).optional(),
    meeting_output_ref: z.string().min(1).max(128).optional(),
  })
  .refine(
    (v) =>
      v.text !== undefined || v.inbound_ref !== undefined || v.meeting_output_ref !== undefined,
    { message: '总得说要路由什么：text / inbound_ref / meeting_output_ref 三选一' },
  )

const CheckBody = SLOT

function portOf(deps: GatewayDeps): SecretaryPort {
  if (deps.secretary === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配秘书（GatewayDeps.secretary）')
  return deps.secretary
}

function actorOf(c: Context<GatewayEnv>): SecretaryActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

export function secretaryRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/me/profile',
        operationId: 'getMyProfile',
        summary: '我的 profile 与公开级别（41 §1.3）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        returns: 'MyProfileView',
      },
      async (c, deps) => ok(c, await portOf(deps).myProfile(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/me/profile',
        operationId: 'updateMyProfile',
        summary: '改我的擅长 / 联系偏好 / 可用时段 / 公开级别',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ProfileBody,
        returns: 'MyProfileView',
      },
      async (c, deps) => {
        const input = await body(c, ProfileBody)
        return ok(c, await portOf(deps).updateProfile(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/me/agenda',
        operationId: 'getMyAgenda',
        summary: '我的日程：会议 + 排期待办 + 定时任务 + 卡片到期',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [
          { name: 'from', in: 'query', required: true, description: '起（ISO8601）' },
          { name: 'to', in: 'query', required: true, description: '止（ISO8601，开区间）' },
        ],
        returns: 'CalendarItem[]',
      },
      async (c, deps) => {
        const from = c.req.query('from')
        const to = c.req.query('to')
        if (from === undefined || to === undefined)
          throw new ApiError('invalid_input', 'from 与 to 都要给')
        return ok(c, await portOf(deps).agenda(actorOf(c), { from, to }))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/me/agenda/check',
        operationId: 'checkMyAgenda',
        summary: '这个时段撞不撞；撞了给替代时段',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        body: CheckBody,
        returns: '{ ok, conflicts, reasons, alternatives }',
      },
      async (c, deps) => {
        const input = await body(c, CheckBody)
        return ok(c, await portOf(deps).checkAgenda(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/me/secretary/asked',
        operationId: 'listAskedMe',
        summary: '谁问过我：问方、问题、秘书答了什么（只有本人看得到）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'limit', in: 'query', required: false, description: '最多几条' }],
        returns: 'AskedView[]',
      },
      async (c, deps) => {
        const raw = c.req.query('limit')
        const limit = raw === undefined || raw === '' ? undefined : Number(raw)
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
          throw new ApiError('invalid_input', 'limit 必须是正整数')
        return ok(c, await portOf(deps).asked(actorOf(c), limit))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/me/secretary/route',
        operationId: 'routeToDesk',
        summary: '把一件事丢给秘书：判断该谁做 → 认领卡（专业问题只转岗位，不出卡）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RouteBody,
        returns: 'RouteView',
      },
      async (c, deps) => {
        const input = await body(c, RouteBody)
        return ok(c, await portOf(deps).route(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/me/meets',
        operationId: 'listMyMeets',
        summary: '等我点头的"约时间"卡',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        returns: 'MeetView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).meets(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/me/meets/:id/decide',
        operationId: 'decideMeet',
        summary: '答一张"约时间"卡；点头才进双方日历',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '约时间卡 id' }],
        body: DecideBody,
        returns: 'MeetView',
      },
      async (c, deps) => {
        const input = await body(c, DecideBody)
        return ok(c, await portOf(deps).decideMeet(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/meetings/:id/brief',
        operationId: 'getMeetingBrief',
        summary: '会前简报：相关事项摘要成议程（41 §1.2）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        returns: 'MeetingBriefView',
      },
      async (c, deps) => ok(c, await portOf(deps).brief(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/people',
        operationId: 'listPeople',
        summary: '工作区里的人（公司页成员 → 点进去看 profile）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        returns: 'PersonCardView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).people(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/people/:id/profile',
        operationId: 'getPersonProfile',
        summary: '别人的 profile（按问方身份 + 公开级别过滤）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: 'person_id' }],
        returns: 'VisibleProfileView',
      },
      async (c, deps) => ok(c, await portOf(deps).profileOf(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/people/:id/ask',
        operationId: 'askPersonSecretary',
        summary: '问他的秘书（只答公开级别内的四类问题；越级回"这个要问本人"）',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: 'person_id' }],
        body: AskBody,
        returns: '{ answer, kind, fields, refused, run_id }',
      },
      async (c, deps) => {
        const input = await body(c, AskBody)
        return ok(c, await portOf(deps).ask(actorOf(c), param(c, 'id'), input.question))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/people/:id/meet',
        operationId: 'proposeMeet',
        summary: '约时间：向对方秘书发一张卡；候选全撞上就回 409 + 替代时段',
        tag: 'secretary',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: 'person_id' }],
        body: MeetBody,
        returns: 'MeetView',
      },
      async (c, deps) => {
        const input = await body(c, MeetBody)
        return ok(c, await portOf(deps).meet(actorOf(c), param(c, 'id'), input), 201)
      },
    ),
  ]
}
