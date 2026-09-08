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
  Operation,
  PersonId,
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
import { compilePolicies as compilePoliciesPure, createPolicyEngine } from './policy.js'
import { applyPosition as applyPositionPure, buildAssignment } from './position.js'
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
}

export interface CreateAssignmentInput {
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  ranges?: RangeRef[]
  granted_by: PersonId
  mandate_overrides?: Record<string, Partial<Mandate>>
  /** 显式指定授予的职责版本；默认取当前已加载的版本。 */
  role_version?: string
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
  revoke(id: AssignmentId, input?: RevokeInput): Assignment
  listByPerson(person: PersonId, filter?: Omit<AssignmentFilter, 'person_id'>): Assignment[]
  listByRole(role: RoleId, filter?: Omit<AssignmentFilter, 'role_id'>): Assignment[]
}

export interface PolicyApi {
  set(policy: WorkspacePolicy): void
  get(workspaceId: WorkspaceId): WorkspacePolicy | undefined
}

export interface RoleStore {
  roles: RoleRegistry
  assignments: AssignmentApi
  policies: PolicyApi
  /** 05 §4：单个 Assignment 的有效配置，不并集。 */
  effectiveConfig(id: AssignmentId, options?: { connected?: Iterable<string> }): EffectiveConfig
  compilePolicies(id: AssignmentId): PolicyRow[]
  can(id: AssignmentId, domain: DataDomain, op: Operation, request: AccessRequest): boolean
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

  const assignments: AssignmentApi = {
    create(input) {
      const role = roles.require(input.role_id)
      if (input.role_version !== undefined && input.role_version !== role.version)
        throw new RoleError(
          'conflict',
          `role ${role.id} is loaded at ${role.version}, cannot grant ${input.role_version}`,
        )
      return persist(
        buildAssignment(
          {
            person_id: input.person_id,
            workspace_id: input.workspace_id,
            role,
            ranges: input.ranges ?? [],
            granted_by: input.granted_by,
            ...(input.mandate_overrides ? { mandate_overrides: input.mandate_overrides } : {}),
          },
          factory,
        ),
      )
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
    effectiveConfig(id, opts) {
      const assignment = assignments.require(id)
      const role = roleFor(assignment)
      return effectiveConfigPure({
        assignment,
        role,
        policy: backend.getPolicy(assignment.workspace_id),
        ...(opts?.connected ? { connected: opts.connected } : {}),
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
