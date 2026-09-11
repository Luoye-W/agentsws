/**
 * 职责 / 分配 / 策略层的运行时门面。
 * 05 §3 额度解析顺序、05 §4 单 Assignment 的 EffectiveConfig、31 §3.1 完整元组判定都从这里出。
 */
import type {
  Assignment,
  AssignmentId,
  Clock,
  DataDomain,
  Mandate,
  ObjectOrigin,
  Operation,
  PersonId,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
  RiskClass,
  RoleId,
  WorkspaceId,
  WorkspacePolicy,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import {
  recordDecision as recordDecisionPure,
  suggestPromotion as suggestPromotionPure,
} from './automation.js'
import {
  type AssignmentFilter,
  createMemoryBackend,
  createSqliteBackend,
  type StoreBackend,
} from './backend.js'
import { effectiveConfig as effectiveConfigPure, riskClassOf } from './effective.js'
import { assertTighterOverrides } from './overrides.js'
import { compilePolicies as compilePoliciesPure, createPolicyEngine } from './policy.js'
import { applyPosition as applyPositionPure, buildAssignment } from './position.js'
import {
  dedupeRanges,
  expandRanges,
  PRODUCT_LINE_PARENT_KINDS,
  type RangeTarget,
  rangeKey,
  type TargetInRangeResult,
  targetInRange as targetInRangePure,
} from './ranges.js'
import {
  type AccessRequest,
  type DecisionOutcome,
  type EffectiveConfig,
  type PolicyRow,
  type Position,
  type PromotionSuggestion,
  type RoleDefinitionFull,
  RoleError,
} from './types.js'

export interface RoleStoreOptions {
  clock: Clock
  /** 给了就落 SQLite（同步 API）；不给就纯内存。 */
  dbPath?: string
  /** 预注册的职责定义。 */
  roles?: RoleDefinitionFull[]
  /** 自定义 Assignment id 生成；默认是 (人 × 职责 × 工作区 × 时间 × 序号) 的哈希，无随机源。 */
  newId?: (seed: string) => string
  /**
   * 现在接上了哪些连接器（按职责模板里的 `connectors[].kind`：email / shopify / ga4 …）。
   * `effectiveConfig` 没显式传 `connected` 时用它——服务进程把真实连接表挂在这里，
   * 岗位的 `ready` / `missing_connectors` 才不会在连上之后还说"缺"。
   */
  connected?: () => Iterable<string>
  /**
   * 44 G5：范围组（品牌）的成员变了、挂了它的岗位范围跟着变时喊一声。
   *
   * 这个包不认事件日志也不认审批总线（它只管制度），所以"记一条
   * `assignment.range_expanded` + 给 owner 发一张 L3 卡"由调用方接在这里。
   * 回调里抛异常不会让这次改组失败——留痕失败是日志的问题，不是制度的问题。
   */
  onRangeExpanded?: (e: RangeExpanded) => void
}

/** 44 G5 的一次自动扩范围（品牌加了店 / 减了店，挂它的岗位跟着变）。 */
export interface RangeExpanded {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  /** 是哪个范围组变了。 */
  range_group: string
  range_group_name: string
  /** 这条分配新多出来的范围。 */
  added: RangeRef[]
  /** 这条分配少掉的范围。 */
  removed: RangeRef[]
  /** 变完之后的全部范围。 */
  ranges: RangeRef[]
}

export interface CreateAssignmentInput {
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  ranges?: RangeRef[]
  /** 44 G1：挂的范围组（品牌）。存进 `Assignment.ranges` 的是**展开后**的成员。 */
  range_groups?: string[]
  granted_by: PersonId
  mandate_overrides?: Record<string, Partial<Mandate>>
  /** 显式指定授予的职责版本；默认取当前已加载的版本。 */
  role_version?: string
}

/** 改一条已有分配：换范围、收紧额度。人与职责不给改——换职责就是另一条分配。 */
export interface UpdateAssignmentInput {
  /** 显式挂的范围（不含范围组展开出来的那些；给了就整份替换）。 */
  ranges?: RangeRef[]
  /** 44 G1：挂的范围组（给了就整份替换；摘掉的组，它贡献的成员一并撤走）。 */
  range_groups?: string[]
  /** 05 §0 不变量 2：只能更紧；想放宽直接 `invalid_input`，不静默丢掉。 */
  mandate_overrides?: Record<string, Partial<Mandate>>
}

/** 44 G1 范围组（品牌）的增删改。 */
export interface RangeGroupApi {
  create(input: {
    workspace_id: WorkspaceId
    name: string
    members?: RangeRef[]
    /** 想自己指定 id 就给（迁移 / 场景用）；不给按名字哈希。 */
    id?: string
    /** 45 H2：谁、从哪个工作区带进来的。 */
    origin?: ObjectOrigin
    /** 45 H3：建出来就是别名（Join 落地时个人那份走这条）。 */
    superseded_by?: string
  }): RangeGroup
  /**
   * 改名字 / 改成员。改成员会重算所有挂了这个组的岗位范围（44 G5）。
   *
   * 45 H3：**已经被取代的那份不给改**（`conflict`）——它是别名，改的是公司那条。
   */
  update(
    id: string,
    input: { name?: string; members?: RangeRef[]; origin?: ObjectOrigin },
  ): RangeGroup
  /**
   * 45 H3：把这一份标成"被公司那条取代"（`by` 给 `undefined` = 退出公司，别名断开）。
   *
   * 与 `update` 分开是因为它**绕过只读**：别名本身的建立与解除不是"改内容"。
   */
  supersede(id: string, by: string | undefined): RangeGroup
  /**
   * 45 H3 别名解析：顺着 `superseded_by` 走到真源那一条（没有别名就是它自己）。
   * 链上有环或断链时回走得到的最后一条，不抛——读路径不该因为一个坏引用打不开。
   */
  resolve(id: string): RangeGroup | undefined
  /** 还有岗位挂着就不给删（`conflict`）。 */
  delete(id: string): void
  get(id: string): RangeGroup | undefined
  list(workspace_id?: WorkspaceId): RangeGroup[]
  /** 哪些分配挂了这个组。 */
  assignments(id: string): Assignment[]
}

/** 44 G2 产品线的增删改。 */
export interface ProductLineApi {
  create(input: {
    workspace_id: WorkspaceId
    name: string
    parent: RangeRef
    rule: ProductLineRule
    id?: string
    /** 45 H2：谁、从哪个工作区带进来的。 */
    origin?: ObjectOrigin
    /** 45 H3：建出来就是别名。 */
    superseded_by?: string
  }): ProductLine
  /** 45 H3：已经被取代的那份不给改（`conflict`）。 */
  update(
    id: string,
    input: { name?: string; parent?: RangeRef; rule?: ProductLineRule; origin?: ObjectOrigin },
  ): ProductLine
  /** 45 H3：标成被取代 / 解除别名。 */
  supersede(id: string, by: string | undefined): ProductLine
  /** 45 H3 别名解析。 */
  resolve(id: string): ProductLine | undefined
  /** 还有岗位挂着就不给删（`conflict`）。 */
  delete(id: string): void
  get(id: string): ProductLine | undefined
  list(workspace_id?: WorkspaceId): ProductLine[]
  /** 哪些分配挂了这条产品线。 */
  assignments(id: string): Assignment[]
}

export interface RevokeInput {
  /** 接手人（05 §3）；没有接手人时按 Role.handover.fallback 兜底，由调用方落地。 */
  handover_to?: PersonId
}

export interface RoleRegistry {
  register(role: RoleDefinitionFull): void
  get(id: RoleId): RoleDefinitionFull | undefined
  require(id: RoleId): RoleDefinitionFull
  list(): RoleDefinitionFull[]
}

export interface AssignmentApi {
  create(input: CreateAssignmentInput): Assignment
  applyPosition(
    position: Position,
    person: PersonId,
    workspace: WorkspaceId,
    ranges: RangeRef[],
    options: { granted_by: PersonId; include?: RoleId[] },
  ): Assignment[]
  get(id: AssignmentId): Assignment | undefined
  require(id: AssignmentId): Assignment
  /** 改范围 / 收紧额度；已撤销的不给改。 */
  update(id: AssignmentId, input: UpdateAssignmentInput): Assignment
  revoke(id: AssignmentId, input?: RevokeInput): Assignment
  listByPerson(person: PersonId, filter?: Omit<AssignmentFilter, 'person_id'>): Assignment[]
  listByRole(role: RoleId, filter?: Omit<AssignmentFilter, 'role_id'>): Assignment[]
  /** 44：整个工作区活着的分配（算范围下推 / 品牌影响面时用）。 */
  listByWorkspace(
    workspace: WorkspaceId,
    filter?: Omit<AssignmentFilter, 'workspace_id'>,
  ): Assignment[]
}

export interface PolicyApi {
  set(policy: WorkspacePolicy): void
  get(workspaceId: WorkspaceId): WorkspacePolicy | undefined
}

export interface RoleStore {
  roles: RoleRegistry
  assignments: AssignmentApi
  policies: PolicyApi
  /** 44 G1 品牌 = 范围组。 */
  rangeGroups: RangeGroupApi
  /** 44 G2 产品线。 */
  productLines: ProductLineApi
  /** 05 §4：单个 Assignment 的有效配置，不并集。 */
  effectiveConfig(id: AssignmentId, options?: { connected?: Iterable<string> }): EffectiveConfig
  compilePolicies(id: AssignmentId): PolicyRow[]
  can(id: AssignmentId, domain: DataDomain, op: Operation, request: AccessRequest): boolean
  /**
   * 44 G2 写动作那一半：改价 / 改 Listing / 补货计划的目标商品在不在这个岗位的范围里。
   * guardrail 的 `target_in_range` 前置检查调的就是它。
   */
  targetInRange(id: AssignmentId, target: RangeTarget): TargetInRangeResult
  recordDecision(id: AssignmentId, actionId: string, outcome: DecisionOutcome): Assignment
  suggestPromotion(
    id: AssignmentId,
    actionId: string,
    riskClass?: RiskClass,
  ): PromotionSuggestion | null
  close(): void
}

export function createRoleStore(options: RoleStoreOptions): RoleStore {
  const backend: StoreBackend = options.dbPath
    ? createSqliteBackend(options.dbPath)
    : createMemoryBackend()
  const engine = createPolicyEngine()
  const roleMap = new Map<RoleId, RoleDefinitionFull>()
  for (const role of options.roles ?? []) roleMap.set(role.id, role)

  const defaultNewId = (seed: string) => `asg_${sha256(seed).slice(0, 24)}`
  const mintId = options.newId ?? defaultNewId

  const roles: RoleRegistry = {
    register(role) {
      roleMap.set(role.id, role)
    },
    get(id) {
      return roleMap.get(id)
    },
    require(id) {
      const role = roleMap.get(id)
      if (!role) throw new RoleError('not_found', `role definition ${id} is not loaded`)
      return role
    },
    list() {
      return [...roleMap.values()]
    },
  }

  const roleFor = (assignment: Assignment): RoleDefinitionFull => roles.require(assignment.role_id)

  const syncPolicies = (assignment: Assignment) => {
    const rows = compilePoliciesPure(assignment, roleFor(assignment))
    if (rows.length === 0) engine.remove(assignment.id)
    else engine.set(assignment.id, rows)
  }

  const factory = {
    clock: options.clock,
    newId: (
      init: { person_id: string; workspace_id: string; role: RoleDefinitionFull },
      at: string,
    ) => {
      let seq = backend.countAssignments()
      for (;;) {
        const id = mintId(
          canonicalJson({
            person: init.person_id,
            workspace: init.workspace_id,
            role: init.role.id,
            at,
            seq,
          }),
        )
        if (!backend.getAssignment(id)) return id
        seq += 1
      }
    },
  }

  const hydrated = new Set<AssignmentId>()
  const persist = (assignment: Assignment): Assignment => {
    backend.putAssignment(assignment)
    syncPolicies(assignment)
    hydrated.add(assignment.id)
    return assignment
  }

  // ── 44 范围组与产品线 ─────────────────────────────────────────────────

  /** 组 / 线的 id：没给就按 (工作区 × 名字) 哈希，无随机源（与 Assignment 同规矩）。 */
  const mintDocId = (prefix: string, workspace: string, name: string): string =>
    `${prefix}_${sha256(canonicalJson({ workspace, name })).slice(0, 20)}`

  /**
   * 45 H3 别名解析发生在**展开**这一侧：挂着的那条被并进公司之后，展开出来的是
   * 公司那份的成员。于是"他的岗位范围自动指到公司那份"这件事，就算落地那一步
   * 漏改了分配上的组 id（老数据、并发），下一次重新展开也仍然是对的。
   *
   * 注意 `effectiveConfig` 读的是**存下来的那份已展开范围**（44 G1 就是这么设计的：
   * 判权限那一刻不再查品牌表），所以别名要真的生效，还得有一次重新展开——
   * Join 落地那一步的 `assignments.update` 就是那一次。
   */
  const groupsOf = (ids: readonly string[] | undefined): RangeGroup[] => {
    const out: RangeGroup[] = []
    for (const id of ids ?? []) {
      const found = resolveChain(id, (x) => backend.getRangeGroup(x))
      if (found !== undefined) out.push(found)
    }
    return out
  }

  /** 展开：显式范围 ∪ 各组成员（44 G1/G3 取并集）。 */
  const expand = (explicit: readonly RangeRef[], groupIds: readonly string[] | undefined) =>
    expandRanges(explicit, groupsOf(groupIds))

  const requireGroups = (workspace: WorkspaceId, ids: readonly string[]): RangeGroup[] => {
    const out: RangeGroup[] = []
    for (const id of ids) {
      const found = backend.getRangeGroup(id)
      if (found === undefined) throw new RoleError('not_found', `没有这个品牌（范围组）：${id}`)
      if (found.workspace_id !== workspace)
        throw new RoleError('invalid_input', `范围组 ${id} 不属于工作区 ${workspace}`)
      out.push(found)
    }
    return out
  }

  /** 分配挂的范围里引用到的产品线必须存在（写路径上拦；读路径上宽容）。 */
  const requireLines = (workspace: WorkspaceId, ranges: readonly RangeRef[]): void => {
    for (const r of ranges) {
      if (r.kind !== 'product_line') continue
      const line = backend.getProductLine(r.id)
      if (line === undefined) throw new RoleError('not_found', `没有这条产品线：${r.id}`)
      if (line.workspace_id !== workspace)
        throw new RoleError('invalid_input', `产品线 ${r.id} 不属于工作区 ${workspace}`)
    }
  }

  /**
   * 45 H3 别名解析：顺着 `superseded_by` 一路走到真源。
   *
   * 走不动了（断链）或者绕回来了（环）就停在**当前这一条**——读路径上一个坏引用
   * 不该让整个岗位打不开；上限也保住了"改坏一条数据把进程转死"这条。
   */
  function resolveChain<T extends { id: string; superseded_by?: string }>(
    id: string,
    get: (id: string) => T | undefined,
  ): T | undefined {
    const seen = new Set<string>()
    let current = get(id)
    while (current !== undefined && current.superseded_by !== undefined) {
      if (seen.has(current.id)) return current
      seen.add(current.id)
      const next = get(current.superseded_by)
      if (next === undefined) return current
      current = next
    }
    return current
  }

  const attachedTo = (predicate: (a: Assignment) => boolean): Assignment[] =>
    backend.listAssignments({}).filter(predicate)

  const notifyExpanded = (e: RangeExpanded): void => {
    try {
      options.onRangeExpanded?.(e)
    } catch {
      // 留痕失败不该把已经改好的制度回滚——那是日志的问题，不是制度的问题
    }
  }

  /**
   * 44 G5：组成员变了 → 重算所有挂了它的岗位的 `ranges`，逐条喊一声。
   *
   * 算法是"减掉走了的、加上来的"：分配上没有"显式范围"这个字段（契约里 `ranges`
   * 就是展开后的那一份），所以拿旧成员当减数。**代价**：某条显式范围恰好与被移走的
   * 组成员同名同种时会被一起减掉——真要两种来源分开记账得再加一个契约字段，v1 不加。
   */
  const recomputeForGroup = (group: RangeGroup, previous: readonly RangeRef[]): void => {
    const nextKeys = new Set(group.members.map(rangeKey))
    const goneKeys = new Set(previous.map(rangeKey).filter((k) => !nextKeys.has(k)))
    for (const assignment of attachedTo(
      (a) => a.revoked_at === undefined && (a.range_groups ?? []).includes(group.id),
    )) {
      const kept = assignment.ranges.filter((r) => !goneKeys.has(rangeKey(r)))
      const next = expand(kept, assignment.range_groups)
      const beforeKeys = new Set(assignment.ranges.map(rangeKey))
      const afterKeys = new Set(next.map(rangeKey))
      const added = next.filter((r) => !beforeKeys.has(rangeKey(r)))
      const removed = assignment.ranges.filter((r) => !afterKeys.has(rangeKey(r)))
      if (added.length === 0 && removed.length === 0) continue
      persist({ ...assignment, ranges: next })
      notifyExpanded({
        assignment_id: assignment.id,
        person_id: assignment.person_id,
        workspace_id: assignment.workspace_id,
        role_id: assignment.role_id,
        range_group: group.id,
        range_group_name: group.name,
        added,
        removed,
        ranges: next,
      })
    }
  }

  const rangeGroups: RangeGroupApi = {
    create(input) {
      const id = input.id ?? mintDocId('rg', input.workspace_id, input.name)
      if (backend.getRangeGroup(id) !== undefined)
        throw new RoleError('conflict', `品牌（范围组）${id} 已经有了`)
      const name = input.name.trim()
      if (name === '') throw new RoleError('invalid_input', '品牌要有名字')
      const at = options.clock.now()
      const group: RangeGroup = {
        id,
        workspace_id: input.workspace_id,
        name,
        members: dedupeRanges(input.members ?? []),
        created_at: at,
        updated_at: at,
        ...(input.origin === undefined ? {} : { origin: { ...input.origin } }),
        ...(input.superseded_by === undefined ? {} : { superseded_by: input.superseded_by }),
      }
      backend.putRangeGroup(group)
      return group
    },
    update(id, input) {
      const found = backend.getRangeGroup(id)
      if (found === undefined) throw new RoleError('not_found', `没有这个品牌（范围组）：${id}`)
      // 45 H3：别名是只读的——改的是公司那条，不是这一份
      if (found.superseded_by !== undefined)
        throw new RoleError(
          'conflict',
          `「${found.name}」已经并进公司那份了，这里只能看。要改去公司那条上提一张「提议修改」。`,
        )
      const name = input.name?.trim()
      if (name !== undefined && name === '') throw new RoleError('invalid_input', '品牌要有名字')
      const next: RangeGroup = {
        ...found,
        ...(name === undefined ? {} : { name }),
        ...(input.members === undefined ? {} : { members: dedupeRanges(input.members) }),
        ...(input.origin === undefined ? {} : { origin: { ...input.origin } }),
        updated_at: options.clock.now(),
      }
      backend.putRangeGroup(next)
      if (input.members !== undefined) recomputeForGroup(next, found.members)
      return next
    },
    supersede(id, by) {
      const found = backend.getRangeGroup(id)
      if (found === undefined) throw new RoleError('not_found', `没有这个品牌（范围组）：${id}`)
      if (by === id) throw new RoleError('invalid_input', '一条东西不能取代它自己')
      const { superseded_by: _dropped, ...rest } = found
      const next: RangeGroup = {
        ...rest,
        ...(by === undefined ? {} : { superseded_by: by }),
        updated_at: options.clock.now(),
      }
      backend.putRangeGroup(next)
      return next
    },
    resolve(id) {
      return resolveChain(id, (x) => backend.getRangeGroup(x))
    },
    delete(id) {
      const found = backend.getRangeGroup(id)
      if (found === undefined) throw new RoleError('not_found', `没有这个品牌（范围组）：${id}`)
      const holders = rangeGroups.assignments(id)
      if (holders.length > 0)
        throw new RoleError(
          'conflict',
          `还有 ${holders.length} 个岗位挂着「${found.name}」。先把它们改挂别的范围再删。`,
        )
      backend.deleteRangeGroup(id)
    },
    get: (id) => backend.getRangeGroup(id),
    list: (workspace_id) => backend.listRangeGroups(workspace_id),
    assignments: (id) =>
      attachedTo((a) => a.revoked_at === undefined && (a.range_groups ?? []).includes(id)),
  }

  const productLines: ProductLineApi = {
    create(input) {
      const id = input.id ?? mintDocId('pl', input.workspace_id, input.name)
      if (backend.getProductLine(id) !== undefined)
        throw new RoleError('conflict', `产品线 ${id} 已经有了`)
      const name = input.name.trim()
      if (name === '') throw new RoleError('invalid_input', '产品线要有名字')
      if (!PRODUCT_LINE_PARENT_KINDS.includes(input.parent.kind))
        throw new RoleError(
          'invalid_input',
          `产品线只能切在店铺 / 平台账号 / 市场里面，给的是 ${input.parent.kind}`,
        )
      const at = options.clock.now()
      const line: ProductLine = {
        id,
        workspace_id: input.workspace_id,
        name,
        parent: { ...input.parent },
        rule: structuredClone(input.rule),
        created_at: at,
        updated_at: at,
        ...(input.origin === undefined ? {} : { origin: { ...input.origin } }),
        ...(input.superseded_by === undefined ? {} : { superseded_by: input.superseded_by }),
      }
      backend.putProductLine(line)
      return line
    },
    update(id, input) {
      const found = backend.getProductLine(id)
      if (found === undefined) throw new RoleError('not_found', `没有这条产品线：${id}`)
      // 45 H3：别名只读
      if (found.superseded_by !== undefined)
        throw new RoleError(
          'conflict',
          `「${found.name}」已经并进公司那份了，这里只能看。要改去公司那条上提一张「提议修改」。`,
        )
      if (input.parent !== undefined && !PRODUCT_LINE_PARENT_KINDS.includes(input.parent.kind))
        throw new RoleError(
          'invalid_input',
          `产品线只能切在店铺 / 平台账号 / 市场里面，给的是 ${input.parent.kind}`,
        )
      const name = input.name?.trim()
      if (name !== undefined && name === '') throw new RoleError('invalid_input', '产品线要有名字')
      const next: ProductLine = {
        ...found,
        ...(name === undefined ? {} : { name }),
        ...(input.parent === undefined ? {} : { parent: { ...input.parent } }),
        ...(input.rule === undefined ? {} : { rule: structuredClone(input.rule) }),
        ...(input.origin === undefined ? {} : { origin: { ...input.origin } }),
        updated_at: options.clock.now(),
      }
      backend.putProductLine(next)
      return next
    },
    supersede(id, by) {
      const found = backend.getProductLine(id)
      if (found === undefined) throw new RoleError('not_found', `没有这条产品线：${id}`)
      if (by === id) throw new RoleError('invalid_input', '一条东西不能取代它自己')
      const { superseded_by: _dropped, ...rest } = found
      const next: ProductLine = {
        ...rest,
        ...(by === undefined ? {} : { superseded_by: by }),
        updated_at: options.clock.now(),
      }
      backend.putProductLine(next)
      return next
    },
    resolve(id) {
      return resolveChain(id, (x) => backend.getProductLine(x))
    },
    delete(id) {
      const found = backend.getProductLine(id)
      if (found === undefined) throw new RoleError('not_found', `没有这条产品线：${id}`)
      const holders = productLines.assignments(id)
      if (holders.length > 0)
        throw new RoleError(
          'conflict',
          `还有 ${holders.length} 个岗位挂着「${found.name}」。先把它们改挂别的范围再删。`,
        )
      backend.deleteProductLine(id)
    },
    get: (id) => backend.getProductLine(id),
    list: (workspace_id) => backend.listProductLines(workspace_id),
    assignments: (id) =>
      attachedTo(
        (a) =>
          a.revoked_at === undefined &&
          a.ranges.some((r) => r.kind === 'product_line' && r.id === id),
      ),
  }

  const assignments: AssignmentApi = {
    create(input) {
      const role = roles.require(input.role_id)
      if (input.role_version !== undefined && input.role_version !== role.version)
        throw new RoleError(
          'conflict',
          `role ${role.id} is loaded at ${role.version}, cannot grant ${input.role_version}`,
        )
      const groupIds = input.range_groups ?? []
      requireGroups(input.workspace_id, groupIds)
      requireLines(input.workspace_id, input.ranges ?? [])
      // 44 G1：存的是**展开后**的范围，另记从哪几个品牌来的
      const built = buildAssignment(
        {
          person_id: input.person_id,
          workspace_id: input.workspace_id,
          role,
          ranges: expand(input.ranges ?? [], groupIds),
          granted_by: input.granted_by,
          ...(input.mandate_overrides ? { mandate_overrides: input.mandate_overrides } : {}),
        },
        factory,
      )
      return persist(groupIds.length === 0 ? built : { ...built, range_groups: [...groupIds] })
    },
    applyPosition(position, person, workspace, ranges, opts) {
      const created = applyPositionPure(position, person, workspace, ranges, {
        ...factory,
        granted_by: opts.granted_by,
        roles: (id) => roleMap.get(id),
        ...(opts.include ? { include: opts.include } : {}),
      })
      for (const assignment of created) persist(assignment)
      return created
    },
    get(id) {
      return backend.getAssignment(id)
    },
    require(id) {
      const found = backend.getAssignment(id)
      if (!found) throw new RoleError('not_found', `assignment ${id} not found`)
      return found
    },
    update(id, input) {
      const found = assignments.require(id)
      if (found.revoked_at)
        throw new RoleError('conflict', `分配 ${id} 已在 ${found.revoked_at} 撤销，不能再改`)
      const role = roleFor(found)
      const overrides = input.mandate_overrides
      if (overrides !== undefined)
        assertTighterOverrides(role, backend.getPolicy(found.workspace_id), overrides)
      const prevGroups = found.range_groups ?? []
      const nextGroups = input.range_groups ?? prevGroups
      if (input.range_groups !== undefined) requireGroups(found.workspace_id, nextGroups)
      if (input.ranges !== undefined) requireLines(found.workspace_id, input.ranges)
      // 摘掉的品牌，它贡献的成员一并撤走；没给 ranges 时在现有（已展开）那份上减
      const droppedKeys = new Set(
        groupsOf(prevGroups.filter((g) => !nextGroups.includes(g))).flatMap((g) =>
          g.members.map(rangeKey),
        ),
      )
      const base = (input.ranges ?? found.ranges).filter((r) => !droppedKeys.has(rangeKey(r)))
      const rangesChanged = input.ranges !== undefined || input.range_groups !== undefined
      const next: Assignment = {
        ...found,
        ...(rangesChanged ? { ranges: expand(base, nextGroups) } : {}),
        ...(overrides === undefined ? {} : { mandate_overrides: overrides }),
      }
      // 摘光了品牌就把这个键去掉（契约上它是可选的，不是"空数组"）
      if (nextGroups.length === 0) delete next.range_groups
      else next.range_groups = [...nextGroups]
      return persist(next)
    },
    revoke(id, input) {
      const found = assignments.require(id)
      if (found.revoked_at)
        throw new RoleError(
          'conflict',
          `assignment ${id} is already revoked at ${found.revoked_at}`,
        )
      const revoked: Assignment = {
        ...found,
        revoked_at: options.clock.now(),
        ...(input?.handover_to ? { handover_to: input.handover_to } : {}),
      }
      backend.putAssignment(revoked)
      engine.remove(id)
      hydrated.delete(id)
      return revoked
    },
    listByPerson(person, filter) {
      return backend.listAssignments({ ...filter, person_id: person })
    },
    listByRole(role, filter) {
      return backend.listAssignments({ ...filter, role_id: role })
    },
    listByWorkspace(workspace, filter) {
      return backend.listAssignments({ ...filter, workspace_id: workspace })
    },
  }

  const policies: PolicyApi = {
    set(policy) {
      backend.putPolicy(policy)
    },
    get(workspaceId) {
      return backend.getPolicy(workspaceId)
    },
  }

  return {
    roles,
    assignments,
    policies,
    rangeGroups,
    productLines,
    effectiveConfig(id, opts) {
      const assignment = assignments.require(id)
      const role = roleFor(assignment)
      return effectiveConfigPure({
        assignment,
        role,
        policy: backend.getPolicy(assignment.workspace_id),
        ...((opts?.connected ?? options.connected?.()) === undefined
          ? {}
          : { connected: opts?.connected ?? options.connected?.() ?? [] }),
      })
    },
    compilePolicies(id) {
      const assignment = assignments.require(id)
      return compilePoliciesPure(assignment, roleFor(assignment))
    },
    can(id, domain, op, request) {
      const assignment = backend.getAssignment(id)
      if (!assignment || assignment.revoked_at) return false
      // 31 §3.1：空范围的 Assignment 不得用 assigned 范围查询。
      if (request.range === 'assigned' && assignment.ranges.length === 0) return false
      // 已有库（SQLite）在进程重启后按需把策略行灌进 enforcer。
      if (!hydrated.has(id)) {
        syncPolicies(assignment)
        hydrated.add(id)
      }
      return engine.can(id, domain, op, request)
    },
    targetInRange(id, target) {
      const assignment = backend.getAssignment(id)
      if (assignment === undefined || assignment.revoked_at)
        return {
          ok: false,
          code: 'unassigned_range',
          reason: '这个岗位已经撤销了，动不了店铺里的东西',
        }
      return targetInRangePure({
        ranges: assignment.ranges,
        target,
        // 45 H3：挂着的产品线被并进公司之后，判的是公司那份的判据
        productLine: (lineId) => resolveChain(lineId, (x) => backend.getProductLine(x)),
      })
    },
    recordDecision(id, actionId, outcome) {
      const assignment = assignments.require(id)
      const role = roleFor(assignment)
      if (!role.actions.some((a) => a.id === actionId))
        throw new RoleError('not_found', `role ${role.id} has no action ${actionId}`)
      const updated = recordDecisionPure(assignment, actionId, outcome, options.clock)
      backend.putAssignment(updated)
      return updated
    },
    suggestPromotion(id, actionId, riskClass) {
      const assignment = assignments.require(id)
      const role = roleFor(assignment)
      const action = role.actions.find((a) => a.id === actionId)
      const risk = riskClass ?? (action ? riskClassOf(action) : 'high')
      return suggestPromotionPure(assignment, role, actionId, risk)
    },
    close() {
      backend.close()
    },
  }
}
