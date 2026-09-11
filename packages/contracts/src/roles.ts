import type { ChangeKind } from './changes.js'
import type {
  AssignmentId,
  DataDomain,
  Iso8601,
  Level,
  Operation,
  PersonId,
  Range,
  RangeRef,
  RiskClass,
  RoleId,
  Sensitivity,
  WorkspaceId,
} from './common.js'
import type { GroundingRule } from './run.js'

/** 动作 id（WriteActionSpec.id），如 'stage_refund' */
export type ActionId = string

/** 范围组 id（`rg_*`）。 */
export type RangeGroupId = string
/** 产品线 id（`pl_*`）。 */
export type ProductLineId = string

/**
 * 44 G1 品牌 = 范围组：**一组范围的名字**，不是一种新的范围种类。
 *
 * 岗位可以挂"品牌乙"这个组；判权限时展开成成员（`Assignment.ranges` 里存的是展开后的，
 * `Assignment.range_groups` 记住来源）。品牌新开一家店 → 把店加进组 → 挂了这个组的
 * 岗位自动多这家店，并记一条 `assignment.range_expanded`（44 G5）。
 */
export interface RangeGroup {
  id: RangeGroupId
  workspace_id: WorkspaceId
  name: string
  members: RangeRef[]
  created_at: Iso8601
  updated_at: Iso8601
}

/** Shopify 的产品线判据：这四个字段 Admin GraphQL 都能 `query:` 直接过滤（44 §3 G2）。 */
export interface ShopifyLineRule {
  platform: 'shopify'
  collection_ids?: string[]
  tags?: string[]
  vendors?: string[]
  product_types?: string[]
}

/** 亚马逊的产品线判据（SP-API 报表能按 ASIN 过滤；订单要在本地按行项目切）。 */
export interface AmazonLineRule {
  platform: 'amazon'
  asins?: string[]
  sku_prefixes?: string[]
  brand?: string
}

/** 手填一份商品清单——平台不给判据、或者就是想按人头切的时候用。 */
export interface ManualLineRule {
  platform: 'manual'
  product_ids: string[]
}

export type ProductLineRule = ShopifyLineRule | AmazonLineRule | ManualLineRule

/**
 * 44 G2 产品线 = 新范围种类 `product_line` 的定义。
 *
 * `parent` 是它切在哪一层（一家店 / 一个平台账号 / 账号下的一个市场）；
 * `rule` 是平台内的判据。判定发生在两处：拉数据时（能下推的下推，不能的本地按行项目切）、
 * 写动作时（目标商品必须落在成员里，否则 `target_in_range` 拒）。
 */
export interface ProductLine {
  id: ProductLineId
  workspace_id: WorkspaceId
  name: string
  /** 只允许 `store` / `account` / `market` 三种（产品线切在它们**里面**）。 */
  parent: RangeRef
  rule: ProductLineRule
  created_at: Iso8601
  updated_at: Iso8601
}

/** 05 §1.1。09-08 修正：不做跨 Assignment 并集，每次运行绑定一个 Assignment，其 scopes 原样生效。 */
export interface PermissionScope {
  domain: DataDomain
  ops: Operation[]
  range: Range
  max_sensitivity: Sensitivity
}

/** 05 §1.3 额度。Role 默认 → WorkspacePolicy 覆盖 → Assignment 只能更紧。 */
export interface Mandate {
  caps: Record<string, number | string | boolean | string[]>
  per_change_limits?: { max_items?: number; no_repeat_target_field?: boolean }
  window?: { max_count: number; per: 'day' | 'week' }
}

export interface AutomationSpec {
  ceiling: Level
  initial: Level
  hard_ceiling?: boolean
  /** 09-08：采纳率只是体验指标，不解锁自动执行；此处保留统计口径 */
  promotion: { adoption_rate_min: number; window_weeks: number; min_samples: number }
  demotion_triggers: ('customer_complaint' | 'guardrail_hit' | 'manual')[]
}

export interface WriteActionSpec {
  id: ActionId
  target: DataDomain
  kind: 'staged_change' | 'outbound_message' | 'publish' | 'config_change'
  /** 09-09（WP3）：显式映射到 15 §2 的变更种类与风险等级，不靠命名前缀猜 */
  change_kind?: ChangeKind
  risk_class?: RiskClass
  mandate: Mandate
  requires_record_read?: boolean
  protected_fields?: string[]
  review_cannot_be_disabled?: boolean
  route_to: 'role_holder' | 'scope_manager' | 'owner' | { role: RoleId }
}

export interface ConnectorDependency {
  kind: string
  required: boolean
  grants: string[]
  ownership: 'workspace' | 'person'
}

