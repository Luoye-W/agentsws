/** 公共类型（05 §1.1、21 §2、14 §2）。所有 id 为字符串（ULID / 前缀 id）。 */

export type Iso8601 = string
/** 允许同步或异步实现 */
export type MaybePromise<T> = T | Promise<T>
export type PersonId = string
export type WorkspaceId = string
export type AssignmentId = string
/** 36 §3 / WP15：侧栏的「岗位」= 本人持有的 Assignment；Position 是模板不是持有。 */
export type PositionId = AssignmentId
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
  | 'matter'
  | 'goal'
  | 'todo'
  | 'meeting'
  | 'meeting_record'
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

/**
 * 范围的种类（44 §3）。
 *
 * - `store`：一家独立站 / 一个店铺。Shopify Markets（多币种多语言）是店的属性，不当范围（44 G4）。
 * - `department`：部门（20 §2 的组织结构）。
 * - `account`：平台卖家账号（亚马逊的一个卖家账号）；**隐含它下面的全部市场**。
 * - `market`：账号下的一个站点。**id 约定写成 `账号id:站点`**（如 `amz_na:US`）——
 *   于是「这个市场属于哪个账号」不用另建一张表，切一刀冒号就知道（44 G4）。
 * - `product_line`：店铺 / 账号 / 市场**内部**的一个商品子集，成员由平台内判据决定
 *   （Shopify 集合 / 标签 / 供应商 / 商品类型；亚马逊 ASIN 清单 / SKU 前缀 / 品牌）。
 *   定义见 `ProductLine`（44 G2）。
 *
 * 品牌**不是**一种范围，是一组范围的名字：见 `RangeGroup`（44 G1）。
 */
export type RangeKind = 'store' | 'department' | 'account' | 'market' | 'product_line'
export interface RangeRef {
  kind: RangeKind
  id: string
}

/** `market` 的 id 分隔符（`账号id:站点`，44 G4）。 */
export const MARKET_ID_SEPARATOR = ':'

/** 把 `amz_na:US` 拆成 `{ account: 'amz_na', site: 'US' }`；不是这个形状回 undefined。 */
export function parseMarketId(id: string): { account: string; site: string } | undefined {
  const at = id.indexOf(MARKET_ID_SEPARATOR)
  if (at <= 0 || at === id.length - 1) return undefined
  return { account: id.slice(0, at), site: id.slice(at + 1) }
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
  /** 37 §4 会议对象与记录（WP23） */
  | 'meeting'

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
