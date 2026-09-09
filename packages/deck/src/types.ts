/**
 * 36 §2.3 卡片对象 + 29 §1 积木对象的展示层类型。
 *
 * 纪律：这一层**只投影，不发明**。金额、日期、id 一律来自 `ApprovalItem` 的结构化字段
 * （14 §2「数字不经模型手」）；模型写的只有 `title` / `summary` 两行人话。
 */
import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  AssignmentId,
  Iso8601,
  ObjectRef,
  RiskClass,
  RoleId,
} from '@agentsws/contracts'

/**
 * 岗位 id。
 *
 * 36 §3 侧栏里的「岗位」= 一个人对某个职责在某个范围上的持有，也就是一条 `Assignment`
 * （契约里没有单独的 PositionId；`Position` 是模板，不是持有）。因此 `position_id` 就是
 * `assignment_id`——这样 `X-Assignment` 头与岗位页天然一一对应，也不会出现跨 Assignment 并集。
 */
export type PositionId = AssignmentId

/** 36 §2.2：14 种审批项 + 两种系统卡。 */
export type DeckKind = ApprovalKind | 'system_alert' | 'digest'

/** 36 §2.1 五动作矩阵，没有第六个。 */
export type DeckAction = 'approve' | 'reject' | 'instruct' | 'snooze' | 'open'

export type PriorityBand = 'P0' | 'P1' | 'P2' | 'P3'

export type HighlightType = 'amount' | 'deadline' | 'commitment' | 'risk_term' | 'order_ref'

export interface DeckHighlight {
  type: HighlightType
  text: string
}

/** 证据芯片：只出 i18n key，不出裸枚举（36 §2.1）。 */
export interface DeckEvidenceChip {
  label_key: string
  /** 出处：点开跳到那个对象 */
  ref?: ObjectRef
}

export interface DeckOption {
  id: string
  label: string
}

/** 36 §2.3 DeckCard —— 六端同一份（建议进契约 #15，见交付报告）。 */
export interface DeckCard {
  id: string
  kind: DeckKind
  status: ApprovalState
  /** 由 risk_class + expires_at + 14 §8 排序算出 */
  priority_band: PriorityBand
  risk_class: RiskClass
  title: string
  summary: string
  position_id: PositionId
  role_id: RoleId
  customer_label?: string
  channel?: 'email' | 'chat' | 'system'
  highlights: DeckHighlight[]
  evidence_chips: DeckEvidenceChip[]
  available_actions: DeckAction[]
  /** 服务端给动词（outbound_draft 是「发送」而不是「批准」） */
  action_labels?: Partial<Record<DeckAction, string>>
  /** 选择题卡才有 */
  options?: DeckOption[]
  detail: DeckDetail
  dedupe_key: string
  expires_at?: Iso8601
  snoozed_until?: Iso8601
  snooze_count: number
  /** 乐观并发：decide 带 version（= ApprovalItem.revision） */
  version: number
}

/** 按 kind 的详情 payload；结构化字段原样带出，前端只渲染。 */
export interface DeckDetail {
  payload: unknown
  precheck: ApprovalItem['evidence']['precheck']
  diff?: ApprovalItem['evidence']['diff']
  citations: { fact_card_id: string; quote: string }[]
  links: ApprovalItem['links']
  created_at: Iso8601
  updated_at: Iso8601
  /** 提议者（人 / Agent / 哨兵），界面上一行小字 */
  proposer: ApprovalItem['proposer']
}

export interface ProjectContext {
  now: Iso8601
  position_id: PositionId
  /** ObjectRef → 人话（服务端补；前端不猜、也不查库） */
  label?: (ref: ObjectRef) => string | undefined
  /** 15 §2 的 risk_class 在账本上；投影时由宿主给，缺省按 kind 推 */
  riskClass?: (item: ApprovalItem) => RiskClass | undefined
  /** 契约的 ApprovalItem 没有 snooze 计数器（见交付报告的契约建议） */
  snoozeCount?: (item: ApprovalItem) => number
}

// ── 29 积木 / 数字块 ───────────────────────────────────────────────────

export type RangeName = 'yesterday' | 'last_7d'
export type TileFormat = 'money' | 'count' | 'percent' | 'ratio'

/** 数据源（36 §3：面板 Tab 按数据源分块）。 */
export type DataSourceId = 'shop' | 'approvals' | 'ga4' | 'gsc' | 'ads' | 'csat'

