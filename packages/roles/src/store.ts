/**
 * 职责 / 分配 / 策略层的运行时门面。
 * 05 §3 额度解析顺序、05 §4 单 Assignment 的 EffectiveConfig、31 §3.1 完整元组判定都从这里出。
 */
import type {
  Assignment,
  AssignmentId,
  Clock,
  DataDomain,
  Level,
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
import { ROLE_ID_ALIASES, ROLE_ID_SPLITS, resolveRoleId } from './load.js'
import {
  autoUpgradable,
  heirsOf,
  isStaleMajor,
  majorOf,
  majorUpgradePath,
  ROLE_MAJOR_UPGRADES,
  type RoleMajorUpgrade,
  type RoleUpgradeNeeded,
} from './major-upgrades.js'
import { assertTighterOverrides } from './overrides.js'
import { compilePolicies as compilePoliciesPure, createPolicyEngine } from './policy.js'
import {
  applyPosition as applyPositionPure,
  buildAssignment,
  initialAutomationState,
} from './position.js'
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
   * WP66（52 O1）：**按品牌**问"现在接上了哪些连接器"。
   *
   * 一个服务进程装多套品牌模块之后，连接表不再是一台机器一份——岗位的
   * `ready` / `missing_connectors` 必须按这条分配所属的品牌算，否则品牌 B 的
   * 客服岗位会因为品牌 A 连了邮箱而显示"已就绪"。
   *
   * 给了它就优先用它（`connected` 留着，单品牌装配与测试一个字不用改）。
   */
  connectedOf?: (workspace_id: WorkspaceId) => Iterable<string>
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
    /** 45 H4：谁建的（查重命中时界面上说"去问他"）。 */
    created_by?: PersonId
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
    /** 45 H4：谁建的。 */
    created_by?: PersonId
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

/**
 * WP295（docs/95 §5：AI 对外发东西，默认要你确认）：退役的出厂默认等级。
 *
 * 红人五条渠道职责的「发开发信」以前初始 L2——开发信又判成低风险，于是真红人的首封
 * 一张卡都不出、直接自动发出去，与岗位定位「每一封开发信必须出卡」相反。现在初始 L1；
 * 还停在出厂 L2 的老分配启动时迁成 L1。只可加行。
 */
export const RETIRED_AUTOMATION_DEFAULTS: readonly {
  /** 职责 id 前缀（`kol.` = 红人五条渠道）。 */
  role_prefix: string
  action_id: string
  /** 旧的出厂默认值；只迁还停在它上面的。 */
  was: Level
  /** 记进 `last_change.reason` 的那个词。 */
  reason: string
}[] = [
  { role_prefix: 'kol.', action_id: 'stage_outreach', was: 'L2', reason: 'default_changed:wp295' },
]

/** WP295：一条分配的出厂等级迁移记录（调用方拿它记 `assignment.automation_default_migrated`）。 */
export interface AutomationDefaultMigration {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  action_id: string
  from: Level
  to: Level
}

/** WP54：一条分配的职责改名迁移记录（调用方拿它记 `assignment.role_migrated`）。 */
export interface RoleMigration {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  /** 旧职责 id。 */
  from: RoleId
  /** 新职责 id。 */
  to: RoleId
  /** 迁过去之后记下的职责版本。 */
  role_version: string
  /**
   * WP191：这一条是从哪条分配**复制**出来的（一拆几的时候，第二条及以后）。
   * 没有这一格 = 原分配就地改名。
   */
  split_from?: AssignmentId
}

/**
 * WP462：一条分配跟着职责升大版本接上的记录（调用方拿它记 `assignment.role_major_upgraded`）。
 *
 * - `reconfirmed`：原分配就地记到新版本（id 不变：待办、卡、定时、安放都跟着它）；
 * - `heir_granted`：拆分出去的那一条给同一个人补发的（`heir_of` = 原分配）。
 */
export interface RoleMajorUpgradeRecord {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  kind: 'reconfirmed' | 'heir_granted'
  /** `reconfirmed`：原来记的版本；`heir_granted`：原分配当时的职责与版本（`dtc.content@2.0.0`）。 */
  from: string
  to: string
  /** 怎么接上的：`auto` = 只收窄 / 登记过的拆分，启动时自动；`person` = 人在确认卡上点的。 */
  via: 'auto' | 'person'
  /** 登记表里那一行的 `reason`（人点的没有）。 */
  reason?: string
  heir_of?: AssignmentId
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
  /**
   * WP54：把旧职责 id（`dtc.aftersales` / `dtc.presales` / `amz.buyer-messages`）
   * 的活分配改写成新 id。幂等：没有旧 id 的库跑一遍返回空数组。
   */
  migrateRoleIds(filter?: { workspace_id?: WorkspaceId }): RoleMigration[]
  /**
   * WP191（docs/86 §6）：把**一拆几**的旧职责（`ROLE_ID_SPLITS`）的活分配迁过去：
   * 原分配就地改成第一条（id 不变），其余各复制一条。幂等：没有旧 id 的库跑一遍返回空数组；
   * 中途断过的库再跑一遍只补没做完的那一半。
   */
  splitRoleIds(filter?: { workspace_id?: WorkspaceId }): RoleMigration[]
  /**
   * WP295：出厂默认的自动化等级改过之后，把**还停在旧默认值、没人动过**的分配迁到新默认值
   * （{@link RETIRED_AUTOMATION_DEFAULTS}）。人或升降级动过的（`last_change.reason` 不是
   * `assignment_created`）一律不动。幂等：迁过的 reason 变了，再跑一遍什么也不发生。
   */
  migrateAutomationDefaults(filter?: { workspace_id?: WorkspaceId }): AutomationDefaultMigration[]
  /**
   * WP462：职责升了大版本、分配还记着旧大版本的，按 {@link ROLE_MAJOR_UPGRADES} 自动接上——
   * 只收窄权限的就地重确认；登记过的拆分再给同一个人补发拆出去的那几条（他已经有了就不补）。
   * 没登记 / 放宽权限的**不动**（界面上出确认卡，人点了走 {@link reconfirm}）。
   * 幂等：接上过的版本对上了，再跑一遍什么也不发生；补发那条的 id 由（原分配 × 职责）派生，
   * 撤掉过的也不再补。
   */
  upgradeMajors(
    filter?: { workspace_id?: WorkspaceId },
    table?: readonly RoleMajorUpgrade[],
  ): RoleMajorUpgradeRecord[]
  /**
   * WP462：人在确认卡上点了「确认」——把这条分配记到职责现在的版本。
   * 已撤销的不给确认（`conflict`）；版本本来就对得上的原样返回、不记录（`undefined`）。
   */
  reconfirm(id: AssignmentId): RoleMajorUpgradeRecord | undefined
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
  /**
   * WP215（只加）：分配建了 / 改了 / 撤了之后喊一声（同步、在写库之后）。服务端拿它即时建 / 停
   * "有人担这条职责才建"的定时——先建品牌、再分配职责的流程不用重启。回一个退订函数。
   * 可选：别的实现不用改。
   */
  onAssignmentChanged?(listener: (assignment: Assignment) => void): () => void
  policies: PolicyApi
  /** 44 G1 品牌 = 范围组。 */
  rangeGroups: RangeGroupApi
  /** 44 G2 产品线。 */
  productLines: ProductLineApi
  /** 05 §4：单个 Assignment 的有效配置，不并集。 */
  effectiveConfig(id: AssignmentId, options?: { connected?: Iterable<string> }): EffectiveConfig
  /**
   * WP462：这条分配是不是卡在「职责升了大版本、要重新确认」上（是就回出确认卡要的那几格）。
   * 列岗位 / 首页这类一次读很多条的地方先问它，一条对不上只影响那一条。可选：别的实现不用改。
   */
  staleMajor?(id: AssignmentId): RoleUpgradeNeeded | undefined
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
    // WP54：先按原样找（pack 里自带的同名定义仍然优先），找不到再走别名表。
    // 顺序反过来会让"装一份自己的 dtc.aftersales"这件事静默失效。
    get(id) {
      return roleMap.get(id) ?? roleMap.get(resolveRoleId(id))
    },
    require(id) {
      const role = roleMap.get(id) ?? roleMap.get(resolveRoleId(id))
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
  /** WP215：分配变了的订阅者（一个坏了不拖垮写库，也不拖垮别的订阅者）。 */
  const changeListeners = new Set<(assignment: Assignment) => void>()
  const notifyChanged = (assignment: Assignment): void => {
    for (const listener of changeListeners) {
      try {
        listener(assignment)
      } catch {
        // 订阅者自己的事
      }
    }
  }

  const persist = (assignment: Assignment): Assignment => {
    backend.putAssignment(assignment)
    syncPolicies(assignment)
    hydrated.add(assignment.id)
    notifyChanged(assignment)
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
      // WP138：整个品牌只能是**这个**工作区（它盖住工作区里的一切，id 写错就是越界）
      if (r.kind === 'brand' && r.id !== workspace)
        throw new RoleError(
          'invalid_input',
          `「整个品牌」只能挂本工作区（${workspace}），不能挂 ${r.id}`,
        )
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
        ...(input.created_by === undefined ? {} : { created_by: input.created_by }),
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
        ...(input.created_by === undefined ? {} : { created_by: input.created_by }),
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

  /**
   * WP462：把一条分配接到 `role` 现在的版本上，写成 id 为 `id` 的那一条。
   *
   * 留下的：人、品牌、范围、挂的品牌、授予人与授予时间、**新定义里还有的动作**的自动化等级与采纳率、
   * 额度收紧。去掉的：新定义里已经没有的动作（它们的等级与额度覆盖留着也没人读，只会让人看糊涂）。
   * 新定义里新出现的动作按出厂初始等级起步（和新建分配一样）。
   */
  const carryOver = (from: Assignment, role: RoleDefinitionFull, id: AssignmentId): Assignment => {
    const at = options.clock.now()
    const fresh = initialAutomationState(role, at)
    const automation_state: Assignment['automation_state'] = {}
    for (const actionId of Object.keys(fresh)) {
      const kept = from.automation_state[actionId]
      const base = kept ?? fresh[actionId]
      if (base !== undefined) automation_state[actionId] = structuredClone(base)
    }
    const actionIds = new Set(role.actions.map((a) => a.id))
    const overrides = Object.fromEntries(
      Object.entries(from.mandate_overrides ?? {}).filter(([k]) => actionIds.has(k)),
    )
    const next: Assignment = {
      ...structuredClone(from),
      id,
      role_id: role.id,
      role_version: role.version,
      automation_state,
    }
    if (Object.keys(overrides).length === 0) delete next.mandate_overrides
    else next.mandate_overrides = structuredClone(overrides)
    return next
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
        roles: (id) => roles.get(id),
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
      notifyChanged(revoked)
      return revoked
    },
    listByPerson(person, filter) {
      return backend.listAssignments({ ...filter, person_id: person })
    },
    listByRole(role, filter) {
      return backend.listAssignments({ ...filter, role_id: role })
    },
    /**
     * WP54：把旧职责 id 的**活**分配改写成新 id（48 v2 L1「已有分配在启动时迁移」）。
     *
     * 只改 `role_id` 与 `role_version`，别的一个字不动——范围、额度覆盖、自动化
     * 状态（含采纳率与它的起算时间）全部留着：合并不是撤销重授，人身上那条队列
     * 与它攒了几周的采纳率不该因为改个名字清零。
     *
     * 已撤销的不动（历史就是历史），新 id 的定义没加载就跳过（宁可不改也不改坏）。
     * 记事件是调用方的事：这个包不认事件日志。
     */
    migrateRoleIds(filter) {
      const out: RoleMigration[] = []
      for (const [from, to] of Object.entries(ROLE_ID_ALIASES)) {
        const role = roleMap.get(to)
        if (role === undefined) continue
        const found = backend.listAssignments({
          ...(filter?.workspace_id === undefined ? {} : { workspace_id: filter.workspace_id }),
          role_id: from,
        })
        for (const assignment of found) {
          if (assignment.revoked_at !== undefined) continue
          const next: Assignment = { ...assignment, role_id: to, role_version: role.version }
          persist(next)
          out.push({
            assignment_id: assignment.id,
            person_id: assignment.person_id,
            workspace_id: assignment.workspace_id,
            from,
            to,
            role_version: role.version,
          })
        }
      }
      return out
    },
    /**
     * WP191（docs/86 §6）：一拆几。
     *
     * **先复制、后改名**：中途断电重跑时，原分配还写着旧 id → 看到复制的那条已经在了
     * 就跳过 → 再改名。反过来的话，改完名就认不出它原来是哪条，复制的那条永远补不上。
     * 复制那条的 id 由（原分配 id × 目标职责）派生，所以"复制过没有"不需要另一张标记表。
     *
     * 复制的只有**分配本身**（范围、额度覆盖、自动化状态与采纳率）：待办、卡、队列、
     * 定时任务挂在原 id 上，留给接手的第一条——它们本来就是同一个号上的同一摊活。
     */
    splitRoleIds(filter) {
      const out: RoleMigration[] = []
      for (const [from, heirs] of Object.entries(ROLE_ID_SPLITS)) {
        const [primary, ...rest] = heirs
        if (primary === undefined) continue
        const primaryRole = roleMap.get(primary)
        const restRoles = rest.map((id) => ({ id, role: roleMap.get(id) }))
        // 新职责有一条没加载就整组跳过（宁可不改也不改坏）
        if (primaryRole === undefined || restRoles.some((r) => r.role === undefined)) continue
        const found = backend.listAssignments({
          ...(filter?.workspace_id === undefined ? {} : { workspace_id: filter.workspace_id }),
          role_id: from,
        })
        for (const assignment of found) {
          if (assignment.revoked_at !== undefined) continue
          for (const { id: to, role } of restRoles) {
            if (role === undefined) continue
            const id = mintId(canonicalJson({ split_from: assignment.id, role: to }))
            if (backend.getAssignment(id) !== undefined) continue
            persist({
              ...structuredClone(assignment),
              id,
              role_id: to,
              role_version: role.version,
            })
            out.push({
              assignment_id: id,
              person_id: assignment.person_id,
              workspace_id: assignment.workspace_id,
              from,
              to,
              role_version: role.version,
              split_from: assignment.id,
            })
          }
          persist({ ...assignment, role_id: primary, role_version: primaryRole.version })
          out.push({
            assignment_id: assignment.id,
            person_id: assignment.person_id,
            workspace_id: assignment.workspace_id,
            from,
            to: primary,
            role_version: primaryRole.version,
          })
        }
      }
      return out
    },
    migrateAutomationDefaults(filter) {
      const out: AutomationDefaultMigration[] = []
      const at = options.clock.now()
      for (const assignment of backend.listAssignments(
        filter?.workspace_id === undefined ? {} : { workspace_id: filter.workspace_id },
      )) {
        if (assignment.revoked_at !== undefined) continue
        const role = roleMap.get(assignment.role_id)
        if (role === undefined) continue
        let next: Assignment | undefined
        for (const rule of RETIRED_AUTOMATION_DEFAULTS) {
          if (!assignment.role_id.startsWith(rule.role_prefix)) continue
          const spec = role.automation[rule.action_id]
          const state = (next ?? assignment).automation_state[rule.action_id]
          // 新默认值还是旧值（定义没改）/ 不是停在旧默认值上 / 人或升降级动过：都不动
          if (spec === undefined || state === undefined || spec.initial === rule.was) continue
          if (state.level !== rule.was || state.last_change.reason !== 'assignment_created')
            continue
          next = {
            ...(next ?? assignment),
            automation_state: {
              ...(next ?? assignment).automation_state,
              [rule.action_id]: {
                ...state,
                level: spec.initial,
                last_change: { at, reason: rule.reason },
              },
            },
          }
          out.push({
            assignment_id: assignment.id,
            person_id: assignment.person_id,
            workspace_id: assignment.workspace_id,
            role_id: assignment.role_id,
            action_id: rule.action_id,
            from: rule.was,
            to: spec.initial,
          })
        }
        if (next !== undefined) persist(next)
      }
      return out
    },
    upgradeMajors(filter, table = ROLE_MAJOR_UPGRADES) {
      const out: RoleMajorUpgradeRecord[] = []
      for (const assignment of backend.listAssignments(
        filter?.workspace_id === undefined ? {} : { workspace_id: filter.workspace_id },
      )) {
        if (assignment.revoked_at !== undefined) continue
        const role = roleMap.get(assignment.role_id)
        if (role === undefined || !isStaleMajor(assignment, role)) continue
        const path = majorUpgradePath(
          role.id,
          majorOf(assignment.role_version),
          majorOf(role.version),
          table,
        )
        if (!autoUpgradable(path) || path === undefined) continue
        const heirs = heirsOf(path).map((id) => ({ id, role: roleMap.get(id) }))
        // 拆出去的那条定义没加载就整条跳过（宁可不接也不接一半：内容少了、SEO 却没补上）
        if (heirs.some((h) => h.role === undefined)) continue
        const reason = path.map((s) => s.reason).join('+')
        /*
         * **先补发、后改版本**（与 `splitRoleIds` 同一条理由）：中途断电重跑时，原分配还记着旧版本
         * → 看到补发那条已经在了就跳过 → 再改版本。反过来的话，改完版本就再也认不出它要补发什么。
         */
        for (const { id: heirId, role: heirRole } of heirs) {
          if (heirRole === undefined) continue
          const id = mintId(canonicalJson({ major_split_from: assignment.id, role: heirId }))
          if (backend.getAssignment(id) !== undefined) continue
          // 他在这个品牌里已经担着这一条（新版本里自己加的）：不补第二条
          const already = backend
            .listAssignments({
              workspace_id: assignment.workspace_id,
              person_id: assignment.person_id,
              role_id: heirId,
            })
            .some((a) => a.revoked_at === undefined)
          if (already) continue
          persist(carryOver(assignment, heirRole, id))
          out.push({
            assignment_id: id,
            person_id: assignment.person_id,
            workspace_id: assignment.workspace_id,
            role_id: heirId,
            kind: 'heir_granted',
            from: `${assignment.role_id}@${assignment.role_version}`,
            to: heirRole.version,
            via: 'auto',
            reason,
            heir_of: assignment.id,
          })
        }
        persist(carryOver(assignment, role, assignment.id))
        out.push({
          assignment_id: assignment.id,
          person_id: assignment.person_id,
          workspace_id: assignment.workspace_id,
          role_id: role.id,
          kind: 'reconfirmed',
          from: assignment.role_version,
          to: role.version,
          via: 'auto',
          reason,
        })
      }
      return out
    },
    reconfirm(id) {
      const found = assignments.require(id)
      if (found.revoked_at)
        throw new RoleError('conflict', `这条分配在 ${found.revoked_at} 撤销了，不能再确认`)
      const role = roleFor(found)
      if (found.role_version === role.version) return undefined
      persist(carryOver(found, role, found.id))
      return {
        assignment_id: found.id,
        person_id: found.person_id,
        workspace_id: found.workspace_id,
        role_id: role.id,
        kind: 'reconfirmed',
        from: found.role_version,
        to: role.version,
        via: 'person',
      }
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
    onAssignmentChanged(listener) {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
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
        ...((opts?.connected ??
          options.connectedOf?.(assignment.workspace_id) ??
          options.connected?.()) === undefined
          ? {}
          : {
              connected:
                opts?.connected ??
                options.connectedOf?.(assignment.workspace_id) ??
                options.connected?.() ??
                [],
            }),
      })
    },
    staleMajor(id) {
      const assignment = backend.getAssignment(id)
      if (assignment === undefined || assignment.revoked_at !== undefined) return undefined
      const role = roles.get(assignment.role_id)
      if (role === undefined || !isStaleMajor(assignment, role)) return undefined
      return {
        reason: 'role_major_upgraded',
        assignment_id: assignment.id,
        role_id: role.id,
        role_name: role.name.zh,
        from: assignment.role_version,
        to: role.version,
      }
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
