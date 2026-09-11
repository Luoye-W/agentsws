/**
 * 45 个人用 → 公司用：Join 向导里三类组织对象的对照（20 §4.2 那张表补的三行）。
 *
 * 一句话：进公司不是"把我的东西复制过去"，而是走一遍**对照 → 去重 → 老板批**。
 * 这个文件只定形状，判定在 `@agentsws/catalog`（唯一键与相似度），落地在
 * `apps/server/src/join.ts`。
 *
 * 三条纪律（45 H2 / H3 / H4）：
 *
 * 1. **一次签字**：三类对象、几十条对照全装进**一张** `join_mapping` 审批项，
 *    按类分组、每类一个"全部采纳"；不是每条一张卡。
 * 2. **凭据不跟着走**：连接要本人在向导里明确打开 {@link JoinConnectionChoice.transfer}
 *    才 `transferConnection`（40 §1 凭据归属）。默认是关的。
 * 3. **不自动合并"相似"**：`similar` 一律给人选，`same` 才建议自动合。
 */
import type { Iso8601, PersonId, RangeRef, WorkspaceId } from './common.js'
import type { ProductLine, ProductLineRule, RangeGroup } from './roles.js'

/** Join 向导要对照的三类组织对象（45 H2）。 */
export type JoinObjectKind = 'range_group' | 'product_line' | 'store_range'

export const JOIN_OBJECT_KINDS: readonly JoinObjectKind[] = [
  'range_group',
  'product_line',
  'store_range',
]

/**
 * 一条对照的结论。
 *
 * - `same`：唯一键算出来一模一样 → 合并（公司那份取并集，个人那份变别名）
 * - `similar`：唯一键不同但像（名字归一化后不同、成员重合 ≥ 50%；判据有重叠不相等）→ **给人选**
 * - `missing`：公司没有 → 在公司新建（记 `origin`）
 */
export type JoinVerdict = 'same' | 'similar' | 'missing'

/**
 * owner 在对照卡上能选的动作。
 *
 * `merge_union` / `adopt_company` / `keep_both` 就是 45 H2 那张表里"相似"那一格的
 * 三个选项（"同一个，取并集" / "以公司为准" / "保留两条"）。
 */
export type JoinResolution =
  | 'merge_union'
  | 'adopt_company'
  | 'keep_both'
  | 'create_in_company'
  | 'skip'

/** 对照卡上一侧的摘要（界面直接显示，不露原始 id 以外的东西）。 */
export interface JoinObjectSide {
  id: string
  name: string
  /** 人话摘要：品牌 = 成员；产品线 = 父范围 + 判据；店铺范围 = 平台 + 归一化 id。 */
  summary: string
  /** 几个岗位挂着它（公司那侧才有意义）。 */
  holders?: number
  /** 品牌的成员。 */
  members?: RangeRef[]
  /** 产品线的父范围与判据。 */
  parent?: RangeRef
  rule?: ProductLineRule
  /** 店铺 / 平台账号范围的平台。 */
  platform?: JoinPlatform
}

/** 店铺 / 平台账号范围认得出的平台。认不出的走 `other`（唯一键退化成原样 id）。 */
export type JoinPlatform = 'shopify' | 'amazon' | 'other'

/** 一条对照。 */
export interface JoinObjectComparison {
  kind: JoinObjectKind
  /** 唯一键（两边算出来一样 = `same`）。 */
  unique_key: string
  verdict: JoinVerdict
  /** 个人那份（导入包里的）。 */
  mine: JoinObjectSide
  /** 公司那份（`missing` 时没有）。 */
  theirs?: JoinObjectSide
  /** `similar` 时的相似度（0..1，四位小数）。 */
  similarity?: number
  /** 为什么判成这样，人话，界面直接显示。 */
  reasons: string[]
  /** 建议动作（界面上的默认选项）。 */
  suggested: JoinResolution
  /** 这一条能选哪些（`same` / `missing` 只有一两个；`similar` 给三个）。 */
  options: JoinResolution[]
  /** owner 实际选的；没改就是 `suggested`。 */
  chosen?: JoinResolution
  /** 选了"同一个"时用谁的名字。默认 `company`（45 H3 公司那份是真源）。 */
  name_choice?: 'company' | 'personal'
}

