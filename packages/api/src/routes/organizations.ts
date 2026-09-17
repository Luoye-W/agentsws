/**
 * 52 O1–O4（WP65）：**组织**（公司）与它下面的**品牌工作区**。
 *
 * 一句话：品牌 = 工作区，公司 = 组织。数据隔离不是这一层给的——它早就由
 * `workspace_id` 给了（20）；这一层只回答三个问题：
 *
 * 1. 我在哪几家公司、每家有哪几个品牌（`GET /v1/orgs`、`/v1/orgs/:id/brands`）；
 * 2. 公司这一层的人怎么进怎么出（`/v1/orgs/:id/members`，邀请进组织 + 勾品牌；
 *    离职按组织一次撤全部品牌，40 E2）；
 * 3. 怎么加一个品牌、怎么从已有品牌复制一份设置、怎么切过去
 *    （`POST /v1/orgs/:id/brands`、`/brands/:ws/copy-from`、`/brands/:ws/switch`）。
 *
 * 四条边界：
 *
 * - **网关里不写业务**（28 §2）：真源在 `apps/server/src/organizations.ts`，
 *   这一层只做路由声明、权限判定与信封。
 * - **组织级只放人、钱、发现**（52 O3）。这里没有一条路由碰连接、知识、职责分配——
 *   那些一律是品牌级的，走各自已有的路由，天然按 `workspace_id` 隔离。
 * - **看得见 ≠ 进得去**：`/v1/orgs/:id/brands` 只回**本人有成员资格**的品牌，
 *   切换器的下拉里不该出现他进不去的品牌。
 * - **切品牌不进内核日志**（52 §4）：`switch` 只是换一张绑新工作区的会话 token，
 *   不改任何数据，所以它不发 `brand.switched` 那类内核事件。
 */
import type { MaybePromise, StorefrontPlatform, WorkspaceVertical } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 改公司档案 / 建品牌 / 邀请 / 离职：05 owner 的策略层写权限。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/** 看公司与品牌：策略层读权限；"我自己在哪几个品牌"走自助豁免（见下）。 */
const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const TAG = 'organization'

export interface OrganizationActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 52 O1：一家公司。 */
export interface OrganizationView {
  id: string
  legal_name: string
  domain?: string
  discoverable: boolean
  owner_id: string
  /** 当前这个人在这家公司里是什么角色。 */
  role: 'owner' | 'admin' | 'member'
  /** 49 M1：挂上的云侧组织（余额与订阅在它上面）；没关联就没有。 */
  cloud_org_id?: string
  brands: number
  members: number
  /**
   * 52 O1 个人用户：**一个人、一个品牌**。为真时界面上一律不显示"组织"这个词
   * ——不出切换器、不出组织卡，直到加第二个品牌或第二个人。
   */
  solo: boolean
  created_at: string
}

/** 组织页"品牌一览"里的一行（52 O2）。 */
export interface BrandView {
  workspace_id: string
  name: string
  logo?: string
  /** 这一行是不是当前正开着的品牌。 */
  current: boolean
  vertical?: WorkspaceVertical
  storefront_platform?: StorefrontPlatform
  /** 待审卡数（审批总线按这个品牌的 `workspace_id` 数出来的，不是估的）。 */
  pending_approvals: number
  /** 逾期 / 升级过的卡（"告警数"那一格）。 */
  alerts: number
  /**
   * 今日销售。
   *
   * WP66 起**每个品牌都有**：一个进程装多套品牌模块之后，每个品牌各有自己的
   * 活数据源，这一格与它自己首页那个数字块读的是同一条查询。
   *
   * 仍然可能没有——这个品牌一家店都没连、或者这会儿一张订单都没拉到。
   * 那时候照 36 §3 不给这个字段（没有就明说没有，不画一个 0）。
   */
  sales_today?: { amount: number; currency: string }
}

export interface OrganizationMemberView {
  person_id: string
  name: string
  email: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
  left_at?: string
  /** 他在这家公司的哪几个品牌里（`workspace_id`）。 */
  brands: string[]
}

/** 邀请进组织的回执（明文邀请 token 只在这一次出现）。 */
export interface OrganizationInviteView {
  email: string
  role: 'owner' | 'admin' | 'member'
  /** 勾了进哪几个品牌（52 O3：邀请进组织一次，品牌是勾出来的）。 */
  brands: string[]
  /** 每个品牌各一张邀请链接的明文 token（一次性、24h）。 */
  tokens: { workspace_id: string; token: string; expires_at: string }[]
}

/** 40 E2：离职按组织一次撤全部品牌。 */
export interface OrganizationOffboardView {
  person_id: string
  /** 撤了哪几个品牌的成员关系（token 同时失效）。 */
  brands: string[]
  /** 一起撤掉的分配条数（人 × 职责 × 范围）。 */
  revoked_assignments: number
}

/** "加一个品牌"（52 O4）。 */
export interface CreateBrandInput {
  name: string
  vertical?: WorkspaceVertical | undefined
  storefront_platform?: StorefrontPlatform | undefined
  /** 从这个品牌复制设置（职责分配与模型设置）；不给就是空白品牌。 */
  copy_from?: string | undefined
}

