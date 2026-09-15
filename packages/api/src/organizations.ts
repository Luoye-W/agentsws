/**
 * 52 O1（WP65）：**组织**这一层的全部逻辑，内存档与 SQLite 档共用一份。
 *
 * 两档身份服务只差"东西存在哪"——组织怎么建、成员怎么加、品牌怎么挂、离职怎么一撤全撤
 * 是同一套规矩，所以它们在这里写**一次**，两档各自注入一个 {@link OrgBackend}
 * 与几个取工作区的回调。一致性套件对两档各跑一遍，跑的就是这一份。
 *
 * 四条纪律：
 *
 * 1. **组织级只放人、钱、发现**（52 O3）。这个文件里没有一行碰连接、知识、职责分配——
 *    那些一律按 `workspace_id` 切，本来就隔离，不用再造一层。
 * 2. **离职不删行**（40 §1 / E2）。`left_at` 是一列；`removeMember` 返回"撤了哪几个品牌"，
 *    真去撤分配的是 roles 侧（身份层只管身份）。
 * 3. **挂品牌不是合并**（45 H1 改写）。`attachWorkspaceToOrg` 把一个品牌工作区整个挂到
 *    组织下，不动它里面的任何数据；只有 `brandKey` 撞上（两个人各自建了同一个品牌）
 *    才轮得到 45 的对照合并，而那是 `join.ts` 的事。
 * 4. **迁移只跑一次、只补不改**（`migrateWorkspace`）。已经有 `org_id` 的工作区一个字节不动。
 */

import type {
  Brand,
  Clock,
  Organization,
  OrganizationId,
  OrganizationMember,
  PersonId,
  Workspace,
  WorkspaceId,
} from '@agentsws/contracts'
import { brandNameOf } from '@agentsws/contracts'
import { ApiError } from './errors.js'

export type OrganizationRole = OrganizationMember['role']

export interface CreateOrganizationInput {
  legal_name: string
  domain?: string
  /** 46 §1 表：默认 true。 */
  discoverable?: boolean
  owner_id: PersonId
  /** 49 M1：关联云账号时才有。 */
  cloud_org_id?: string
  /** 只给装配 / 迁移用（要让 id 可预测）；平时不传。 */
  id?: OrganizationId
}

/** 改公司档案：不给的字段一律不动（`undefined` ≠ 清空）。 */
export interface OrganizationPatch {
  legal_name?: string
  domain?: string
  discoverable?: boolean
  cloud_org_id?: string
}

export interface AttachWorkspaceInput {
  workspace_id: WorkspaceId
  org_id: OrganizationId
  /** 不给就用工作区现在的品牌名（再没有就用工作区名）。 */
  brand_name?: string
}

/** 离职（40 E2）：组织成员收尾 + 这个人在**这个组织全部品牌**里的成员关系一起收。 */
export interface RemovedOrganizationMember {
  organization: Organization
  /** 一起撤掉的品牌工作区（roles 侧照这张单子撤分配）。 */
  brands: WorkspaceId[]
}

/** 一次性迁移的回执：`created` 为假 = 这个工作区早就挂过组织了，什么都没做。 */
export interface MigratedWorkspace {
  organization: Organization
  workspace: Workspace
  created: boolean
}

/** 组织落在哪：内存档是一个 Map，SQLite 档是一张表。 */
export interface OrgBackend {
  get(id: OrganizationId): Organization | undefined
  put(org: Organization): void
  all(): Organization[]
}

export interface OrganizationsOptions {
  clock: Clock
  backend: OrgBackend
  /** 建组织时的 id 生成（与人 / 工作区同一个序号源，重启后不撞号）。 */
  nextId(prefix: string): string
  hasPerson(id: PersonId): boolean
  getWorkspace(id: WorkspaceId): Workspace | undefined
  putWorkspace(workspace: Workspace): void
  listWorkspaces(): Workspace[]
  /** 该人还在哪些工作区（判"他在这个组织的哪几个品牌里"）。 */
  workspacesOf(person_id: PersonId): Workspace[]
  /** 20 §6 用例 6：离开一个工作区 = 成员收尾 + 他在那里的 token 立刻失效。 */
  leaveWorkspace(workspace_id: WorkspaceId, person_id: PersonId): Promise<unknown>
}

/**
 * 组织面（`LocalIdentityService` 的一半）。两档身份服务把它整个挂上去。
 */
