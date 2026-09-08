/**
 * 场景 DSL 类型（26 §1）。
 *
 * `state + events[] + expected` 的 Commerce Agents case 形状，扩展 `clock`（虚拟时间推进）、
 * `actors`（合成人策略）、`invariants`（全程不变量）、`rubric`（唯一主观键）。
 */
import type { ChangeKind, Iso8601 } from '@agentsws/contracts'

/** 26 §4 三档。 */
export type Tier = 'fast' | 'realistic' | 'soak'

/** 全部六条不变量（26 §1）。 */
export const INVARIANT_NAMES = [
  'no_write_without_stage',
  'apply_only_after_approved',
  'provenance_respected',
  'fencing_covers_external',
  'prompt_replayable',
  'freeze_on_model_outage',
] as const
export type InvariantName = (typeof INVARIANT_NAMES)[number]

export interface ScenarioDataset {
  pack: string
  seed: number
}

/** 合成人策略：`always_approve` / `edit_Npct` / `reject_rules` / `slow`（26 §3）。 */
export interface ScenarioActor {
  /** `always_approve` | `edit_30pct` | `reject` */
  policy: string
  /** `'2h..8h'` / `'0m'`；不给就当场决定。 */
  latency?: string
  reject_rules?: string[]
  lane?: 'mine' | 'scope' | 'unclaimed'
}

export interface ScenarioStandIns {
  provider: 'mock_open_connector'
  model: 'stub' | 'replay' | 'real'
  clock: 'virtual'
  delivery: 'inbox'
}

/** `at` 是相对开钟时刻的偏移（`+65m` / `+1d`）或绝对 ISO-8601。 */
export type ScenarioEvent =
  | { at: string; type: 'inbound.email'; inbound: ScenarioInbound }
  | { at: string; type: 'actor.decide'; decide: ScenarioDecide }
  | { at: string; type: 'clock.advance'; advance: Record<string, never> }
  | { at: string; type: 'inject.fault'; fault: ScenarioFault }
  | { at: string; type: 'model.outage'; outage: ScenarioOutage }
  | { at: string; type: 'inject.budget'; budget: ScenarioBudget }

export interface ScenarioInbound {
  from: string
  /** `new` 或 `$thread`（沿用上一条线程）或线程外部 id。 */
  thread: string
  subject?: string
  /** pack 内相对路径（`fixtures/anna-return.txt`）；与 `body` 二选一。 */
  body_ref?: string
  body?: string
  message_id?: string
}

export interface ScenarioDecide {
  who: string
  /** `$last_outbound_draft` / `$last_staged_change` / 具体 approval_item id。 */
  item: string
  action: 'approve' | 'approve_edited' | 'reject'
  reason?: string
}

export interface ScenarioFault {
  action: string
  code: 429 | 500 | 'timeout'
  times: number
}

export interface ScenarioOutage {
  /** `2h` / `30m`；缺省 1h。 */
  duration?: string
}

/** 26 扩展（本包）：把模型预算压到某个值，用来跑"预算耗尽 → 熔断"。 */
export interface ScenarioBudget {
  workspace_daily_base?: number
  workspace_monthly_base?: number
  assignment_daily_base?: number
}

/** 数值断言：裸数字 = 相等；字符串支持 `>=x` `<=x` `>x` `<x` `==x`。 */
export type NumericAssertion = number | string

export interface ScenarioApprovalItems {
  kind: string
  count?: NumericAssertion
  /** 子项的 kind 列表（父子结构，14 §12）。 */
  children?: string[]
}

export interface ScenarioExpected {
  calls_tool?: string[]
  first_tool?: string
  never_calls?: string[]
  staged_change_kinds?: ChangeKind[]
  /** `$approve` = 第一条 `approval.decided`；断言此前没有 `change.applied`。 */
  no_applied_changes_before?: string
  approval_items?: ScenarioApprovalItems
  reply_omits?: string[]
  reply_includes_any?: string[]
  memory_contains?: string[]
  max_tool_calls?: number
  metrics?: Record<string, NumericAssertion>
  /** 26 扩展：本次模拟里 `run.failed` 的错误码集合（冻结 / 熔断场景）。 */
  run_failed_codes?: string[]
  /** 26 扩展：收到通知的人（owner 熔断通知）。 */
  notifications_to?: string[]
  /** 26 扩展：被门禁挡下的规则（`authorization_check` 等），毒样本场景断言用。 */
  blocked_rules?: string[]
}

export interface Scenario {
  id: string
  version: 1
  dataset: ScenarioDataset
  actors: Record<string, ScenarioActor>
  stand_ins: ScenarioStandIns
  clock: { start: Iso8601 }
  events: ScenarioEvent[]
  expected: ScenarioExpected
  invariants: InvariantName[]
  /** 唯一主观键；v1 不跑 judge，报告里记 skipped（26 §1）。 */
  rubric?: string
  /** 隐藏场景集标记（31 §1 I9：不随 pack 发布）。 */
  hidden?: boolean
  /** 毒样本必配的 should-serve 对照场景 id（26 §2 / §6.2）。 */
  control_for?: string
  /** 场景文件的来源路径，解析时填。 */
  source?: string
}
