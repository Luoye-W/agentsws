import type { AssignmentId, DataDomain, Iso8601, Level, Operation, PersonId, Range, RangeRef, RoleId, Sensitivity, WorkspaceId } from './common.js'

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
  id: string
  target: DataDomain
  kind: 'staged_change' | 'outbound_message' | 'publish' | 'config_change'
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

export interface RoleDefinition {
  id: RoleId
  version: string
  domain: 'dtc' | 'amz' | 'social' | 'kol' | 'ads' | 'design' | 'dev' | 'common'
  name: { zh: string; en: string }
  description: string
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  actions: WriteActionSpec[]
  automation: Record<string, AutomationSpec>
  skills: { name: string; min_version?: string; tier: 'open' | 'premium'; load: 'always' | 'on_demand' }[]
  handover: { transfers: ('open_work_items' | 'context' | 'home_blocks' | 'queue_lane' | 'scheduled_tasks')[]; fallback: 'owner' | 'scope_manager'; revoke_context_on_removal: boolean }
  requires?: RoleId[]
}

export interface Assignment {
  id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  ranges: RangeRef[]
  mandate_overrides?: Partial<Mandate>
  automation_state: Record<string, { level: Level; adoption: { accepted: number; edited: number; rejected: number; since: Iso8601 }; last_change: { at: Iso8601; reason: string } }>
  granted_by: PersonId
  granted_at: Iso8601
  revoked_at?: Iso8601
  handover_to?: PersonId
}

export interface WorkspacePolicy {
  workspace_id: WorkspaceId
  mandates: Record<string, Partial<Mandate>>
  global_caps: Record<string, number>
  sensitivity_overrides?: Record<string, Sensitivity>
  separation_of_duties?: string[]
}
