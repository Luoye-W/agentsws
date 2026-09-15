/**
 * 52 O1–O4（WP65）：组织（公司）与品牌工作区的装配。
 *
 * 这个模块把三样东西缝在一起——身份层的组织面（`@agentsws/api` 的 `organizations.ts`）、
 * 职责库（分配是品牌级的）、审批总线（品牌一览那几个数）——并守住四条：
 *
 * 1. **隔离不是这里给的**。两个品牌互相看不见，靠的是所有数据本来就按 `workspace_id`
 *    切（20）。这个文件里没有一行"过滤 brand_id"——真要有，那就说明隔离是假的。
 * 2. **组织级只放人、钱、发现**（52 O3）。建品牌会在新工作区里建一条 owner 分配，
 *    除此之外不往里塞任何东西：连接、知识、事项一律由这个品牌自己从零开始。
 * 3. **复制 ≠ 共享**（52 O4）。"从某个品牌复制"只复制**职责分配**，而且**不带范围**
 *    ——范围是源品牌的店，新品牌还没有店；连接与知识一个字节都不复制。
 * 4. **切品牌只换一张票**。`switchBrand` 签一张绑目标工作区的会话 token，
 *    不改任何数据、不发内核事件（52 §4）；本人在目标品牌没有成员资格一律 403。
 */
import type {
  BrandCopyView,
  BrandSwitchView,
  BrandView,
  CreateBrandInput,
  LocalIdentityService,
  OrganizationActor,
  OrganizationInviteView,
  OrganizationMemberView,
  OrganizationOffboardView,
  OrganizationProfileInput,
  OrganizationsPort,
  OrganizationView,
} from '@agentsws/api'
import { ApiError, canAdministerOrganization, organizationRoleOf } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalState,
  Clock,
  EventEnvelope,
  Organization,
  PersonId,
  StorefrontPlatform,
  Workspace,
  WorkspaceId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import { brandNameOf } from '@agentsws/contracts'
import { companyKey } from '@agentsws/core'
import type { RoleStore } from '@agentsws/roles'

/** 品牌级档案里这一版真正按品牌分开的两样（46 §1 / 51 §1 N0）。 */
export interface BrandProfile {
  vertical?: WorkspaceVertical
  storefront_platform?: StorefrontPlatform
}

export interface OrganizationsAssemblyOptions {
  clock: Clock
  identity: LocalIdentityService
  roles: RoleStore
  approvals: ApprovalBus
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个服务进程这会儿装配的是哪个品牌（活数据源只有它有）。 */
  currentWorkspace(): WorkspaceId
  /** 品牌级档案：读一个品牌的「你卖的是」「网站平台」。 */
  brandProfile(workspace_id: WorkspaceId): BrandProfile | undefined
  /** 建品牌时把这两样写进去。 */
  setBrandProfile(workspace_id: WorkspaceId, profile: BrandProfile): void
  /**
   * 今日销售（面板已有的那条查询）。**只对当前品牌有**——别的品牌这会儿没有取数的
   * 通道，返回 `undefined` 让界面明说"切过去才看得到"，而不是画一个 0（36 §3）。
   */
  salesToday?(): { amount: number; currency: string } | undefined
  /** 会话 token 的有效期；与身份服务默认一致（12h）。 */
  sessionTtlMs?: number
  /** 桌面壳走 HttpOnly cookie 时不把明文 token 回给前端（13 §5）。 */
  exposeSessionToken?: boolean
  /**
   * 52 O3「发现」：公司档案从**组织这一侧**改了之后要真的去开 / 关局域网广播。
   *
   * 发现开关的真源是组织（46 §2 的 `company_key` 也从组织算），但"开 / 关"这个
   * 动作在首次设置那一面（`discovery`）。两边改都得生效，所以这里留一个钩子。
   */
  onCompanyChanged?(input: {
    by: PersonId
    discoverable: boolean
    /** 全称或域名变了 = 钥匙变了，要用新钥匙重新广播。 */
    key_changed: boolean
  }): void
}

export interface OrganizationsAssembly {
  port: OrganizationsPort
  /**
   * 启动时的一次性迁移（52 O1）：没有 `org_id` 的工作区建一个组织（用公司档案的三字段
   * 与 owner），并把 `brand.name` 回填成工作区名。已经挂过的一个字节不动。
   */
  migrate(input: {
    workspace_id: WorkspaceId
    legal_name?: string
    domain?: string
    discoverable?: boolean
  }): Promise<Organization>
  /** 当前品牌挂在哪个组织下（发现与 `company_key` 取它，46 §2）。 */
  organizationOf(workspace_id: WorkspaceId): Organization | undefined
}

/** 队列上"还没定"的那几档（与工作台首页同一套判据）。 */
const OPEN_STATES = ['pending', 'in_review'] as const
/** "告警"那一格：过期没人管的，和施行失败的。 */
const ALERT_STATES = ['expired', 'apply_failed'] as const

