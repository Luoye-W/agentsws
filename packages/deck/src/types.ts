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

/**
 * 证据芯片（37 §1 第 5 行）：**只出 i18n key + 参数**，永不出裸 id。
 *
 * `params` 里只允许放已经过服务端 enrichment 的**展示名与数字**（订单号 `#1001`、
 * 引用条数），绝不放 `fact_…` / `cus_…` / `run_…` 这类 ObjectRef id——那正是 WP15
 * 截图里露出来的东西。要跳到对象的芯片走 `entity_chips`，它自带展示名。
 */
export interface DeckEvidenceChip {
  label_key: string
  params?: Record<string, string | number>
}

/**
 * 实体芯片（订单 / 客户 / 事实卡…）：另起一行，**带展示名**。
 *
 * `label` 由 api 层的 enrichment 以本人身份查出来（29 §2）；查不到（无权见 / 已删）
 * 的 ref 在投影时就被丢掉，只在 `DeckDetail.enrichment.dropped_refs` 上留个数。
 * `id` 留着只为点击时跳转，**渲染层不许把它印在卡面上**。
 */
export interface DeckEntityChip {
  type: ObjectRef['type']
  id: string
  label: string
}

/** 37 §3 筛选的第四枚 chip：这张卡是谁引出来的。 */
export type DeckSource = 'todo' | 'conversation' | 'system'

/** 内容盒一次只显示一种语言（37 §1 第 4 行，禁双语堆叠）。 */
export type DeckContentMode = 'zh_summary' | 'original' | 'en'

export interface DeckContentVariants {
  /** 永远有：Agent 写的中文摘要，也是队列默认显示的那一种 */
  zh_summary: string
  /** 客户原文（多半是英文），从 payload 的结构化字段里取，不是模型现编的 */
  original?: string
  /** 英文版摘要；没有就回退中文摘要并在卡面上说明 */
  en?: string
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
  /** 14 §2 的三档优先级，排序第三顺位要用（KefuAgent `compareInboxQueueCards`） */
  priority: ApprovalItem['priority']
  risk_class: RiskClass
  title: string
  /** = `content_variants.zh_summary`；老调用方还在读它，所以不删 */
  summary: string
  /** 37 §1 第 4 行：一次只显示一种，队列级切换 */
  content_variants: DeckContentVariants
  position_id: PositionId
  role_id: RoleId
  /** 37 §1 第 2 行：**不进标签行**；只在详情与筛选里用 */
  customer_label?: string
  channel?: 'email' | 'chat' | 'system'
  /** 37 §2.2b：卡片是指向事项的指针；有它就在卡面顶部出「属于：事项 X」 */
  matter_id?: string
  /** 卡挂在哪条待办下（37 §2.1 交点一） */
  todo_id?: string
  matter_label?: string
  source: DeckSource
  highlights: DeckHighlight[]
  evidence_chips: DeckEvidenceChip[]
  entity_chips: DeckEntityChip[]
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
  /** 同类合并后代表这一组的张数；1 = 没合并（37 §1 第 2 行的「合并 N 张」） */
  merge_count: number
  /** 合并进来的成员（含代表自己）：动作一次落到每一条，各带各的 version */
  merged?: { id: string; version: number }[]
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
  /** 37 §1 第 5 行：run id **只进详情**，不进证据芯片 */
  run_id?: string
  /** 29 §2 enrichment：以本人身份查不到展示名的 ref 丢了几条 */
  enrichment: { dropped_refs: number }
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

// ── 筛选与战报（37 §1 末段） ────────────────────────────────────────────

/** 等待态：客户此刻是不是坐在对面等（KefuAgent 的 waiting / nobody_waiting 两枚 chip）。 */
export type DeckWaiting = 'customer_waiting' | 'nobody_waiting'

export interface DeckFilters {
  position_id?: PositionId
  waiting?: DeckWaiting
  kind?: DeckKind
  source?: DeckSource
}

export interface DeckFilterResult {
  /** 过滤后的队列（已排序） */
  cards: DeckCard[]
  /** 被筛掉但仍要置顶提示的 P0（37：P0 永不被筛掉） */
  pinned_p0: DeckCard[]
  counts: {
    /** 按**张数**算（合并前），不是按组数 */
    total: number
    customer_waiting: number
    nobody_waiting: number
    matched: number
  }
}

/** 今日战报四格（37 §1 第 9 行；数从事件日志来，不估算）。 */
export interface BattleReport {
  /** 工作区本地日期 YYYY-MM-DD */
  date: string
  /** AI 自主处理：跑完且全程没回头问人的运行 */
  ai_handled: number
  /** 你已处理：本人做出的决定 */
  handled: number
  /** 自动发送：额度内自动批准、没经过人的 */
  auto_sent: number
  /** 拦截待确认：被拦下来转人确认的（= 建了卡） */
  intercepted: number
}

export interface HomeAssembly {
  queue: DeckCard[]
  alerts: DeckCard[]
  tiles: PositionTiles[]
  digest?: DeckCard
  estimated_minutes: number
  range: RangeName
}