/**
 * 一条个人连接要不要交给公司（45 H2 第三条）。
 *
 * **默认 `transfer: false`**：凭据归属是 40 §1 定死的，向导里本人明确打开才走
 * `transferConnection`。这个字段就是那个开关。
 */
export interface JoinConnectionChoice {
  connection_id: string
  service: string
  /** 界面上显示的名字（"Shopify · glass-bowl"）。 */
  label: string
  transfer: boolean
  /** 公司里已经有同一个 service 的连接时提示"选主"（20 §4.2）。 */
  company_has_same_service?: boolean
}

/** 导出包里的一条店铺 / 平台账号范围。 */
export interface JoinStoreRange {
  range: RangeRef
  platform: JoinPlatform
  /** 归一化后的外部 id（Shopify 的 `myshopify` 域名 / 亚马逊的 `卖家id:站点`）。 */
  external_id: string
  name: string
  connection_id?: string
}

/**
 * 20 §5 `POST /join/export` 的产物：源工作区把三类组织对象打成一个包。
 *
 * 人、职责、客户、知识那几类 20 §4.2 本来就有，这里只补 45 要的三类——
 * 包是**只加不删**的，装配方往里塞别的键不影响这三类的对照。
 */
export interface JoinExportBundle {
  schema_version: 1
  workspace_id: WorkspaceId
  /** 导出的人（进公司以后所有 `origin.person_id` 都是他）。 */
  person_id: PersonId
  exported_at: Iso8601
  range_groups: RangeGroup[]
  product_lines: ProductLine[]
  store_ranges: JoinStoreRange[]
  /** 个人工作区里的连接；`transfer` 默认全 `false`。 */
  connections: JoinConnectionChoice[]
}

/**
 * `join_mapping` 审批项的 payload（14 §1 的种类表里本来只有名字，没有形状）。
 *
 * 一次 Join 一张卡：三类对象的对照 + 连接的交接开关，owner 一次签字。
 */
export interface JoinMappingPayload {
  join_id: string
  source_workspace_id: WorkspaceId
  target_workspace_id: WorkspaceId
  /** 谁要加入。 */
  person_id: PersonId
  /** 三类对象的对照结果（界面按 `kind` 分组）。 */
  objects: JoinObjectComparison[]
  connections: JoinConnectionChoice[]
  /** 三种结论各几条（界面上"一样 3 条 / 相似 1 条 / 没有 2 条"）。 */
  counts: Record<JoinVerdict, number>
}

/** `POST /join/:id/complete` 的回执：批完实际做了什么。 */
export interface JoinCompleteResult {
  join_id: string
  /** 合并了几条（公司那份取并集 + 个人那份 `superseded_by`）。 */
  merged: number
  /** 在公司新建了几条。 */
  created: number
  /** 保留两条的有几条。 */
  kept: number
  /** 实际交给公司的连接数（本人没打开开关的不算）。 */
  transferred_connections: number
  /** 建立的别名：个人那条 → 公司那条。 */
  aliases: { kind: JoinObjectKind; from: string; to: string }[]
  /** 有几条岗位范围因为别名被改指到公司那份（留痕 `assignment.range_expanded`）。 */
  range_rewrites: number
}

/** 45 H4 夜间扫描出的一对"这两条是同一个吗"。 */
export interface OrgDuplicatePair {
  kind: JoinObjectKind
  unique_key: string
  a: JoinObjectSide
  b: JoinObjectSide
  verdict: Exclude<JoinVerdict, 'missing'>
  similarity: number
  reasons: string[]
}
