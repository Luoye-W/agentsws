/**
 * 首次设置、同事发现、邀请码与申请加入（46）。
 *
 * 这一组路由回答的是用户第一次打开工具时的三个问题——**你们公司叫什么、你是谁、
 * 你做什么**——以及随之而来的两件事：要连哪些平台、同一家公司的同事怎么互相看见。
 *
 * 四条边界：
 *
 * 1. **网关里不写业务**（28 §2）。归一化怎么做、mDNS 怎么广播、邀请码怎么发，
 *    全在 `apps/server/src/{onboarding,discovery,invites}.ts`；这一层只做路由声明、
 *    权限判定与信封。
 * 2. **发现阶段只出哈希**（46 §2 I1）。`GET /v1/discovery/peers` 回的是对方自己愿意
 *    报的展示名（owner 名 + 人数）与主机端口，**没有**公司全称、没有成员名单、
 *    没有任何业务数据。归一化哈希只在局域网的 TXT 记录里出现，不在这条路由的响应里。
 * 3. **看见 ≠ 连上**（46 §2 I1）。名字一样不自动共享任何东西：连上必须一方申请、
 *    另一方 owner 批（`membership` 审批卡，14）。这组路由里没有任何一条能跳过那张卡。
 * 4. **自助豁免**：读"我这个工作区要不要走向导"、算"我勾了这些岗位要配什么"都是
 *    读自己的绑定，不要求策略层读权限；真改公司档案、发邀请码、批申请一律 owner 级。
 */
import type { MaybePromise, MembershipRequestVia } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 改公司档案 / 发邀请码 / 批申请：05 owner 的策略层写权限。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/** 看别人的成员申请 = 策略层读权限；看自己要不要走向导走自助豁免。 */
const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const TAG = 'onboarding'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

export interface OnboardingActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 46 §1 ①：界面上那三个字段。`discoverable` 不给按 true（表里的默认值）。 */
export interface WorkspaceProfileInput {
  legal_name: string
  domain?: string | undefined
  discoverable?: boolean | undefined
}

/** 公司档案的对外形状。**没有归一化哈希**——它是发现用的，不是给人看的。 */
export interface WorkspaceProfileView {
  legal_name: string
  domain?: string
  discoverable: boolean
  set_at: string
}

/**
 * `GET /v1/onboarding/state`。
 *
 * `needs_setup` 的判据只有两条（46 §1 末段「向导只出现在这个工作区还没设过公司名的时候」）：
 * 公司档案没设过，**并且**除了所有者自己那条之外还没有任何分配。第二条是给
 * 「已经用起来了但当初跳过了向导」的工作区留的——它不该在第 100 天被弹一次向导。
 */
export interface OnboardingStateView {
  needs_setup: boolean
  /** 工作区名字（人话，不是 id）。 */
  workspace_name: string
  profile?: WorkspaceProfileView
  /** 当前这个人的名字与登录邮箱（向导第 ② 步直接带出来）。 */
  person: { name: string; email: string }
  /** 本工作区现在有几条有效分配（不含所有者那条）。 */
  other_assignments: number
  /** 这个人是不是所有者——不是的话向导里不出"公司档案"与"邀请码"。 */
  is_owner: boolean
  /** 局域网发现这台机器上能不能用；不能用时 `reason` 是一句人话。 */
  discovery: { available: boolean; enabled: boolean; reason?: string }
}

/** 向导第 ③ 步的候选：岗位与它包含的职责。 */
export interface OnboardingPositionView {
  id: string
  name: string
  roles: { id: string; name: string; default: boolean; what_it_does: string }[]
}

/** 清单里的一条"要连的平台"。 */
export interface OnboardingConnectorItem {
  /** 连接目录里的 provider id（点进去就是连接页那张卡）。 */
  service: string
  label: string
  required: boolean
  connected: boolean
  /** 哪几条职责要它（说人话，用职责名）。 */
  needed_by: string[]
}

/** 清单里的一条"要装的技能包"。 */
export interface OnboardingSkillItem {
  name: string
  installed: boolean
  needed_by: string[]
}

/** 清单里的一条"要建的岗位"。 */
export interface OnboardingPositionPlanItem {
  /** 勾的岗位 id；只勾职责时是 `custom`。 */
  position_id: string
  name: string
  role_ids: string[]
  /** 已经持有这个岗位了（重复走向导时不再建第二份）。 */
  already_held: boolean
}

