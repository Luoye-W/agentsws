/**
 * 47 J1 本体登记表的类型。
 *
 * **登记表不是新的存储**（47 J4）：这里一个字段都不是"新记下来的事实"，全部是
 * 别处已经有的东西的索引——对象类型来自 `packages/contracts` 的 `ObjectType`，
 * 动作来自 18 的 `action-side-effects.yml` 与 roles 的 `WriteActionSpec`，
 * 风险级来自 15 的 `KIND_RISK`，可读范围来自 05 的 `PermissionScope`。
 * 于是"第二真源"（40 §1 的大忌）不会出现：登记表错了只能是生成器错了。
 */
import type {
  ActionId,
  ChangeKind,
  DataDomain,
  ObjectType,
  Range,
  RiskClass,
  RoleId,
  Sensitivity,
} from '@agentsws/contracts'

/**
 * 这类对象的真源在哪（47 §1 那一行"真源"）。
 *
 * - `platform_api`：上游平台说了算（订单、商品、客户），我们只读它的影子；
 * - `connector`：也在上游，但只能经连接器的 Action 看见（没有本地表）；
 * - `local_ledger`：我们自己的账本（审批项、变更、事项、岗位）——契约里有它的接口；
 * - `human`：人写的（事实卡、技能），会过时，靠学习回路更新。
 */
export type SourceOfTruth = 'platform_api' | 'local_ledger' | 'connector' | 'human'

/**
 * 新鲜度：`realtime` = 每次读都打真源；`cached:<秒>` = 本地影子，最多旧这么多秒；
 * `authored` = 人写的，没有"新"这回事（只有"什么时候写的"）。
 */
export type Freshness = 'realtime' | 'authored' | `cached:${number}`

export interface PropertyDef {
  name: string
  /** 契约里写的类型，原样抄（`string` / `Money` / `ObjectRef[]` …）。 */
  type: string
  /** 05 §1.1 的敏感级：决定它在回答里露不露、在界面上遮不遮。 */
  sensitivity: Sensitivity
  optional: boolean
}

export interface ObjectTypeDef {
  /** = `ObjectType`（契约 `common.ts` 的联合成员）。 */
  id: ObjectType
  /** 人话名字（界面与给模型的紧凑文本都用它，不露 id）。 */
  label: string
  /** 主键格式：`ObjectRef.id` 长什么样。 */
  key_format: string
  /** 05 §1.1 判权限用的数据域（范围规则按它汇总）。 */
  domain: DataDomain
  source_of_truth: SourceOfTruth
  freshness: Freshness
  /** 从 roles 的 scopes 汇总出来的可读范围（最宽的在前）。空 = 没有任何职责读得到它。 */
  read_ranges: Range[]
  /** 属性（有契约接口的对象才有；平台对象的属性以连接器返回为准，这里为空）。 */
  properties: PropertyDef[]
  /** 从哪查：命名查询（29）或连接器读 Action（18）的名字。 */
  read_via: string[]
  /** 生成它的契约接口名（没有接口的平台对象没有这一格）。 */
  contract?: string
}

/**
 * 链接。`direction`：
 * - `out` = `from` 这条记录里就写着对方（`order.customer_id`），顺着查一步到位；
 * - `in` = 对方记录里写着我（`customer → order[]`），要反过来按条件查。
 */
export interface LinkDef {
  from: ObjectType
  to: ObjectType
  direction: 'out' | 'in'
  cardinality: 'one' | 'many'
  /** 这条链接由哪个字段表达（`StagedChange.target`、`order_id` …）。 */
  via: string
  /** 从哪查（命名查询 / 连接器 Action / 路由）。 */
  lookup: string[]
}

export interface ActionDef {
  /** 18 的 Action id（`shopify_admin.create_refund`）或 05 的 `WriteActionSpec.id`。 */
  id: ActionId
  /** 对哪类对象。 */
  object: ObjectType
  /** 从哪来的：职责定义里的写动作，还是连接器目录里的 Action。 */
  source: 'role' | 'connector'
  /** 读还是写（18 §1 的覆盖表；未标的一律按 write）。 */
  access: 'read' | 'write'
  change_kind?: ChangeKind
  risk_class: RiskClass
  /** 15 §5：写永远经账本 → 永远要人批；读不要。 */
  requires_approval: boolean
  /** 只有职责动作有：批给谁（05 §1.4）。 */
  route_to?: string
  /** 哪些职责声明了它（只有 `source: 'role'` 有）。 */
  roles?: RoleId[]
  /**
   * 运行时把这个动作摆成哪个工具（17 §1 的产出工具）。
   * 只有两个：`stage_refund` 与 `draft_reply`——给模型看的那一行要用工具名，
   * 不能用职责定义里的动作 id，否则模型照着名字去调会调不到。
   */
  tool?: string
  /** 一句人话。 */
  what: string
}

export interface OntologyRegistry {
  /** 登记表本身的 schema 版本。 */
  version: 1
  /** 生成它的输入（相对仓库根）。改了这些文件就得重跑生成器。 */
  generated_from: string[]
  /** 输入内容的指纹：`--check` 比的是整份 JSON，这一格只是给人看"输入变了没有"。 */
  source_digest: string
  objects: ObjectTypeDef[]
  links: LinkDef[]
  actions: ActionDef[]
}

// ── 按岗位裁剪（47 J1 最后一段）────────────────────────────────────────

export interface TailoredObject {
  id: ObjectType
  label: string
  /**
   * 这条岗位对它的可读范围。**按工具面裁剪时没有这一格**——`RunRequest` 里没有
   * scopes（17 §1），编不出来的东西不如不说；范围过滤本来就在网关那一层做。
   */
  read_range?: Range
  source_of_truth: SourceOfTruth
  freshness: Freshness
  read_via: string[]
}

export interface TailoredAction {
  id: ActionId
  object: ObjectType
  label: string
  /** 运行时把它摆成哪个工具（`stage_refund` / `draft_reply`）。 */
  tool?: string
  change_kind?: ChangeKind
  risk_class: RiskClass
  requires_approval: boolean
  route_to?: string
}

/** `ontologyFor` 的产物：**给界面的 JSON**。给模型的紧凑文本由 `ontologyBrief` 渲染。 */
export interface TailoredOntology {
  assignment_id: string
  role_id: string
  objects: TailoredObject[]
  actions: TailoredAction[]
  links: LinkDef[]
}