export interface DataSourceStatus {
  id: DataSourceId
  label: string
  connected: boolean
  /** 「查看完整报告 →」外链到对应后台 */
  report_url?: string
}

export interface TileSpec {
  id: string
  label: string
  /** 命名查询名（29 §1 NamedQuery.name） */
  query: string
  format: TileFormat
  range_default: RangeName
}

/** 首页核心数据条里的一个数字块：值、环比、迷你走势（36 §3，不放图表不放表格）。 */
export interface StatTile {
  id: string
  label: string
  format: TileFormat
  source: DataSourceId
  status: 'ok' | 'not_connected'
  range: RangeName
  value?: number
  currency?: string
  previous?: number
  delta_pct?: number
  direction?: 'up' | 'down' | 'flat'
  /** 迷你走势：按天分桶，长度固定 7 */
  spark: number[]
}

export interface PositionTiles {
  position_id: PositionId
  role_id: RoleId
  role_name: string
  range: RangeName
  tiles: StatTile[]
}

// ── 命名查询 ───────────────────────────────────────────────────────────

export interface OrderRow {
  id: string
  name: string
  email: string
  currency: string
  created_at: Iso8601
  delivered_at?: Iso8601
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
}

/** 记录 Tab 的一行（29 role_view 的 timeline 积木）。 */
export interface RecordRow {
  id: string
  at: Iso8601
  kind: string
  title: string
  summary: string
  state: string
  ref?: ObjectRef
}

export interface QueryContext {
  now: Iso8601
  /** 工作区时区偏移（分钟），日界线按它切 */
  tz_offset_minutes: number
  base_currency: string
  role_id: RoleId
  position_id: PositionId
  orders: OrderRow[]
  approvals: ApprovalItem[]
  sources: DataSourceStatus[]
}

export interface ScalarResult {
  value: number
  previous: number
  delta_pct?: number
  spark: number[]
  currency?: string
}

export interface TableResult {
  columns: { key: string; label: string; align?: 'left' | 'right' }[]
  rows: Record<string, string | number>[]
}

export interface SeriesResult {
  x: string[]
  series: { key: string; label: string; points: number[] }[]
  currency?: string
}

export interface RecordsResult {
  rows: RecordRow[]
}

export type QueryData = ScalarResult | TableResult | SeriesResult | RecordsResult

export type QueryResult =
  | { status: 'ok'; source: DataSourceId; data: QueryData }
  | { status: 'not_connected'; source: DataSourceId }

// ── 积木与面板 ─────────────────────────────────────────────────────────

/** 29 §1 组件注册表里允许的组件名（未注册的一律拒）。 */
export type ComponentName = 'stat_tile' | 'table' | 'chart_line' | 'timeline' | 'kv' | 'markdown'

export interface BlockDef {
  id: string
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
  component: ComponentName
  title: string
  query: string
  source: DataSourceId
  /** 面板块里的「查看完整报告 →」 */
  report_url?: string
}

export interface BlockData {
  block: BlockDef
  range: RangeName
  status: 'ok' | 'not_connected'
  payload?: QueryData
}

export interface ViewSection {
  source: DataSourceId
  label: string
  connected: boolean
  report_url?: string
  blocks: BlockDef[]
}

// ── decide ─────────────────────────────────────────────────────────────

export type InstructionScope = 'single_reply' | 'similar_cases' | 'global_rule'

export interface DeckInstruction {
  scope: InstructionScope
  text: string
}

export interface DeckDecideInput {
  action: DeckAction
  /** 选择题卡必填 */
  selected_option_id?: string
  instruction?: DeckInstruction
  reason?: string
  edited_payload?: unknown
  defer_until?: Iso8601
  /** 乐观并发；与 card.version 不一致即 conflict */
  version?: number
}

/** 翻译成 14 §4 的 Decision（`instruct` 不是 14 的动作，见 decide.ts 的说明）。 */
export interface ResolvedDecision {
  action: 'approve' | 'approve_edited' | 'reject' | 'defer'
  reason?: string
  edited_payload?: unknown
  defer_until?: Iso8601
  instruction_scope?: InstructionScope
}

export interface HomeAssembly {
  queue: DeckCard[]
  alerts: DeckCard[]
  tiles: PositionTiles[]
  digest?: DeckCard
  estimated_minutes: number
  range: RangeName
}