export interface OnboardingPlanInput {
  position_ids: string[]
  role_ids: string[]
  /** 只勾职责时这个自定义岗位叫什么；不给就是"我的岗位"。 */
  custom_position_name?: string | undefined
}

/**
 * 向导第 ④ 步那张清单。
 *
 * `model_first` 为真时清单第一条固定是"接模型"——一个模型都没接的话，
 * 连上再多平台也没人替你干活（36 首页那条黄条说的就是这件事）。
 */
export interface OnboardingPlanView {
  connectors: OnboardingConnectorItem[]
  skills: OnboardingSkillItem[]
  positions: OnboardingPositionPlanItem[]
  model_configured: boolean
  model_first: boolean
  /** 展开后一共几条职责（勾岗位 = 该岗位职责全勾，前后端同一套算法）。 */
  role_ids: string[]
}

/** `POST /v1/onboarding/apply` 的回执。 */
export interface OnboardingApplyView {
  /** 真建出来的分配（人 × 职责 × 范围）。 */
  created_assignments: { id: string; role_id: string; role_name: string }[]
  /** 已经持有、这次没重复建的。 */
  skipped: string[]
  /** 挂上的范围；连上 Shopify 就是那家店，没连就是空（46 I6 要在面板明说）。 */
  ranges: { kind: string; id: string; label: string }[]
  plan: OnboardingPlanView
}

/** 46 §2 I3：局域网上看见的一位同伴。 */
export interface DiscoveryPeerView {
  peer_id: string
  /** 对方 `/v1/discovery/hello` 自己报的展示名（"王岚的工作区 · 3 人"）。 */
  workspace_label: string
  host: string
  port: number
  first_seen_at: string
  last_seen_at: string
}

export interface DiscoveryStateView {
  available: boolean
  enabled: boolean
  reason?: string
  peers: DiscoveryPeerView[]
}

/** 对方打过来问"你是谁"时我们回的那一点点东西。 */
export interface DiscoveryHelloView {
  peer_id: string
  workspace_label: string
  members: number
}

export interface InviteView {
  code: string
  expires_at: string
  uses_left: number
  created_at: string
}

export interface MembershipRequestView {
  id: string
  person: { name: string; email: string }
  via: MembershipRequestVia
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  created_at: string
  decided_at?: string
  superseded_reason?: string
  /** 同意后那张审批卡的 id（界面上"去队列里看"）。 */
  approval_item_id?: string
}

export interface MembershipRequestInput {
  /** 贴进来的邀请码；与 `peer_id` 二选一。 */
  code?: string | undefined
  /** 局域网上挑中的那位同伴；与 `code` 二选一。 */
  peer_id?: string | undefined
  name: string
  email: string
  /**
   * **机器之间**用的那一半：申请人的服务进程把请求转给同伴时带上自己算出的公司钥匙，
   * 收件端拿它比一比"我们是不是同一家"。它是哈希，不泄漏公司全称；
   * 人从界面上永远填不到它（界面填的是 `peer_id`）。
   */
  company_key?: string | undefined
  /** 转发方自己的 peer id（46 I3 要知道"这条申请是谁递过来的"）。 */
  from_peer?: string | undefined
}

/** 46 I3：对方说"我这边已经定了，你那条别等了"。 */
export interface SupersedeInput {
  peer_id: string
  company_key: string
  reason?: string | undefined
}

