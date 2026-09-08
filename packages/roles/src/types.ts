/**
 * 05 §1 §2 §4 的包内类型补齐。
 *
 * 契约 `@agentsws/contracts` 的 `RoleDefinition` 只覆盖 05 §1 的"三项约束"与部分四件套，
 * 缺 `home_blocks` / `notifications` / `grounding` / `persona`（05 §1.6 §1.7 §1.8 §1）。
 * 本包在不改契约的前提下用 `RoleDefinitionFull` 扩展；需要契约改动的部分写在交付报告里。
 */
import type {
  Assignment,
  AssignmentId,
  ConnectorDependency,
  DataDomain,
  ErrorCode,
  Level,
  Mandate,
  Operation,
  PermissionScope,
  PersonId,
  Range,
  RangeRef,
  RiskClass,
  RoleDefinition,
  RoleId,
  Sensitivity,
  WorkspaceId,
  WorkspacePolicy,
  WriteActionSpec,
} from '@agentsws/contracts'

/** 05 §1.6 首页积木。 */
export interface HomeBlock {
  id: string
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
  component: string
  query: string
  default_order: number
  pinnable: boolean
  adaptive: boolean
}

/** 05 §1.7 通知路由。 */
export interface NotificationRule {
  event: string
  mode: 'immediate' | 'queue' | 'digest'
  recipients: ('role_holder' | 'scope_manager' | 'owner')[]
  escalate_after_hours?: number
  digest_schedule?: string
}

/** 05 §1.8 强制先读工具。 */
export interface GroundingRule {
  name: string
  intent_terms: string[]
  cue_terms: string[]
  tool: string
  prefetch: boolean
}

/** 契约 RoleDefinition + 05 §1 中契约尚未覆盖的四件套字段。 */
export interface RoleDefinitionFull extends RoleDefinition {
  home_blocks: HomeBlock[]
  notifications: NotificationRule[]
  grounding?: GroundingRule[]
  persona?: string
}

/** 05 §2 岗位模板：只在分配那一刻展开成一组 Assignment。 */
export interface Position {
  id: string
  version: string
  name: { zh: string; en: string }
  roles: { role: RoleId; default: boolean }[]
}

/** 按 role_id（可选按版本）解析职责定义。 */
export type RoleResolver = (id: RoleId, version?: string) => RoleDefinitionFull | undefined

/** 05 §4 actions：额度已解析，附 15 §2 的风险等级。 */
export interface EffectiveAction {
  id: string
  target: DataDomain
  kind: WriteActionSpec['kind']
  /** resolveMandate(Role → WorkspacePolicy → Assignment 收紧) 的结果 */
  mandate: Mandate
  /** 31 §3.4：medium / high 永远人审 */
  risk_class: RiskClass
  route_to: WriteActionSpec['route_to']
  requires_record_read: boolean
  protected_fields: string[]
  review_cannot_be_disabled: boolean
}

/** 05 §4 automation：当前等级（已按 ceiling 与 risk_class 收紧）。 */
export interface EffectiveAutomation {
  /** 生效等级 */
  level: Level
  /** Assignment 上记录的等级（未收紧前） */
  recorded_level: Level
  ceiling: Level
  hard_ceiling: boolean
  risk_class: RiskClass
  /** 生效等级被谁压下来的 */
  clamped_by?: 'ceiling' | 'risk_class'
}

/**
 * 05 §4（09-08 修订，31 §3.1）：**单个 Assignment 的**有效配置，不做跨 Assignment 并集。
 * 一个人多职责 = 多个 Assignment，工作项决定用哪个。
 */
export interface EffectiveConfig {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  /** 原样生效，不并集 */
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  /** required 且未连接的连接器 kind */
  missing_connectors: string[]
  actions: EffectiveAction[]
  automation: Record<string, EffectiveAutomation>
  skills: RoleDefinition['skills']
  grounding: GroundingRule[]
  persona?: string
  ranges: RangeRef[]
  home_blocks: HomeBlock[]
  notifications: NotificationRule[]
  /** required 连接器齐全 */
  ready: boolean
  /** ranges 为空且任一 scope.range == 'assigned'：拒签 token、查询返回空、界面标"未分配范围" */
  unassigned_range: boolean
}

export interface EffectiveConfigInput {
  assignment: Assignment
  role: RoleDefinitionFull
  policy?: WorkspacePolicy | undefined
  /** 调用方传入的已连接连接器 kind 集合 */
  connected?: Iterable<string>
}

/** compilePolicies 的输出行：Casbin p 规则。 */
export type PolicyRow = readonly [AssignmentId, DataDomain, Operation, Range, Sensitivity]

export interface AccessRequest {
  range: Range
  sensitivity: Sensitivity
}

export type DecisionOutcome = 'accepted' | 'edited' | 'rejected'

export interface PromotionSuggestion {
  assignment_id: AssignmentId
  action_id: string
  from: Level
  to: Level
  risk_class: RiskClass
  samples: number
  adoption_rate: number
  /** 单侧 95% 置信下界 */
  lower_bound: number
  /** Role.automation[action].promotion.adoption_rate_min */
  target: number
  reason: string
}

/** 与 28 §2 统一错误码对齐的包内错误。 */
export class RoleError extends Error {
  readonly code: ErrorCode
  readonly details: unknown
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'RoleError'
    this.code = code
    this.details = details
  }
}

/** 职责 / 岗位 YAML 校验失败：message 里带字段路径。 */
export class RoleSchemaError extends RoleError {
  /** 出错字段路径，如 `scopes[0].max_sensitivity` */
  readonly field: string
  readonly source: string
  constructor(source: string, field: string, message: string) {
    super('invalid_input', `${source}: ${field ? `${field} ` : ''}${message}`)
    this.name = 'RoleSchemaError'
    this.field = field
    this.source = source
  }
}
