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
/** 40 §3.1：建一条待办，撞上了怎么办。 */
export interface ScenarioWorkTodo {
  /** 谁记的（`people.yml` 里的 person id） */
  who: string
  title: string
  /** 主题对象：订单号（撞车第一把钥匙） */
  order?: string
  /** 撞上了怎么办；不给就是「先查」——撞了这一条就建不成 */
  collision?: 'join' | 'handoff' | 'force'
  /** `force` 要写的那句区别 */
  distinct_reason?: string
}

/** 40 §3.2：一条还没有主人的活。 */
export interface ScenarioWorkPool {
  title: string
  /** 从哪来（会议 / 计划 / 告警…），默认 `meeting` */
  source?: string
}

/** 40 §3.2：谁点了「我来」。按标题找那条活。 */
export interface ScenarioWorkClaim {
  who: string
  title: string
}

/** 40 §3.5：跑一次闲置回收。 */
export interface ScenarioWorkIdle {
  /** 认领后几天没动就提醒 / 回池；不给按 `@agentsws/work` 的缺省 */
  idle_days?: number
}

export type ScenarioEvent =
  | { at: string; type: 'inbound.email'; inbound: ScenarioInbound }
  | { at: string; type: 'actor.decide'; decide: ScenarioDecide }
  | { at: string; type: 'clock.advance'; advance: Record<string, never> }
  | { at: string; type: 'inject.fault'; fault: ScenarioFault }
  | { at: string; type: 'model.outage'; outage: ScenarioOutage }
  | { at: string; type: 'inject.budget'; budget: ScenarioBudget }
  /** 25：装上「一天的例行公事」（早上计划卡 / 晚上复盘卡 / 复盘后的接力）。 */
  | { at: string; type: 'routine.start'; routine: ScenarioRoutine }
  /** WP29：装上学习回路（lesson 池 + 每天 07:30 的次日提案）。 */
  | { at: string; type: 'learning.start'; learning: ScenarioLearning }
  /** WP32 soak：跑一次对账（15 §5.8 unknown 的自动对账），soak 档每天一次。 */
  | { at: string; type: 'reconcile.run'; reconcile: Record<string, never> }
  /** WP32 soak：进程"重启"——关掉事件日志的连接再开一次，验链还完整。 */
  | { at: string; type: 'process.restart'; restart: Record<string, never> }
  /** WP38：某人记一条待办（走「建之前先查」，40 §3.1）。 */
  | { at: string; type: 'work.todo'; todo: ScenarioWorkTodo }
  /** WP38：把一条活丢进待认领池（会议 / 计划 / 告警的最小替身，40 §3.2）。 */
  | { at: string; type: 'work.pool'; pool: ScenarioWorkPool }
  /** WP38：某人点「我来」（认领即锁）。 */
  | { at: string; type: 'work.claim'; claim: ScenarioWorkClaim }
  /** WP38：跑一次闲置回收巡检（40 §3.5）。 */
  | { at: string; type: 'work.idle_sweep'; idle: ScenarioWorkIdle }

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
  /** `$last_outbound_draft` / `$last_staged_change` / `$last_skill_lesson` / 具体 approval_item id。 */
  item: string
  action: 'approve' | 'approve_edited' | 'reject'
  reason?: string
  /** 选择题卡（36 §2.1）：批准必须带一个选项 id。 */
  option?: string
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

/** 25：例行公事的两个钟点（本地时区）。 */
export interface ScenarioRoutine {
  plan_hour?: number
  review_hour?: number
}

/** WP29：次日提案几点出（本地时区），缺省 07:30。 */
export interface ScenarioLearning {
  propose_hour?: number
  propose_minute?: number
}

/** 26 扩展（本包）：把模型预算压到某个值，用来跑"预算耗尽 → 熔断"。 */
export interface ScenarioBudget {
  workspace_daily_base?: number
  workspace_monthly_base?: number
  assignment_daily_base?: number
}

/**
 * WP32：这条场景要把交易控制模块的两个时限旋钮调成多少（14 §11.6 / §13.2）。
 *
 * 为什么放进场景而不是改默认：默认值就是 14 里定的那套（24 / 48 工作小时、10% 抽检），
 * 不能为了让一条回归题跑得快就把全公司的时限改了。升级链场景要在几小时内看见两级升级，
 * 就在这条场景里把它压小——**改的是配置，不是语义**。
 */
export interface ScenarioTxnPolicy {
  escalation_hours?: { scope_manager?: number; owner?: number }
  /** L2 自动批的抽检比例（0..1）。 */
  sampling_rate?: number
  /** 审批项的过期天数（`default` 或按 kind）。 */
  expiry_days?: Record<string, number>
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
  /** 25 扩展：这些类型的事件至少各出现一次（`schedule.fired` 之类）。 */
  event_types?: string[]
  /** 25 扩展：按 kind 数审批项（`daily_plan: 1`、`review: '>=1'`）。 */
  approval_kinds?: Record<string, NumericAssertion>
  /** 25 扩展：这些处理器至少各有一条定时任务（证明「接力已注册」）。 */
  scheduled_handlers?: string[]
  /**
   * WP29 扩展：最后一次运行的 prompt 里至少出现其中一条。
   * 「采纳之后下一次运行真的用了新版本」就靠它钉住。
   */
  prompt_includes_any?: string[]
  /** WP29 扩展：夜间整理被拦下的原因（`rejected_before` / `policy_layer` …）。 */
  lessons_filtered?: string[]
  /** WP29 扩展：池里 lesson 的条数。 */
  lessons_pooled?: NumericAssertion
  /** WP32 扩展：升级链上真的升到过哪几级（`scope_manager` / `owner`）。 */
  escalated_tiers?: string[]
  /** WP32 扩展：升级把卡交到了谁手上（跨岗位交接看的是**人**换了没有）。 */
  escalated_to?: string[]
  /** WP32 扩展：被抽检选中的自动批项条数。 */
  sampled?: NumericAssertion
  /** WP32 扩展：自动批（`auto_approved`）的项数——"不解锁自动执行"的反证也靠它。 */
  auto_approved?: NumericAssertion
  /** WP32 扩展：规则 judge 的分数下限（模型 judge 只报不拦，不接受断言）。 */
  judge_min_score?: number
  /**
   * WP32 扩展：这些人身上有 ≥2 个分配时，**没有任何一个分配**拿到并集权限
   * （05 §"不做跨 Assignment 并集"）。
   */
  assignments_not_unioned?: string[]
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
  /** 唯一主观键；交模型 judge（realistic 档有 key 时才真跑，只报不拦；26 §1）。 */
  rubric?: string
  /** WP32：这条场景要调的交易控制模块时限（升级 / 过期 / 抽检比例）。 */
  policy?: ScenarioTxnPolicy
  /** WP32：这条场景只在这些档跑（不写 = 每档都跑）。 */
  tiers?: Tier[]
  /** 隐藏场景集标记（31 §1 I9：不随 pack 发布）。 */
  hidden?: boolean
  /** 毒样本必配的 should-serve 对照场景 id（26 §2 / §6.2）。 */
  control_for?: string
  /** 场景文件的来源路径，解析时填。 */
  source?: string
}