export interface OnboardingPort {
  state(actor: OnboardingActor): MaybePromise<OnboardingStateView>
  setProfile(
    actor: OnboardingActor,
    input: WorkspaceProfileInput,
  ): MaybePromise<WorkspaceProfileView>
  /** 向导第 ③ 步的候选（岗位 → 职责 + 每条一句"它会干什么"）。 */
  positions(actor: OnboardingActor): MaybePromise<OnboardingPositionView[]>
  plan(actor: OnboardingActor, input: OnboardingPlanInput): MaybePromise<OnboardingPlanView>
  apply(actor: OnboardingActor, input: OnboardingPlanInput): MaybePromise<OnboardingApplyView>
  /** 46 §2 I2：局域网同伴。开关关着时 `peers` 是空的，且不发一个包。 */
  peers(actor: OnboardingActor): MaybePromise<DiscoveryStateView>
  /** 同伴打过来问"你是谁"。**公开**——对方这会儿在我们这里还什么都不是。 */
  hello(): MaybePromise<DiscoveryHelloView>
  invites(actor: OnboardingActor): MaybePromise<InviteView[]>
  createInvite(
    actor: OnboardingActor,
    input: { uses?: number | undefined },
  ): MaybePromise<InviteView>
  requests(actor: OnboardingActor): MaybePromise<MembershipRequestView[]>
  /** **公开**：申请人这会儿在目标工作区里还没有任何凭据，只有一个邀请码或一个同伴地址。 */
  request(input: MembershipRequestInput): MaybePromise<MembershipRequestView>
  decideRequest(
    actor: OnboardingActor,
    id: string,
    input: { approve: boolean; reason?: string | undefined },
  ): MaybePromise<MembershipRequestView>
  /** **公开**：同伴的服务进程告诉我们"先批的那一边已经定了"。 */
  superseded(input: SupersedeInput): MaybePromise<{ voided: number }>
}

// ── 校验 ───────────────────────────────────────────────────────────────

const ProfileBody = z.object({
  legal_name: z.string().min(1).max(200),
  domain: z.string().max(253).optional(),
  discoverable: z.boolean().optional(),
})

const PlanBody = z.object({
  position_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
  role_ids: z.array(z.string().min(1).max(64)).max(200).default([]),
  custom_position_name: z.string().min(1).max(64).optional(),
})

const InviteBody = z.object({ uses: z.number().int().min(1).max(50).optional() })

const RequestBody = z
  .object({
    code: z.string().min(4).max(32).optional(),
    peer_id: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(64),
    email: z.string().min(3).max(254),
    // 机器之间转发时带的那两样（界面永远不填）
    company_key: z.string().min(16).max(128).optional(),
    from_peer: z.string().min(1).max(128).optional(),
  })
  .refine((v) => v.code !== undefined || v.peer_id !== undefined || v.company_key !== undefined, {
    message: '要么贴一个邀请码，要么挑一位局域网上的同伴',
  })

const SupersedeBody = z.object({
  peer_id: z.string().min(1).max(128),
  company_key: z.string().min(16).max(128),
  reason: z.string().min(1).max(200).optional(),
})

const DecideBody = z.object({
  approve: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
})

// ── 装配 ───────────────────────────────────────────────────────────────