export interface Organizations {
  createOrganization(input: CreateOrganizationInput): Promise<Organization>
  getOrganization(id: OrganizationId): Organization | undefined
  listOrganizations(): Organization[]
  /** 这个人在哪些组织里（按加入先后）。 */
  organizationsOf(person_id: PersonId): Organization[]
  updateOrganization(id: OrganizationId, patch: OrganizationPatch): Promise<Organization>
  addOrganizationMember(input: {
    org_id: OrganizationId
    person_id: PersonId
    role?: OrganizationRole
  }): Promise<OrganizationMember>
  removeOrganizationMember(
    org_id: OrganizationId,
    person_id: PersonId,
  ): Promise<RemovedOrganizationMember>
  /**
   * 这个组织下的品牌工作区。给了 `person_id` 就只回**他有成员资格**的那几个
   * ——顶栏切换器的下拉里不该出现他进不去的品牌（52 O2）。
   */
  brandsOf(org_id: OrganizationId, person_id?: PersonId): Workspace[]
  attachWorkspaceToOrg(input: AttachWorkspaceInput): Promise<Workspace>
  setBrand(workspace_id: WorkspaceId, brand: Brand): Promise<Workspace>
  /**
   * 一次性迁移（52 O1）：没有 `org_id` 的工作区 → 建一个组织（用档案的三字段与 owner）
   * 并把 `brand.name` 回填成工作区名。已经挂过的一个字节不动。
   */
  migrateWorkspace(input: {
    workspace_id: WorkspaceId
    legal_name?: string
    domain?: string
    discoverable?: boolean
  }): Promise<MigratedWorkspace>
}

const activeMembers = (org: Organization): OrganizationMember[] =>
  org.members.filter((m) => m.left_at === undefined)

/** 这个人在这个组织里是什么角色；不在就是 `undefined`（离职的也算不在）。 */
export function organizationRoleOf(
  org: Organization,
  person_id: PersonId,
): OrganizationRole | undefined {
  return activeMembers(org).find((m) => m.person_id === person_id)?.role
}

/** 能不能改这个组织（改档案、邀请人、建品牌）：owner 与 admin 能，member 不能。 */
export function canAdministerOrganization(org: Organization, person_id: PersonId): boolean {
  const role = organizationRoleOf(org, person_id)
  return role === 'owner' || role === 'admin'
}