/** 05 §1.6 首页积木引用（组件与查询按名引用注册表） */
export interface HomeBlockSpec {
  id: string
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
  component: string
  query: string
  default_order: number
  pinnable: boolean
  adaptive: boolean
  /** 36 §3：focus 块限 stat_tile，数字块要知道怎么格式化与默认时间窗 */
  format?: 'money' | 'count' | 'percent' | 'ratio'
  range_default?: 'yesterday' | 'last_7d'
}

/** 05 §1.7 通知路由 */
export interface NotificationRule {
  event: string
  mode: 'immediate' | 'queue' | 'digest'
  recipients: ('role_holder' | 'scope_manager' | 'owner')[]
  escalate_after_hours?: number
  digest_schedule?: string
}

export interface RoleDefinition {
  id: RoleId
  version: string
  domain: 'dtc' | 'amz' | 'social' | 'kol' | 'ads' | 'design' | 'dev' | 'common'
  name: { zh: string; en: string }
  description: string
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  actions: WriteActionSpec[]
  automation: Record<ActionId, AutomationSpec>
  skills: {
    name: string
    min_version?: string
    tier: 'open' | 'premium'
    load: 'always' | 'on_demand'
  }[]
  home_blocks: HomeBlockSpec[]
  notifications: NotificationRule[]
  grounding?: GroundingRule[]
  persona?: string
  handover: {
    transfers: ('open_work_items' | 'context' | 'home_blocks' | 'queue_lane' | 'scheduled_tasks')[]
    fallback: 'owner' | 'scope_manager'
    revoke_context_on_removal: boolean
  }
  requires?: RoleId[]
}

export interface Assignment {
  id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  /** **展开后**的范围（挂的范围组已经摊平进来了）；判权限只看这一份。 */
  ranges: RangeRef[]
  /**
   * 44 G1：这条分配挂了哪几个范围组（品牌）。`ranges` 里由它们展开出来的成员随组变；
   * 组成员一变就重算，并记一条 `assignment.range_expanded`（44 G5）。
   */
  range_groups?: RangeGroupId[]
  /** 按动作收紧（09-09 改：额度按动作索引，不能一份 override 套全部动作） */
  mandate_overrides?: Record<ActionId, Partial<Mandate>>
  automation_state: Record<
    ActionId,
    {
      level: Level
      adoption: { accepted: number; edited: number; rejected: number; since: Iso8601 }
      last_change: { at: Iso8601; reason: string }
    }
  >
  granted_by: PersonId
  granted_at: Iso8601
  revoked_at?: Iso8601
  handover_to?: PersonId | 'owner' | 'scope_manager'
}

export interface WorkspacePolicy {
  workspace_id: WorkspaceId
  mandates: Record<ActionId, Partial<Mandate>>
  global_caps: Record<string, number>
  sensitivity_overrides?: Record<string, Sensitivity>
  separation_of_duties?: ActionId[]
  /**
   * 18 §2.1 受控原始材料区保留多少天（缺省 90）。
   *
   * WP34 先把它塞在 `global_caps.raw_retention_days` 里——但 `global_caps` 是**额度**
   * （15 §3.1「可松可紧」的那一组数），保留期不是额度。WP35 给它一个显式字段；
   * 读的一侧先看这里，没有再回落 `global_caps.raw_retention_days`，最后才是默认值。
   */
  raw_retention_days?: number
}

/** 05 §2 岗位模板：只在分配那一刻展开成一组 Assignment */
export interface Position {
  id: string
  version: string
  name: { zh: string; en: string }
  roles: { role: RoleId; default: boolean }[]
}

/** 05 §4 有效配置（单个 Assignment，不并集） */
export interface EffectiveAction {
  id: ActionId
  target: DataDomain
  kind: WriteActionSpec['kind']
  /** 15 §2 变更种类（显式映射优先，其次由动作 id 推导） */
  change_kind?: ChangeKind
  mandate: Mandate
  risk_class: RiskClass
  route_to: WriteActionSpec['route_to']
  requires_record_read: boolean
  protected_fields: string[]
  review_cannot_be_disabled: boolean
}
export interface EffectiveAutomation {
  level: Level
  recorded_level: Level
  ceiling: Level
  hard_ceiling: boolean
  risk_class: RiskClass
  clamped_by?: 'ceiling' | 'risk_class'
}
export interface EffectiveConfig {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  missing_connectors: string[]
  actions: EffectiveAction[]
  automation: Record<ActionId, EffectiveAutomation>
  skills: RoleDefinition['skills']
  grounding: GroundingRule[]
  persona?: string
  /** 展开后的范围（挂的范围组已摊平）。 */
  ranges: RangeRef[]
  /** 44 G1：这些范围是从哪几个范围组（品牌）来的。 */
  range_groups?: RangeGroupId[]
  home_blocks: HomeBlockSpec[]
  notifications: NotificationRule[]
  ready: boolean
  unassigned_range: boolean
}