const DEFAULT_SESSION_TTL = 12 * 60 * 60 * 1000

export function createOrganizations(options: OrganizationsAssemblyOptions): OrganizationsAssembly {
  const { identity, clock, roles, approvals } = options

  const emit = (
    type: 'organization.created' | 'brand.created',
    workspace_id: WorkspaceId,
    actor: PersonId,
    payload: Record<string, unknown>,
  ): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: `tr_org_${clock.now()}` },
      payload,
    })
  }

  const needOrg = (id: string): Organization => {
    const org = identity.getOrganization(id)
    if (org === undefined) throw new ApiError('not_found', `公司不存在：${id}`)
    return org
  }

  /** 看这家公司要在里面（离职的也不算）；不在一律 not_found，不给探测的余地。 */
  const needMember = (id: string, person_id: PersonId): Organization => {
    const org = needOrg(id)
    if (organizationRoleOf(org, person_id) === undefined)
      throw new ApiError('not_found', `公司不存在：${id}`)
    return org
  }

  /** 改公司、建品牌、邀请、离职：owner 与 admin 才行。 */
  const needAdmin = (id: string, person_id: PersonId): Organization => {
    const org = needMember(id, person_id)
    if (!canAdministerOrganization(org, person_id))
      throw new ApiError('forbidden', '只有公司的所有者或管理员能做这件事')
    return org
  }

  const activeMembers = (org: Organization): Organization['members'] =>
    org.members.filter((m) => m.left_at === undefined)

  const viewOf = (org: Organization, person_id: PersonId): OrganizationView => {
    const brands = identity.brandsOf(org.id)
    const members = activeMembers(org)
    return {
      id: org.id,
      legal_name: org.legal_name,
      ...(org.domain === undefined ? {} : { domain: org.domain }),
      discoverable: org.discoverable,
      owner_id: org.owner_id,
      role: organizationRoleOf(org, person_id) ?? 'member',
      ...(org.cloud_org_id === undefined ? {} : { cloud_org_id: org.cloud_org_id }),
      brands: brands.length,
      members: members.length,
      // 52 O1：一个人、一个品牌 = 个人用户，界面上一律不提"组织"这两个字
      solo: members.length <= 1 && brands.length <= 1,
      created_at: org.created_at,
    }
  }

  const brandViewOf = async (
    workspace: Workspace,
    actor: OrganizationActor,
  ): Promise<BrandView> => {
    const profile = options.brandProfile(workspace.id)
    const current = workspace.id === options.currentWorkspace()
    const open = await approvals.queue({
      workspace_id: workspace.id,
      person_id: actor.person_id,
      lane: 'scope',
      state: [...OPEN_STATES] as ApprovalState[],
    })
    const alerts = await approvals.queue({
      workspace_id: workspace.id,
      person_id: actor.person_id,
      lane: 'scope',
      state: [...ALERT_STATES] as ApprovalState[],
    })
    const sales = current ? options.salesToday?.() : undefined
    return {
      workspace_id: workspace.id,
      name: brandNameOf(workspace),
      ...(workspace.brand?.logo === undefined ? {} : { logo: workspace.brand.logo }),
      current,
      ...(profile?.vertical === undefined ? {} : { vertical: profile.vertical }),
      ...(profile?.storefront_platform === undefined
        ? {}
        : { storefront_platform: profile.storefront_platform }),
      pending_approvals: open.length,
      alerts: alerts.length,
      ...(sales === undefined ? {} : { sales_today: sales }),
    }
  }

  /** 这个人在这个品牌里有没有成员资格（切换器与 `brandsOf` 的同一把尺）。 */
  const isMemberOf = (workspace_id: WorkspaceId, person_id: PersonId): boolean =>
    identity.workspacesOf(person_id).some((w) => w.id === workspace_id)

  const port: OrganizationsPort = {
    async list(actor): Promise<OrganizationView[]> {
      return identity.organizationsOf(actor.person_id).map((o) => viewOf(o, actor.person_id))
    },

    async create(actor, input): Promise<OrganizationView> {
      const org = await identity.createOrganization({
        legal_name: input.legal_name,
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
        owner_id: actor.person_id,
      })
      // 46 §1 ① 上半块建完，当前这个品牌工作区就挂到它下面（第 ① 步的两块是一步）
      const current = await identity.getWorkspace(actor.workspace_id)
      if (current !== undefined && current.org_id === undefined)
        await identity.attachWorkspaceToOrg({
          workspace_id: current.id,
          org_id: org.id,
        })
      // 与 `workspace.profile_set` 同一条纪律：只记哈希与有没有域名，全称不进日志
      emit('organization.created', actor.workspace_id, actor.person_id, {
        organization_id: org.id,
        company_key: companyKey(org.legal_name, org.domain),
        has_domain: org.domain !== undefined,
        discoverable: org.discoverable,
      })
      return viewOf(org, actor.person_id)
    },

    async update(actor, id, input: OrganizationProfileInput): Promise<OrganizationView> {
      const before = needAdmin(id, actor.person_id)
      const next = await identity.updateOrganization(id, {
        ...(input.legal_name === undefined ? {} : { legal_name: input.legal_name }),
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
      })
      options.onCompanyChanged?.({
        by: actor.person_id,
        discoverable: next.discoverable,
        key_changed:
          companyKey(before.legal_name, before.domain) !== companyKey(next.legal_name, next.domain),
      })
      return viewOf(next, actor.person_id)
    },

    async brands(actor, org_id): Promise<BrandView[]> {
      needMember(org_id, actor.person_id)
      // 52 O2：只回本人有成员资格的品牌——下拉里不该出现他进不去的那些
      const mine = identity.brandsOf(org_id, actor.person_id)
      return Promise.all(mine.map((w) => brandViewOf(w, actor)))
    },

    async createBrand(actor, org_id, input: CreateBrandInput): Promise<BrandView> {
      needAdmin(org_id, actor.person_id)
      const name = input.name.trim()
      if (name === '') throw new ApiError('invalid_input', '品牌名不能为空')
      const siblings = identity.brandsOf(org_id)
      if (siblings.some((w) => brandNameOf(w) === name))
        throw new ApiError('conflict', `这家公司下已经有一个叫「${name}」的品牌了`)
      const workspace = await identity.createWorkspace({
        name,
        owner_id: actor.person_id,
        kind: 'shared',
        org_id,
        brand_name: name,
      })
      options.setBrandProfile(workspace.id, {
        ...(input.vertical === undefined ? {} : { vertical: input.vertical }),
        ...(input.storefront_platform === undefined
          ? {}
          : { storefront_platform: input.storefront_platform }),
      })
      // 新品牌里先有一条 owner 分配——不然建完连自己都进不去（20 §1）
      roles.assignments.create({
        person_id: actor.person_id,
        workspace_id: workspace.id,
        role_id: 'common.owner',
        granted_by: actor.person_id,
        ranges: [],
      })
      emit('brand.created', workspace.id, actor.person_id, {
        organization_id: org_id,
        workspace_id: workspace.id,
        ...(input.copy_from === undefined ? {} : { copied_from: input.copy_from }),
      })
      if (input.copy_from !== undefined)
        await port.copyFrom(actor, org_id, workspace.id, input.copy_from)
      return brandViewOf((await identity.getWorkspace(workspace.id)) ?? workspace, actor)
    },

    async members(actor, org_id): Promise<OrganizationMemberView[]> {
      const org = needMember(org_id, actor.person_id)
      const brands = identity.brandsOf(org_id)
      const out: OrganizationMemberView[] = []
      for (const m of org.members) {
        const person = await identity.getPerson(m.person_id)
        out.push({
          person_id: m.person_id,
          name: person?.name ?? m.person_id,
          email: person?.email ?? '',
          role: m.role,
          joined_at: m.joined_at,
          ...(m.left_at === undefined ? {} : { left_at: m.left_at }),
          brands: brands.filter((w) => isMemberOf(w.id, m.person_id)).map((w) => w.id),
        })
      }
      return out
    },

    async invite(actor, org_id, input): Promise<OrganizationInviteView> {
      needAdmin(org_id, actor.person_id)
      const brands = identity.brandsOf(org_id)
      for (const ws of input.brands)
        if (!brands.some((w) => w.id === ws))
          throw new ApiError('not_found', `这家公司下没有这个品牌：${ws}`)
      /*
       * 52 O3「邀请进组织一次」：先把人放进公司名单，再按勾的品牌各发一张一次性链接。
       *
       * 这里会为这个邮箱建一条 `Person`（还没有的话）——`Person` 只是"邮箱 + 名字"，
       * 不含任何凭据，也不带任何权限；真进得来仍要他自己点那张一次性链接。
       * 不这么做的话，"人进了公司但还没进任何品牌"这个 52 O3 明确要有的中间态就存不住。
       */
      const person = await identity.createPerson({
        email: input.email,
        name: input.name ?? input.email.split('@')[0] ?? input.email,
      })
      await identity.addOrganizationMember({
        org_id,
        person_id: person.id,
        ...(input.role === undefined ? {} : { role: input.role }),
      })
      const tokens: OrganizationInviteView['tokens'] = []
      for (const ws of input.brands) {
        const issued = await identity.createInvitation({
          workspace_id: ws,
          email: input.email,
          ...(input.name === undefined ? {} : { name: input.name }),
          invited_by: actor.person_id,
        })
        tokens.push({
          workspace_id: ws,
          token: issued.token,
          expires_at: issued.invitation.expires_at,
        })
      }
      return {
        email: person.email,
        role: organizationRoleOf(needOrg(org_id), person.id) ?? 'member',
        brands: input.brands,
        tokens,
      }
    },

    async offboard(actor, org_id, person_id): Promise<OrganizationOffboardView> {
      needAdmin(org_id, actor.person_id)
      // 40 E2：身份层一次撤全部品牌的成员关系与 token；分配的撤销在这里跟着走
      const removed = await identity.removeOrganizationMember(org_id, person_id)
      let revoked = 0
      for (const ws of identity.brandsOf(org_id)) {
        for (const a of roles.assignments.listByPerson(person_id, { workspace_id: ws.id })) {
          if (a.revoked_at !== undefined) continue
          roles.assignments.revoke(a.id)
          revoked += 1
        }
      }
      return {
        person_id,
        brands: removed.brands,
        revoked_assignments: revoked,
      }
    },

    async copyFrom(actor, org_id, workspace_id, from): Promise<BrandCopyView> {
      needAdmin(org_id, actor.person_id)
      const brands = identity.brandsOf(org_id)
      const target = brands.find((w) => w.id === workspace_id)
      const source = brands.find((w) => w.id === from)
      if (target === undefined)
        throw new ApiError('not_found', `这家公司下没有这个品牌：${workspace_id}`)
      if (source === undefined) throw new ApiError('not_found', `这家公司下没有这个品牌：${from}`)
      if (source.id === target.id) throw new ApiError('invalid_input', '不能从自己复制到自己')
      const existing = new Set(
        roles.assignments
          .listByWorkspace(target.id)
          .filter((a) => a.revoked_at === undefined)
          .map((a) => `${a.person_id}|${a.role_id}`),
      )
      let copied = 0
      let dropped = 0
      for (const a of roles.assignments.listByWorkspace(source.id)) {
        if (a.revoked_at !== undefined) continue
        // 只复制**本公司现在还在的人**的分配（离职的不跟着搬）
        if (organizationRoleOf(needOrg(org_id), a.person_id) === undefined) continue
        if (existing.has(`${a.person_id}|${a.role_id}`)) continue
        // 范围是源品牌的店，新品牌还没有店——复制过去只会指向一个看不见的东西
        if (a.ranges.length > 0) dropped += a.ranges.length
        roles.assignments.create({
          person_id: a.person_id,
          workspace_id: target.id,
          role_id: a.role_id,
          granted_by: actor.person_id,
          ranges: [],
        })
        existing.add(`${a.person_id}|${a.role_id}`)
        copied += 1
      }
      return {
        from: source.id,
        to: target.id,
        copied_assignments: copied,
        dropped_ranges: dropped,
        // 这台机器上模型 key 是共用的（49 M1 的余额也在公司级），没什么可复制的
        models_shared: true,
      }
    },

    async switchBrand(actor, org_id, workspace_id): Promise<BrandSwitchView> {
      needMember(org_id, actor.person_id)
      const workspace = identity.brandsOf(org_id).find((w) => w.id === workspace_id)
      if (workspace === undefined)
        throw new ApiError('not_found', `这家公司下没有这个品牌：${workspace_id}`)
      if (!isMemberOf(workspace.id, actor.person_id))
        throw new ApiError('forbidden', '你不在这个品牌里；让公司管理员把你加进去')
      const issued = identity.issue(
        'session',
        actor.person_id,
        workspace.id,
        options.sessionTtlMs ?? DEFAULT_SESSION_TTL,
      )
      return {
        workspace_id: workspace.id,
        name: brandNameOf(workspace),
        // 桌面壳那条路走 HttpOnly cookie，明文 token 不回给前端（13 §5）
        ...(options.exposeSessionToken === false ? {} : { session_token: issued.token }),
        ...(issued.expires_at === undefined ? {} : { expires_at: issued.expires_at }),
      }
    },
  }

  return {
    port,
    async migrate(input): Promise<Organization> {
      const migrated = await identity.migrateWorkspace(input)
      if (migrated.created)
        emit('organization.created', input.workspace_id, migrated.organization.owner_id, {
          organization_id: migrated.organization.id,
          company_key: companyKey(migrated.organization.legal_name, migrated.organization.domain),
          has_domain: migrated.organization.domain !== undefined,
          discoverable: migrated.organization.discoverable,
          migrated: true,
        })
      return migrated.organization
    },
    organizationOf(workspace_id): Organization | undefined {
      // 工作区身上就写着它挂在哪个组织下（52 O1）——不用反过来扫组织
      const org_id = identity
        .listOrganizations()
        .find((o) => identity.brandsOf(o.id).some((w) => w.id === workspace_id))
      return org_id
    },
  }
}