export function createOrganizations(options: OrganizationsOptions): Organizations {
  const { clock, backend } = options

  const need = (id: OrganizationId): Organization => {
    const org = backend.get(id)
    if (org === undefined) throw new ApiError('not_found', `组织不存在：${id}`)
    return org
  }

  const needWorkspace = (id: WorkspaceId): Workspace => {
    const ws = options.getWorkspace(id)
    if (ws === undefined) throw new ApiError('not_found', `工作区不存在：${id}`)
    return ws
  }

  return {
    async createOrganization(input): Promise<Organization> {
      const legal_name = input.legal_name.trim()
      if (legal_name === '') throw new ApiError('invalid_input', '公司全称不能为空')
      if (!options.hasPerson(input.owner_id))
        throw new ApiError('not_found', `owner 不存在：${input.owner_id}`)
      const id = input.id ?? options.nextId('org')
      if (backend.get(id) !== undefined) throw new ApiError('conflict', `组织已存在：${id}`)
      const domain = input.domain?.trim()
      const org: Organization = {
        id,
        legal_name,
        ...(domain === undefined || domain === '' ? {} : { domain }),
        // 46 §1 表：不给按 true——"让同事找到我"默认开着
        discoverable: input.discoverable ?? true,
        owner_id: input.owner_id,
        members: [{ person_id: input.owner_id, role: 'owner', joined_at: clock.now() }],
        ...(input.cloud_org_id === undefined ? {} : { cloud_org_id: input.cloud_org_id }),
        created_at: clock.now(),
      }
      backend.put(org)
      return org
    },

    getOrganization(id): Organization | undefined {
      return backend.get(id)
    },

    listOrganizations(): Organization[] {
      return backend.all()
    },

    organizationsOf(person_id): Organization[] {
      return backend.all().filter((o) => organizationRoleOf(o, person_id) !== undefined)
    },

    async updateOrganization(id, patch): Promise<Organization> {
      const org = need(id)
      const legal_name = patch.legal_name?.trim()
      if (legal_name !== undefined && legal_name === '')
        throw new ApiError('invalid_input', '公司全称不能为空')
      const domain = patch.domain?.trim()
      const next: Organization = {
        ...org,
        ...(legal_name === undefined ? {} : { legal_name }),
        ...(domain === undefined || domain === '' ? {} : { domain }),
        ...(patch.discoverable === undefined ? {} : { discoverable: patch.discoverable }),
        ...(patch.cloud_org_id === undefined ? {} : { cloud_org_id: patch.cloud_org_id }),
      }
      // 空串 = 把域名清掉（界面上把那一格删干净就是这个意思）；`undefined` = 不动它
      if (domain === '') delete next.domain
      backend.put(next)
      return next
    },

    async addOrganizationMember({ org_id, person_id, role }): Promise<OrganizationMember> {
      const org = need(org_id)
      if (!options.hasPerson(person_id)) throw new ApiError('not_found', `人不存在：${person_id}`)
      const existing = activeMembers(org).find((m) => m.person_id === person_id)
      if (existing !== undefined) return existing
      const member: OrganizationMember = {
        person_id,
        role: role ?? 'member',
        joined_at: clock.now(),
      }
      backend.put({ ...org, members: [...org.members, member] })
      return member
    },

    async removeOrganizationMember(org_id, person_id): Promise<RemovedOrganizationMember> {
      const org = need(org_id)
      if (org.owner_id === person_id)
        throw new ApiError('invalid_input', '组织所有者不能从组织里移除；先把所有权转给别人')
      const at = clock.now()
      const organization: Organization = {
        ...org,
        members: org.members.map((m) =>
          m.person_id === person_id && m.left_at === undefined ? { ...m, left_at: at } : m,
        ),
      }
      backend.put(organization)
      // 40 E2「按组织一次撤全部品牌」：他在这个组织每一个品牌里的成员关系一起收，
      // token 跟着失效。分配的撤销在 roles 侧，照这张单子走。
      const brands = options
        .listWorkspaces()
        .filter((w) => w.org_id === org_id)
        .map((w) => w.id)
      const left: WorkspaceId[] = []
      for (const ws of brands) {
        const removed = await options.leaveWorkspace(ws, person_id)
        if (removed !== undefined) left.push(ws)
      }
      return { organization, brands: left }
    },

    brandsOf(org_id, person_id): Workspace[] {
      const all = options.listWorkspaces().filter((w) => w.org_id === org_id)
      if (person_id === undefined) return all
      const mine = new Set(options.workspacesOf(person_id).map((w) => w.id))
      return all.filter((w) => mine.has(w.id))
    },

    async attachWorkspaceToOrg({ workspace_id, org_id, brand_name }): Promise<Workspace> {
      const workspace = needWorkspace(workspace_id)
      need(org_id)
      if (workspace.org_id !== undefined && workspace.org_id !== org_id)
        throw new ApiError('conflict', `这个品牌已经挂在另一个组织下：${workspace.org_id}`)
      const name = brand_name?.trim()
      const next: Workspace = {
        ...workspace,
        org_id,
        brand: {
          ...workspace.brand,
          name: name === undefined || name === '' ? brandNameOf(workspace) : name,
        },
      }
      options.putWorkspace(next)
      return next
    },

    async setBrand(workspace_id, brand): Promise<Workspace> {
      const workspace = needWorkspace(workspace_id)
      const name = brand.name.trim()
      if (name === '') throw new ApiError('invalid_input', '品牌名不能为空')
      const next: Workspace = {
        ...workspace,
        brand: { name, ...(brand.logo === undefined ? {} : { logo: brand.logo }) },
      }
      options.putWorkspace(next)
      return next
    },

    async migrateWorkspace({
      workspace_id,
      legal_name,
      domain,
      discoverable,
    }): Promise<MigratedWorkspace> {
      const workspace = needWorkspace(workspace_id)
      const existing = workspace.org_id === undefined ? undefined : backend.get(workspace.org_id)
      if (existing !== undefined) return { organization: existing, workspace, created: false }
      const org = await this.createOrganization({
        // 没设过公司档案的（还没走向导）先用工作区名占位——它只是个名字，
        // 用户在设置页一改就真了；空着反而会让"公司"这一层看起来坏掉
        legal_name:
          legal_name?.trim() === undefined || legal_name.trim() === ''
            ? workspace.name
            : legal_name.trim(),
        ...(domain === undefined ? {} : { domain }),
        ...(discoverable === undefined ? {} : { discoverable }),
        owner_id: workspace.owner_id,
      })
      const attached = await this.attachWorkspaceToOrg({ workspace_id, org_id: org.id })
      return { organization: org, workspace: attached, created: true }
    },
  }
}
