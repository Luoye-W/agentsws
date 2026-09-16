/** 公共类型（05 §1.1、21 §2、14 §2）。所有 id 为字符串（ULID / 前缀 id）。 */

export type Iso8601 = string
/** 允许同步或异步实现 */
export type MaybePromise<T> = T | Promise<T>
export type PersonId = string
export type WorkspaceId = string
export type AssignmentId = string
/** 36 §3 / WP15：侧栏的「岗位」= 本人持有的 Assignment；Position 是模板不是持有。 */
export type PositionId = AssignmentId
/**
 * WP69（54 §1）：**岗位模板本身**的 id（`web-ops` / `customer-care` …）。
 *
 * 与 {@link PositionId} 是两件事，别混：`PositionId` 是"某个人持有的那一条"
 * （= Assignment），这一条是"公司里的那个岗位"。54 §1 的 `PositionInstance` 用的是
 * 这一个——一个工作区里"网站运营"只有一个，持有它的人可以有好几个。
 */
export type PositionTemplateId = string
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
  /**
   * WP52（47 J1）：下面这七类**早就在用**，只是一直靠 `(string & {})` 那道开口混进来——
   * `apps/server/src/invites.ts` 建的 `{ type: 'membership_request' }`、`join.ts` 建的
   * `{ type: 'policy', id: 'join:…' }`、47 §3 点名的 `person` / `assignment` /
   * `range_group` / `product_line`。本体登记表要按对象类型逐条登记"真源是谁、谁读得到、
   * 能对它做什么"，名字不写出来就登记不上。**只加不删**：加成员不影响任何既有判断。
   */
  | 'person'
  | 'assignment'
  | 'workspace'
  | 'range_group'
  | 'product_line'
  | 'membership_request'
  | 'policy'
  /**
   * WP63（51 §2.1 / §2.2）：店铺那一侧**早就在用**的五类。
   *
   * `ShopifyTargetType`（`packages/connect-adapter`）里 collection / page / article /
   * inventory_item 四个名字已经写了一年，只是一直靠 `(string & {})` 那道开口混进来；
   * `review` 是 WP63 新加的评价管理那一面。名字不写出来，47 J1 的登记表就登记不上
   * 「这类对象的真源是谁、谁读得到、能对它做什么」。**只加不删**。
   */
  | 'collection'
  | 'page'
  | 'article'
  | 'inventory_item'
  | 'review'
  /**
   * WP69（54 §1）：**岗位实体**。id 是岗位模板 id（`web-ops`），不是 Assignment id。
   * 事项时间线上的路由记录、岗位层上下文、岗位层记忆都指着它。
   */
  | 'position'
  /**
   * WP67（48 §5.2）：红人营销那一侧的五类（`creator` 上面早就有）。
   *
   * 为什么是五个对象而不是一个「红人」：同一个人在 YouTube 与在 Instagram 是两条
   * `platform_account`（渠道之间零共享数据，48 §5.1 末句）；联系方式单独一条才能
   * 把「明文不落库、只存加密库 key 名」写进类型里；合作与交付物各有阶段机与审批；
   * 追踪链接的数字回填自订单，真源不在红人那一侧。**只加不删**。
   */
  | 'platform_account'
  | 'creator_contact'
  | 'collaboration'
  | 'deliverable'
  | 'tracked_link'
  /**
   * WP72（56 §2）：社媒运营那一侧的三类（`social_post` 上面早就有）。
   *
   * 为什么不是一个「社媒」对象：`social_account` 是**我们自己的号**（一条渠道上
   * 可以有好几个）；`community_member` 是群里的一个人——**不是**顾客档案，
   * 认不认得出他是哪个订单的买家是客服那一侧的事（56 边界行）；
   * `community_thread` 是群里 / 评论区 / 私信里的一条线程，它带着分类结论
   * （六类，56 §3）。三类各有各的可读范围，一个域一把闸（19 §3 的过滤下推
   * 才切得动）。**只加不删**。
   */
  | 'social_account'
  | 'community_member'
  | 'community_thread'
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
  /**
   * WP67（48 §5.1）：红人营销的五个新数据域（`creator` 上面早就有）。
   *
   * 分成五个而不是塞进 `creator` 一个，是因为**可读范围不一样**：找人那一块
   * 谁都能看（`platform_account`），联系方式只有建联那一步碰得到
   * （`creator_contact`，敏感级 confidential），预算与条款是钱
   * （`collaboration`）。一个域一把闸，19 §3 的知识过滤下推才切得动。
   */
  | 'platform_account'
  | 'creator_contact'
  | 'collaboration'
  | 'deliverable'
  | 'tracked_link'
  /**
   * WP72（56 §2）：社群那两个域（账号与帖子走**早就有的** `social_account`）。
   *
   * 分出来而不是塞进 `social_account`，理由与红人那五个一样：**可读范围不一样**。
   * 内容组四条职责读得到账号与帖子，读不到群成员；客服的「社群管理」读得到
   * 线程（客户的问题在那里），读不到成员名册。一个域一把闸。
   */
  | 'community_member'
  | 'community_thread'

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