function portOf(deps: GatewayDeps): OnboardingPort {
  const p = deps.onboarding
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配首次设置面（GatewayDeps.onboarding）',
    )
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): OnboardingActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function onboardingRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/onboarding/state',
        operationId: 'getOnboardingState',
        summary: '要不要走首次设置向导（46 §1：公司档案没设过 + 除所有者外没有分配）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 读"我这个工作区要不要走向导"是读自己的绑定：普通成员也该看得到，
        // 否则他登录后永远进不了那四步（31 §3.1 的自助豁免）。
        authzBypass: () => true,
        returns: 'OnboardingStateView',
      },
      async (c, deps) => ok(c, await portOf(deps).state(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/workspace/profile',
        operationId: 'setWorkspaceProfile',
        summary: '写公司档案：全称、可选域名、"让同事找到我"开关（46 §1 ①）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ProfileBody,
        returns: 'WorkspaceProfileView（**不含**归一化哈希）',
      },
      async (c, deps) => {
        const input = await body(c, ProfileBody)
        return ok(
          c,
          await portOf(deps).setProfile(actorOf(c), {
            legal_name: input.legal_name,
            ...(input.domain === undefined ? {} : { domain: input.domain }),
            ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/onboarding/positions',
        operationId: 'listOnboardingPositions',
        summary: '向导第 ③ 步的候选：岗位、它包含的职责、每条一句"它会干什么"（27）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'OnboardingPositionView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).positions(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/onboarding/plan',
        operationId: 'planOnboarding',
        summary: '勾选 → 要连的平台 / 要装的技能 / 要建的岗位（46 §3 I5，只算不写）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        body: PlanBody,
        returns: 'OnboardingPlanView',
      },
      async (c, deps) => {
        const input = await body(c, PlanBody)
        return ok(c, await portOf(deps).plan(actorOf(c), planInput(input)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/onboarding/apply',
        operationId: 'applyOnboarding',
        summary: '真建分配（46 §3 I6：一个岗位一条 Assignment；只勾职责 → 一个自定义岗位）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: PlanBody,
        returns: 'OnboardingApplyView',
      },
      async (c, deps) => {
        const input = await body(c, PlanBody)
        return ok(c, await portOf(deps).apply(actorOf(c), planInput(input)), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/discovery/peers',
        operationId: 'listDiscoveryPeers',
        summary: '局域网上同一家公司的同伴（46 §2 I2；开关关着时永远是空的）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'DiscoveryStateView',
      },
      async (c, deps) => ok(c, await portOf(deps).peers(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/discovery/hello',
        operationId: 'discoveryHello',
        summary: '同伴问"你是谁"：只回一个展示名与人数（46 §2：全称与名单永不出去）',
        tag: TAG,
        // 公开：对方这会儿在我们这里还没有任何凭据。回的东西也只值这么多。
        auth: 'public',
        returns: 'DiscoveryHelloView',
      },
      async (c, deps) => ok(c, await portOf(deps).hello()),
    ),
    route(
      {
        method: 'get',
        path: '/v1/invites',
        operationId: 'listInvites',
        summary: '这个工作区还没过期的邀请码（46 §2 I2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'InviteView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).invites(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/invites',
        operationId: 'createInvite',
        summary: '发一个邀请码：8 位人类可读、24h、默认 5 次（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: InviteBody,
        returns: 'InviteView（明文码只在这一次出现）',
      },
      async (c, deps) => {
        const input = await body(c, InviteBody)
        return ok(
          c,
          await portOf(deps).createInvite(actorOf(c), input.uses === undefined ? {} : input),
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/memberships/requests',
        operationId: 'listMembershipRequests',
        summary: '谁申请过加入这个工作区（46 §2 I3）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MembershipRequestView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).requests(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/memberships/requests',
        operationId: 'requestMembership',
        summary: '申请加入：贴邀请码或挑一位局域网同伴 → 对方 owner 收一张 membership 卡',
        tag: TAG,
        // 公开：申请人在目标工作区里还什么都不是，只有一个码或一个地址（与接受邀请同理）。
        auth: 'public',
        body: RequestBody,
        returns: 'MembershipRequestView（`status: pending`——批了才算数）',
      },
      async (c, deps) => {
        const input = await body(c, RequestBody)
        return ok(
          c,
          await portOf(deps).request({
            name: input.name,
            email: input.email,
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.peer_id === undefined ? {} : { peer_id: input.peer_id }),
            ...(input.company_key === undefined ? {} : { company_key: input.company_key }),
            ...(input.from_peer === undefined ? {} : { from_peer: input.from_peer }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/discovery/superseded',
        operationId: 'supersedeMembershipRequests',
        summary: '同伴说"先批的那一边已经定了"：与他之间还悬着的申请一律作废（46 I3）',
        tag: TAG,
        // 公开，但要带上同一把公司钥匙才作数；而且它只作废「还悬着的申请」，
        // 不删任何数据、不动任何成员——最坏情况是申请人再点一次。
        auth: 'public',
        body: SupersedeBody,
        returns: '{ voided }',
      },
      async (c, deps) => {
        const input = await body(c, SupersedeBody)
        return ok(
          c,
          await portOf(deps).superseded({
            peer_id: input.peer_id,
            company_key: input.company_key,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/memberships/requests/:id/decide',
        operationId: 'decideMembershipRequest',
        summary: '同意 / 拒绝一条申请（owner）；同意后建成员并交给 20 §4 Join',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '申请 id' }],
        body: DecideBody,
        returns: 'MembershipRequestView',
      },
      async (c, deps) => {
        const input = await body(c, DecideBody)
        return ok(
          c,
          await portOf(deps).decideRequest(actorOf(c), param(c, 'id'), {
            approve: input.approve,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        )
      },
    ),
  ]
}

function planInput(input: z.infer<typeof PlanBody>): OnboardingPlanInput {
  return {
    position_ids: input.position_ids,
    role_ids: input.role_ids,
    ...(input.custom_position_name === undefined
      ? {}
      : { custom_position_name: input.custom_position_name }),
  }
}
