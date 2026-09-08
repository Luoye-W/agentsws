/** 公共类型（05 §1.1、21 §2、14 §2）。所有 id 为字符串（ULID / 前缀 id）。 */

export type Iso8601 = string
/** 允许同步或异步实现 */
export type MaybePromise<T> = T | Promise<T>
export type PersonId = string
export type WorkspaceId = string
export type AssignmentId = string
export type RoleId = string
export type RunId = string
export type EventId = string

export type ObjectType =
  | 'customer'
  | 'contact'
  | 'company'
  | 'thread'
  | 'message'
  | 'order'
  | 'shipment'
  | 'product'
  | 'variant'
  | 'discount'
  | 'campaign'
  | 'creator'
  | 'work_item'
  | 'fact_card'
  | 'skill'
  | 'package'
  | 'approval_item'
  | 'staged_change'
  | 'scheduled_task'
  | 'workflow_instance'
  | 'theme'
  | 'repo_pr'
  | 'ad_set'
  | 'social_post'
  | 'email_campaign'
  | 'store_config'
  | 'connection'
  | (string & {})

export interface ObjectRef {
  type: ObjectType
  id: string
}

export type RangeKind = 'store' | 'department' | 'account' | 'market'
export interface RangeRef {
  kind: RangeKind
  id: string
}

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'
export const SENSITIVITY_ORDER: readonly Sensitivity[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
]

export type DataDomain =
  | 'customer'
  | 'order'
  | 'shipment'
  | 'product'
  | 'inventory'
  | 'store_config'
  | 'content'
  | 'discount'
  | 'campaign'
  | 'analytics'
  | 'asset'
  | 'knowledge'
  | 'creator'
  | 'ad_account'
  | 'social_account'
  | 'review'
  | 'finance'
  | 'approval'
  | 'skill'
  | 'policy'
  | 'event_log'

export type Operation = 'read' | 'stage' | 'approve' | 'agent_auto'
export type Range = 'own' | 'assigned' | 'workspace'
export type Level = 'L1' | 'L2' | 'L3'
export type RiskClass = 'low' | 'medium' | 'high'

/** 统一错误码（28 §2）；跨模块复用，不许各模块自造同义码。 */
export type ErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'sod_violation'
  | 'not_approved'
  | 'stale_record'
  | 'snapshot_mismatch'
  | 'budget_exhausted'
  | 'connection_not_allowed'
  | 'halted'
  | 'invalid_input'
  | 'conflict'
  | 'idempotency_conflict'
  | 'policy_tightened'
  | 'authorization_check_failed'
  | 'provenance_missing'
  | 'unknown_outcome'
  | 'provider_unavailable'
  | 'residency_blocked'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'unauthenticated'
  | 'not_implemented'
  | 'internal'

export interface AppError {
  code: ErrorCode
  message: string
  details?: unknown
  trace_id?: string
}

export interface Money {
  amount: number
  currency: string
  amount_base: number
  base_currency: string
  fx_rate: number
  fx_at: Iso8601
}