/**
 * "从某个品牌复制设置"的回执（52 O4）。
 *
 * **连接与知识不复制**——那是这个品牌自己的凭据与自己的事实，复制过去只会串味。
 */
export interface BrandCopyView {
  from: string
  to: string
  /** 复制出来的分配条数。 */
  copied_assignments: number
  /**
   * 范围（店铺 / 账号 / 市场）**不跟着复制**：它们是源品牌的店，新品牌还没有店。
   * 复制出来的分配范围一律是空的，等新品牌连上自己的店再挂。
   */
  dropped_ranges: number
  /**
   * WP66 之前：模型设置在这台机器上是**共用**的（一把 key 全品牌用），没什么可复制的。
   *
   * WP66 起模型设置按品牌各一份，所以这一位恒为 `false`，复制了几条看
   * {@link BrandCopyView.copied_model_providers}。字段留着不删（契约只加不删），
   * 老前端看到 `false` 就不显示那句"本来就共用"，正好。
   */
  models_shared: boolean
  /**
   * WP66（52 O4）：从源品牌复制过来的模型 provider 条数（含默认模型与按 purpose 的选择）。
   *
   * **key 不复制**：加密库里那一条是按品牌存的，复制一把 key 过去等于把一条凭据
   * 悄悄多放一处（13 §4.3）。复制出来的那几条显示"还没填 key"，去新品牌里填一次。
   */
  copied_model_providers?: number
  /**
   * 这个新品牌从此**跟不跟随公司默认**（52 O3）。
   *
   * 复制过设置就等于"我要自己一套"，所以复制之后这一位是 `false`；
   * 没复制过的新品牌默认跟随，一行设置都不用填。
   */
  inherit_org?: boolean
}

/** 切品牌（52 O2）：换一张绑新工作区的会话 token，整个工作台重载。 */
export interface BrandSwitchView {
  workspace_id: string
  name: string
  /**
   * 新的会话 token。桌面壳走 HttpOnly cookie 时**没有**这个字段
   * （前端看不到 token，13 §5）——那条路靠响应里的 `Set-Cookie`。
   */
  session_token?: string
  expires_at?: string
}

export interface OrganizationProfileInput {
  legal_name?: string | undefined
  domain?: string | undefined
  discoverable?: boolean | undefined
}

export interface OrganizationsPort {
  /** 我在哪几家公司。 */
  list(actor: OrganizationActor): MaybePromise<OrganizationView[]>
  create(
    actor: OrganizationActor,
    input: { legal_name: string; domain?: string | undefined; discoverable?: boolean | undefined },
  ): MaybePromise<OrganizationView>
  update(
    actor: OrganizationActor,
    id: string,
    input: OrganizationProfileInput,
  ): MaybePromise<OrganizationView>
  /** 品牌一览；只回本人有成员资格的那几个。 */
  brands(actor: OrganizationActor, org_id: string): MaybePromise<BrandView[]>
  createBrand(
    actor: OrganizationActor,
    org_id: string,
    input: CreateBrandInput,
  ): MaybePromise<BrandView>
  members(actor: OrganizationActor, org_id: string): MaybePromise<OrganizationMemberView[]>
  invite(
    actor: OrganizationActor,
    org_id: string,
    input: {
      email: string
      name?: string | undefined
      role?: 'admin' | 'member' | undefined
      brands: string[]
    },
  ): MaybePromise<OrganizationInviteView>
  offboard(
    actor: OrganizationActor,
    org_id: string,
    person_id: string,
  ): MaybePromise<OrganizationOffboardView>
  copyFrom(
    actor: OrganizationActor,
    org_id: string,
    workspace_id: string,
    from: string,
  ): MaybePromise<BrandCopyView>
  switchBrand(
    actor: OrganizationActor,
    org_id: string,
    workspace_id: string,
  ): MaybePromise<BrandSwitchView>
}

// ── 校验 ───────────────────────────────────────────────────────────────

const CreateOrgBody = z.object({
  legal_name: z.string().min(1).max(200),
  domain: z.string().max(253).optional(),
  discoverable: z.boolean().optional(),
})

const PatchOrgBody = z.object({
  legal_name: z.string().min(1).max(200).optional(),
  domain: z.string().max(253).optional(),
  discoverable: z.boolean().optional(),
})

const CreateBrandBody = z.object({
  name: z.string().min(1).max(64),
  vertical: z.enum(['goods', 'digital']).optional(),
  storefront_platform: z.enum(['shopify', 'woocommerce', 'magento', 'other', 'none']).optional(),
  copy_from: z.string().min(1).max(64).optional(),
})

const InviteBody = z.object({
  email: z.string().min(3).max(254),
  name: z.string().min(1).max(64).optional(),
  role: z.enum(['admin', 'member']).optional(),
  /** 勾进哪几个品牌；一个都不勾 = 先进公司，之后再由 owner 决定（52 O3）。 */
  brands: z.array(z.string().min(1).max(64)).max(50).default([]),
})

const CopyFromBody = z.object({ from: z.string().min(1).max(64) })

function portOf(deps: GatewayDeps): OrganizationsPort {
  const p = deps.organizations
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配组织面（GatewayDeps.organizations）')
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): OrganizationActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function organizationRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/orgs',
        operationId: 'listOrganizations',
        summary: '我在哪几家公司（52 O1；个人用户 `solo: true`，界面上不显示组织）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 自助豁免（31 §3.1）：顶栏切换器人人要用——不让普通成员读这一条，
        // 他就永远切不了品牌。回的东西也只值这么多：公司名与品牌计数。
        authzBypass: () => true,
        returns: 'OrganizationView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/orgs',
        operationId: 'createOrganization',
        summary: '建一家公司（46 §1 ① 上半块：全称、域名、发现开关）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: CreateOrgBody,
        returns: 'OrganizationView',
      },
      async (c, deps) => {
        const input = await body(c, CreateOrgBody)
        return ok(
          c,
          await portOf(deps).create(actorOf(c), {
            legal_name: input.legal_name,
            ...(input.domain === undefined ? {} : { domain: input.domain }),
            ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/orgs/:id',
        operationId: 'updateOrganization',
        summary: '改公司档案：全称 / 域名 / 发现开关（46 §2 的 company_key 从这里算）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        body: PatchOrgBody,
        returns: 'OrganizationView',
      },
      async (c, deps) => {
        const input = await body(c, PatchOrgBody)
        return ok(
          c,
          await portOf(deps).update(actorOf(c), param(c, 'id'), {
            ...(input.legal_name === undefined ? {} : { legal_name: input.legal_name }),
            ...(input.domain === undefined ? {} : { domain: input.domain }),
            ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/orgs/:id/brands',
        operationId: 'listBrands',
        summary: '品牌一览：每个品牌一行（待审卡数 / 告警数 / 今日销售），点进去 = 切换',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 同 `GET /v1/orgs`：切换器要用；而且只回本人有成员资格的品牌
        authzBypass: () => true,
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        returns: 'BrandView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).brands(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/orgs/:id/brands',
        operationId: 'createBrand',
        summary: '加一个品牌 = 建一个新工作区（52 O4；可从某个品牌复制职责分配）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        body: CreateBrandBody,
        returns: 'BrandView',
      },
      async (c, deps) => {
        const input = await body(c, CreateBrandBody)
        return ok(
          c,
          await portOf(deps).createBrand(actorOf(c), param(c, 'id'), {
            name: input.name,
            ...(input.vertical === undefined ? {} : { vertical: input.vertical }),
            ...(input.storefront_platform === undefined
              ? {}
              : { storefront_platform: input.storefront_platform }),
            ...(input.copy_from === undefined ? {} : { copy_from: input.copy_from }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/orgs/:id/members',
        operationId: 'listOrganizationMembers',
        summary: '公司里的人，以及各自在哪几个品牌（52 O3「人」）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        returns: 'OrganizationMemberView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).members(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/orgs/:id/members',
        operationId: 'inviteToOrganization',
        summary: '邀请进公司一次 + 勾进哪几个品牌（52 O3；每个品牌各一张一次性链接）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        body: InviteBody,
        returns: 'OrganizationInviteView（明文 token 只在这一次出现）',
      },
      async (c, deps) => {
        const input = await body(c, InviteBody)
        return ok(
          c,
          await portOf(deps).invite(actorOf(c), param(c, 'id'), {
            email: input.email,
            brands: input.brands,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.role === undefined ? {} : { role: input.role }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/orgs/:id/members/:person_id',
        operationId: 'offboardFromOrganization',
        summary: '离职：按公司一次撤全部品牌的成员关系与分配（40 E2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: '组织 id' },
          { name: 'person_id', in: 'path', required: true, description: '人的 id' },
        ],
        returns: 'OrganizationOffboardView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).offboard(actorOf(c), param(c, 'id'), param(c, 'person_id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/orgs/:id/brands/:ws/copy-from',
        operationId: 'copyBrandSettings',
        summary: '从某个品牌复制设置到这个品牌（只复制职责分配；连接与知识不复制）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: '组织 id' },
          { name: 'ws', in: 'path', required: true, description: '目标品牌的 workspace_id' },
        ],
        body: CopyFromBody,
        returns: 'BrandCopyView',
      },
      async (c, deps) => {
        const input = await body(c, CopyFromBody)
        return ok(
          c,
          await portOf(deps).copyFrom(actorOf(c), param(c, 'id'), param(c, 'ws'), input.from),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/orgs/:id/brands/:ws/switch',
        operationId: 'switchBrand',
        summary: '切到这个品牌：换一张绑它的会话 token，整个工作台重载（52 O2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 切自己进得去的品牌是**自助**：普通成员不该因为读不了策略层就切不了品牌。
        // 真正的门在实现里——目标品牌本人没有成员资格一律 403。
        authzBypass: () => true,
        params: [
          { name: 'id', in: 'path', required: true, description: '组织 id' },
          { name: 'ws', in: 'path', required: true, description: '要切过去的 workspace_id' },
        ],
        returns: 'BrandSwitchView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).switchBrand(actorOf(c), param(c, 'id'), param(c, 'ws'))),
    ),
  ]
}
